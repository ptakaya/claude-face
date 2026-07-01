/**
 * brain.mjs — the Claude session behind Claude Face (the "brain", which is simply Claude).
 *
 * Two backends, chosen by BRAIN_BACKEND:
 *   'mock' (DEFAULT) — a deterministic canned reply, streamed sentence-by-sentence. Zero
 *           network, zero subscription usage. Lets the whole up-leg + dots + streaming be
 *           tested and reviewed without burning usage or waiting on latency.
 *   'cli'  — the PROVEN path: spawn `claude -p` headless on the Max plan (free, no API
 *           key), resume one logical session across turns via --resume, and stream her
 *           reply as partial text. The de-risk spike (2026-06-25) proved headless-on-Max,
 *           session resume, and workspace-CLAUDE.md auto-load.
 *
 * Emits RAW sentences via onSentence(text); the relay applies cleanForTts() + broadcasts the
 * existing {type:"say"} frame, so her mouth (HeadTTS + visemes) is reused 100% untouched.
 *
 * FULL-POWER POSTURE (deliberate — this is the full Claude instance, with a talking head on it):
 *   - The FULL built-in toolset is available (Bash, Edit, Write, Read, Task, …) — no `--tools` cap —
 *     so she does real work exactly like the terminal. (BRAIN_TOOLS="Read Grep" narrows it again;
 *     BRAIN_TOOLS="" disables all tools, if a read-only face is ever wanted.)
 *   - MCP servers LOAD (no `--strict-mcp-config`), so Gmail/Calendar/etc. are present like the terminal.
 *   - `--permission-mode bypassPermissions` — full auto, no confirm gate. This MATCHES the global
 *     ~/.claude/settings.json (defaultMode: bypassPermissions): no riskier than his everyday terminal.
 *   - The door is locked by a real per-install bridge token (see relay.mjs), NOT by crippling her.
 *   - ANTHROPIC_API_KEY/AUTH_TOKEN are stripped from the child env so the free Max subscription
 *     auth is never silently overridden by a metered API key.
 * All dials are env-overridable.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Default working directory: BRAIN_CWD if the operator sets it, otherwise this checkout's
// root (the release dir). No personal fallback — the cwd is never a machine-specific path.
const REPO_ROOT       = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CWD     = process.env.BRAIN_CWD     || REPO_ROOT;
const DEFAULT_MODEL   = process.env.BRAIN_MODEL   || "sonnet"; // the snappiness dial; flip to opus etc.
const DEFAULT_EFFORT  = process.env.BRAIN_EFFORT  || "";       // reasoning effort (low|medium|high|xhigh|max); "" = CLI default, set live via /effort
const DEFAULT_BACKEND = process.env.BRAIN_BACKEND || "mock";   // safe default — opt into real usage with =cli
const DEFAULT_TOOLS   = process.env.BRAIN_TOOLS === undefined ? undefined : process.env.BRAIN_TOOLS.trim(); // undefined = FULL tools; "" = none; "Read Grep" = narrowed
const TIMEOUT_MS      = +(process.env.BRAIN_TIMEOUT_MS || 600000); // watchdog: a real work-turn (read/edit/push) can take minutes, so 10 min by default
const CONTEXT_WINDOW  = +(process.env.BRAIN_CONTEXT_WINDOW || 200000); // status-bar denominator fallback; the real window is read per-turn from the result event's modelUsage

// Keep her replies short + speakable. cleanForTts() is the safety net; this is the nudge.
const FACE_SYSTEM = process.env.BRAIN_FACE_PROMPT ||
  "You are speaking aloud through a live voice-and-face interface, not a text chat. " +
  "Keep what you SAY OUT LOUD short and conversational — a sentence or three, in plain spoken English. " +
  "Do not use markdown, bullet lists, headings, code blocks, tables, or emoji; they are read aloud literally and sound wrong. " +
  "You have your full tools — do real work when asked (read and edit files, run commands, push, mail, calendar), " +
  "and when asked to pick up a past thread, read the session memory first, then carry on. Just keep your spoken words brief.";

// Sentence boundary detector for streaming text. Guards against false splits on decimals
// ($3.50, 1.5), version numbers, and common abbreviations (p.m., Dr.), and never flushes a
// terminator sitting at the very end of the buffer (it may be a mid-token "." — wait for more).
const ABBREV_TAIL = /(?:\bmr|\bmrs|\bms|\bdr|\bprof|\bsr|\bjr|\bst|\bvs|\betc|\bvol|\bno|\bfig|\ba\.m|\bp\.m|\be\.g|\bi\.e)$/i;
export function drainSentences(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c !== "." && c !== "!" && c !== "?" && c !== "…") continue;
    // absorb trailing terminators / closing quotes / brackets into the boundary
    let end = i;
    while (end + 1 < buf.length && /[.!?…"')\]]/.test(buf[end + 1])) end++;
    const after = buf[end + 1];
    if (after === undefined) break;                                   // at buffer end — wait for the next delta
    if (!/\s/.test(after)) continue;                                  // not a real boundary (e.g. "3.5", "p.m" internal)
    if (c === "." && /\d/.test(buf[i - 1] || "") && /\d/.test(buf[i + 1] || "")) continue; // decimal/version
    if (c === "." && ABBREV_TAIL.test(buf.slice(start, i))) continue; // known abbreviation
    const s = buf.slice(start, end + 1).trim();
    if (s) out.push(s);
    let ns = end + 1;
    while (ns < buf.length && /\s/.test(buf[ns])) ns++;               // skip whitespace to next sentence
    start = ns;
    i = ns - 1;
  }
  return { sentences: out, remainder: buf.slice(start) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBrain(opts = {}) {
  const backend = opts.backend || DEFAULT_BACKEND;
  let   model   = opts.model   || DEFAULT_MODEL; // let, not const — /model swaps it live (takes effect next turn)
  let   effort  = opts.effort  || DEFAULT_EFFORT; // /effort swaps it live; "" means don't pass --effort (CLI default)
  const cwd     = opts.cwd     || DEFAULT_CWD;
  const tools   = opts.tools != null ? opts.tools : DEFAULT_TOOLS; // undefined/null -> DEFAULT_TOOLS (full tools)
  let sessionId = null;        // last KNOWN-GOOD session id (committed only after a clean turn)
  let consecutiveFails = 0;    // self-heal: drop a wedged session after repeated failures
  let busy = false;
  let burnedTokens = 0;        // status bar: cumulative tokens burned this session (zeroed on /clear)

  function reset() { sessionId = null; burnedTokens = 0; }

  async function ask(text, cb = {}) {
    const onSentence = cb.onSentence || (() => {});
    const onThinking = cb.onThinking || (() => {});
    const onActivity = cb.onActivity || (() => {}); // true-CLI: her tool actions, shown in the drawer (never spoken)
    const onStatus   = cb.onStatus   || (() => {}); // status bar: model + context% + tokens burned (never spoken)
    const onDone     = cb.onDone     || (() => {});
    const onError    = cb.onError    || (() => {});
    const onBusy     = cb.onBusy     || (() => {});
    if (busy) { onBusy(); return; } // still answering — benign, not an error; drop the overlap
    busy = true;
    onThinking(true);
    let first = false, errored = false;
    const emit = (s) => { if (!first) { onThinking(false); first = true; } if (s && s.trim()) onSentence(s.trim()); };
    try {
      if (backend === "mock") await mockTurn(text, emit, onStatus);
      else if (backend === "cli") await cliTurn(text, emit, onActivity, onStatus);
      else throw new Error(`unknown BRAIN_BACKEND "${backend}" (use mock or cli)`);
      consecutiveFails = 0;
    } catch (err) {
      errored = true;
      onThinking(false);
      onError(err);
      if (++consecutiveFails >= 2) reset(); // a wedged --resume session won't poison turn after turn
    } finally {
      // A clean turn that produced nothing should still give the user a spoken cue (not silence).
      if (!first && !errored) { onThinking(false); onSentence("Sorry, I didn't quite catch that. Could you say it again?"); }
      busy = false;
      onThinking(false);
      onDone();
    }
  }

  // ---- mock: deterministic, no usage ----
  async function mockTurn(text, emit, onStatus = () => {}) {
    const reply =
      `You said: ${String(text).slice(0, 120)}. ` +
      "This is the mock Claude, proving the plumbing end to end. " +
      "Set BRAIN_BACKEND to cli to hear the real me. ";
    const { sentences } = drainSentences(reply);
    for (const s of sentences) { await sleep(200); emit(s); }
    burnedTokens += reply.length;                                  // canned, non-zero — proves the status frame end to end
    onStatus({ model: "mock", ctxPct: 1, burned: burnedTokens });
  }

  // Map a tool_use to a short terminal-style activity line (shown in the drawer, never spoken).
  const toolBase = (p) => (p ? String(p).split("/").pop() : "");
  const toolTrunc = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  function formatTool(name, input = {}) {
    switch (name) {
      case "Edit": case "MultiEdit": return `editing ${toolBase(input.file_path)}`;
      case "Write":        return `writing ${toolBase(input.file_path)}`;
      case "Read":         return `reading ${toolBase(input.file_path)}`;
      case "NotebookEdit": return `editing ${toolBase(input.notebook_path)}`;
      case "Grep":         return `searching “${toolTrunc(input.pattern, 40)}”`;
      case "Glob":         return `globbing ${toolTrunc(input.pattern, 40)}`;
      case "Bash":         return `running ${toolTrunc(input.command, 60)}`;
      case "Task":         return `delegating to a subagent`;
      case "WebFetch":     return `fetching ${toolTrunc(input.url, 48)}`;
      case "WebSearch":    return `searching the web`;
      case "TodoWrite":    return `updating the to-do list`;
      default:
        if (name && name.startsWith("mcp__")) return name.split("__").pop().replace(/_/g, " ");
        return name ? name.toLowerCase() : "";
    }
  }

  // ---- cli: the proven `claude -p` stream-json path ----
  function cliTurn(text, emit, onActivity = () => {}, onStatus = () => {}) {
    return new Promise((resolve, reject) => {
      const args = [
        "-p", String(text),
        "--model", model,
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--setting-sources", "user,project,local",   // her CLAUDE.md persona + memory + workspace allow-rules
        "--permission-mode", "bypassPermissions",    // full auto, no confirm gate — matches the global default
        "--append-system-prompt", FACE_SYSTEM,
      ];
      // FULL POWER: by default we do NOT pass --tools, so the complete built-in set (Bash, Edit, Write,
      // Read, Task, …) is available — same as the terminal. tools="" disables all tools; a token list
      // (e.g. "Read Grep Glob") narrows back to a read-only face. (--tools sets the AVAILABLE set.)
      if (tools != null) {
        args.push("--tools", ...(tools === "" ? [""] : tools.split(/\s+/).filter(Boolean)));
      }
      if (effort) args.push("--effort", effort); // reasoning effort, set live via /effort (validated relay-side)
      if (sessionId) args.push("--resume", sessionId);

      // Free Max auth: never let a metered API key/token override the subscription/OAuth.
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;

      // stdin 'ignore' avoids claude's ~3s "waiting for stdin" stall on every turn.
      // Windows-safe launcher: the CLI ships as claude.cmd on win32 (which must be run through a
      // shell), and BRAIN_CLI_BIN lets an operator point at an absolute launcher path. We keep the
      // argv-ARRAY form on every platform (no shell string built from `text`), so user input is never
      // interpolated into a command line — the no-command-injection property is preserved.
      const isWin = process.platform === "win32";
      const bin   = process.env.BRAIN_CLI_BIN || (isWin ? "claude.cmd" : "claude");
      const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: isWin });

      let lineBuf = "", textBuf = "", resultText = "", stderr = "", sawDelta = false, settled = false;
      let capturedSid = null; // committed to sessionId only on a clean close, so a failed turn never poisons --resume
      let capturedModel = model; // overwritten with the real id from the first assistant message (for the status bar)
      // Watchdog. On timeout: (1) SIGTERM the child, (2) escalate to SIGKILL on a short second timer
      // if it ignores SIGTERM, and (3) settle THIS promise (reject) immediately — so `busy` is always
      // released even if the child never emits 'close'. The SIGKILL timer is deliberately left running
      // past the settle (and unref'd so it can't hold the event loop open).
      let killTimer = null;
      const killer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 4000);
        killTimer.unref?.();
        if (!settled) { settled = true; clearTimeout(killer); reject(new Error(`claude turn timed out after ${Math.round(TIMEOUT_MS / 1000)}s`)); }
      }, TIMEOUT_MS);
      const done = (fn) => { if (settled) return; settled = true; clearTimeout(killer); if (killTimer) clearTimeout(killTimer); fn(); };

      const onEvent = (o) => {
        if (o.session_id && !capturedSid) capturedSid = o.session_id;
        if (o.type === "stream_event" && o.event) {
          const ev = o.event;
          if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
            sawDelta = true;
            textBuf += ev.delta.text || "";
            const { sentences, remainder } = drainSentences(textBuf);
            for (const s of sentences) emit(s);
            textBuf = remainder;
          }
        } else if (o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
          // True-CLI activity feed: surface her tool actions as terminal lines (shown, never spoken).
          if (o.message.model) capturedModel = o.message.model; // status bar: the model actually serving this turn
          for (const b of o.message.content) {
            if (b.type === "tool_use") { const line = formatTool(b.name, b.input); if (line) onActivity(line); }
          }
        } else if (o.type === "result" && typeof o.result === "string") {
          resultText = o.result;
          // Status bar: context tokens = input + both cache fields; window read from modelUsage (200k for sonnet now).
          const u = o.usage || {};
          const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          const win = (o.modelUsage && o.modelUsage[capturedModel] && o.modelUsage[capturedModel].contextWindow) || CONTEXT_WINDOW;
          burnedTokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
          onStatus({ model: capturedModel, ctxPct: Math.min(100, Math.round((ctx / win) * 100)), burned: burnedTokens });
        }
      };

      child.stdout.on("data", (chunk) => {
        lineBuf += chunk.toString();
        let nl;
        while ((nl = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (line) { try { onEvent(JSON.parse(line)); } catch { /* non-JSON: ignore */ } }
        }
      });
      child.stderr.on("data", (c) => { stderr += c.toString(); });
      child.on("error", (e) => done(() => reject(e)));
      child.on("close", (code) => done(() => {
        if (textBuf.trim()) { emit(textBuf); textBuf = ""; }       // trailing partial sentence
        if (!sawDelta && resultText.trim()) {                       // fallback: no deltas, use the final result
          const { sentences, remainder } = drainSentences(resultText + " ");
          for (const s of sentences) emit(s);
          if (remainder.trim()) emit(remainder);
        }
        if (code !== 0 && !sawDelta && !resultText.trim()) {
          reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300).trim() || "no output"}`));
        } else {
          if (capturedSid) sessionId = capturedSid;               // commit the session only on a clean turn
          resolve();
        }
      }));
    });
  }

  return {
    ask, reset, backend, cwd,
    setModel(m) { model = m; },     // /model command: takes effect on the next spawned turn
    setEffort(e) { effort = e; },   // /effort command: same, applied on the next spawn
    get model() { return model; },  // reassignable now, so expose via getter (relay logs it, /model swaps it)
    get effort() { return effort; },
    get sessionId() { return sessionId; },
  };
}

// quick self-test: node bridge/brain.mjs --selftest  (drainSentences boundary cases)
if (process.argv[1] && process.argv[1].endsWith("brain.mjs") && process.argv.includes("--selftest")) {
  const cases = [
    ["One sentence. Two! And three? ", ["One sentence.", "Two!", "And three?"], ""],
    ["It cost $3.50 today. ", ["It cost $3.50 today."], ""],
    ["The ratio is 1.5 to one. ", ["The ratio is 1.5 to one."], ""],
    ["He left at 3 p.m. sharp. ", ["He left at 3 p.m. sharp."], ""],
    ["Dr. Smith arrived. ", ["Dr. Smith arrived."], ""],
    ["Streaming tail with no space.", [], "Streaming tail with no space."],
  ];
  let pass = 0;
  for (const [inp, wantS, wantR] of cases) {
    const { sentences, remainder } = drainSentences(inp);
    const ok = JSON.stringify(sentences) === JSON.stringify(wantS) && remainder === wantR;
    pass += ok ? 1 : 0;
    console.log(`${ok ? "PASS" : "FAIL"}  in=${JSON.stringify(inp)}\n      sentences=${JSON.stringify(sentences)} remainder=${JSON.stringify(remainder)}${ok ? "" : `\n      want     =${JSON.stringify(wantS)} remainder=${JSON.stringify(wantR)}`}`);
  }
  console.log(`\n${pass}/${cases.length} passed`);
  process.exit(pass === cases.length ? 0 : 1);
}
