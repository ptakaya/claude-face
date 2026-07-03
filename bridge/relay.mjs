/**
 * Claude Face — M3 two-way talking bridge (relay).
 *
 * Down-leg (M1, reused untouched): a line -> her mouth.
 *   - POST /say {"text":"…"}  ->  cleanForTts -> {type:"say"} frame broadcast to every page,
 *     which calls speak() (the same audio-clock viseme seam the Speak button uses).
 * Up-leg (M3, new): the page -> Claude -> her mouth.
 *   - The page sends {type:"ask", text} over its (already token-gated) WS. We hand it to a
 *     Claude session (brain.mjs), stream her reply back as {type:"say"} sentences, and pulse
 *     {type:"thinking", on} while she composes (the iMessage dots).
 *
 * Bound to 127.0.0.1 only. A shared token gates BOTH the WS upgrade AND POST /say (the M1
 * "/say is loopback-trusted" deferral, now closed). A WS Origin allowlist blocks a stray
 * browser page from connecting. (2026-06-25)
 */
import http from "node:http";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { cleanForTts } from "./cleanForTts.mjs";
import { createBrain } from "./brain.mjs";

const PORT      = +(process.env.SF_BRIDGE_PORT || 8765);
const PAGE_PORT = +(process.env.SF_PAGE_PORT   || 8610); // where phase1 is served, for the ready-to-open URL
const MAX_TEXT  = 4000; // a sane upper bound on a single utterance
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"]; // valid --effort values for the /effort command

// The bridge token is a real per-install secret (she's now full-power, so the door needs a real lock).
// Resolve order: SF_BRIDGE_TOKEN env -> bridge/.sf-token -> generate one, persist it 0600, and use it.
// say.sh reads the same .sf-token; .sf-token is gitignored; the relay prints the ready-to-open URL.
const TOKEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".sf-token");
function resolveToken() {
  if (process.env.SF_BRIDGE_TOKEN) return { token: process.env.SF_BRIDGE_TOKEN, source: "env (SF_BRIDGE_TOKEN)" };
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return { token: t, source: "bridge/.sf-token" };
  } catch { /* not generated yet — fall through and make one */ }
  const t = crypto.randomUUID();
  try {
    fs.writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
    fs.chmodSync(TOKEN_FILE, 0o600); // force 0600 even if the file pre-existed under a looser umask
  } catch (e) {
    console.error(`[token] could not persist ${TOKEN_FILE}: ${e.message} — using an in-memory token for this run only`);
  }
  return { token: t, source: "generated + saved to bridge/.sf-token (chmod 600)" };
}
const { token: TOKEN, source: TOKEN_SOURCE } = resolveToken();

const clients = new Set();
const brain = createBrain(); // the brain — Claude herself (mock by default; BRAIN_BACKEND=cli for the real one)

// Broadcast a JSON frame to every connected page.
function broadcast(obj) {
  const frame = JSON.stringify(obj);
  let n = 0;
  for (const ws of clients) { if (ws.readyState === 1) { ws.send(frame); n++; } }
  return n;
}

// A line of text -> her mouth. cleanForTts() so she never reads markdown/code/emoji aloud.
function say(text) {
  const clean = cleanForTts(text);
  if (!clean) return 0;
  return broadcast({ type: "say", id: Math.random().toString(36).slice(2, 8), text: clean, ts: Date.now() });
}

// Send a frame to ONE page — used to scope an ask's reply to the page that asked,
// so a second open/stale tab can never double-speak the same reply.
function sendTo(ws, obj) { if (ws.readyState === 1) { ws.send(JSON.stringify(obj)); return 1; } return 0; }
function sayTo(ws, text) {
  const clean = cleanForTts(text);
  if (!clean) return 0;
  return sendTo(ws, { type: "say", id: Math.random().toString(36).slice(2, 8), text: clean, ts: Date.now() });
}

// token via header (claude-say) or ?token= (curl convenience).
function checkToken(req, url) {
  const hdr = req.headers["x-sf-token"];
  if (typeof hdr === "string" && hdr === TOKEN) return true;
  return (url.searchParams.get("token") || "") === TOKEN;
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://127.0.0.1"); } catch { res.writeHead(400); return res.end("bad url\n"); }

  if (req.method === "GET" && url.pathname === "/health") {
    // Bare liveness only — /health is unauthenticated, so it must not leak backend mode or client
    // counts. Anything beyond {ok:true} belongs behind the token.
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }) + "\n");
  }

  if (req.method === "POST" && url.pathname === "/say") {
    if (!checkToken(req, url)) { res.writeHead(401); return res.end("unauthorized\n"); }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > MAX_TEXT * 4) req.destroy(); });
    req.on("end", () => {
      let text;
      try { text = JSON.parse(body).text; } catch { res.writeHead(400); return res.end("bad json\n"); }
      if (typeof text !== "string" || !text.trim()) { res.writeHead(400); return res.end("empty text\n"); }
      const delivered = say(text.slice(0, MAX_TEXT));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, delivered }) + "\n");
      console.log(`[say] -> ${delivered} client(s): ${JSON.stringify(text.slice(0, 80))}`);
      if (delivered === 0) console.log("       (no page connected — open the page with ?bridge=1 and the matching token)");
    });
    return;
  }

  res.writeHead(404); res.end("not found\n");
});

// WS upgrade on /face: token-gated AND origin-checked.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  let url;
  try { url = new URL(req.url, "http://127.0.0.1"); } catch { socket.destroy(); return; }
  if (url.pathname !== "/face") { socket.destroy(); return; }
  if ((url.searchParams.get("token") || "") !== TOKEN) { socket.destroy(); return; }
  if (!originAllowed(req.headers.origin)) { console.log(`[ws] rejected origin ${req.headers.origin}`); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    console.log(`[ws] page connected (${clients.size} total)`);
    ws.on("message", (data) => handleAsk(ws, data));
    ws.on("close", () => { clients.delete(ws); console.log(`[ws] page disconnected (${clients.size} left)`); });
    ws.on("error", () => {});
  });
});

// A browser always sends Origin; only the local page (any port) may connect. Non-browser
// clients send no Origin and are allowed (they can't be a malicious cross-site page); the
// token is still required either way.
function originAllowed(origin) {
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch { return false; }
}

// Local slash commands — handled in the relay, never sent to Claude. The CLI's command router would
// run the real command (skills execute, /config writes, built-ins get spoken), so we support only the
// two live controls you use (/model, /effort) and fence off every other "/" with a friendly nudge.
function handleSlash(ws, text) {
  sendTo(ws, { type: "thinking", on: false }); // a local command has no "thinking" — clear the page's optimistic dots
  const parts = text.slice(1).split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();
  switch (cmd) {
    case "model": {
      const m = (parts[1] || "").toLowerCase();
      if (m === "sonnet" || m === "opus") {
        brain.setModel(m);
        sendTo(ws, { type: "activity", text: `model set to ${m}, takes effect next turn`, ts: Date.now() });
      } else {
        sendTo(ws, { type: "activity", text: "usage: /model sonnet or opus", ts: Date.now() });
      }
      return;
    }
    case "effort": {
      const e = (parts[1] || "").toLowerCase();
      if (EFFORT_LEVELS.includes(e)) {
        brain.setEffort(e);
        sendTo(ws, { type: "activity", text: `effort set to ${e}, takes effect next turn`, ts: Date.now() });
      } else {
        sendTo(ws, { type: "activity", text: `usage: /effort ${EFFORT_LEVELS.join(" | ")}`, ts: Date.now() });
      }
      return;
    }
    default:
      sendTo(ws, { type: "activity", text: `/${cmd} isn't a command here. Just talk to me.`, ts: Date.now() });
      return;
  }
}

// The up-leg: a page sends {type:"ask", text}. Hand it to Claude; stream her reply back as
// {type:"say"} sentences (her existing mouth) and pulse {type:"thinking"} while she composes.
function handleAsk(ws, data) {
  let m;
  try { m = JSON.parse(data.toString()); } catch { return; }
  if (!m || m.type !== "ask" || typeof m.text !== "string") return;
  const text = m.text.slice(0, MAX_TEXT).trim();
  if (!text) return;
  // Slash commands are handled locally and NEVER sent to claude -p — its router would run the real
  // skill (/vault-drop deletes, /end-session executes), write config, or speak a built-in's output.
  if (text.startsWith("/")) { handleSlash(ws, text); return; }
  console.log(`[ask] <- ${JSON.stringify(text.slice(0, 80))}`);
  // Reply ONLY to the page that asked. A reply belongs to its conversation, so any other open
  // tab (e.g. a stale one still connected) never double-speaks it — no overlapping voices.
  brain.ask(text, {
    onThinking: (on) => sendTo(ws, { type: "thinking", on: !!on }),
    onSentence: (s) => sayTo(ws, s),
    onActivity: (line) => sendTo(ws, { type: "activity", text: line, ts: Date.now() }), // true-CLI: shown, not spoken
    onStatus: (meta) => sendTo(ws, { type: "status", ...meta, ts: Date.now() }), // model + context% + tokens burned, scoped to the asking page
    onBusy: () => { console.log("[ask] busy — dropped an overlapping line"); sendTo(ws, { type: "thinking", on: false }); },
    onError: (err) => {
      console.log(`[ask] error: ${err.message}`);
      sendTo(ws, { type: "thinking", on: false });
      // A missing CLI is a setup problem, not a hiccup — telling the user to "say that again"
      // would send them in circles. Name the actual fix, in the console AND through the face.
      if (err.code === "ENOENT" || /ENOENT/.test(err.message)) {
        console.log(`[ask] the \`claude\` command was not found. The cli backend needs the Claude Code CLI installed and signed in (https://claude.com/claude-code) — the Claude desktop app alone does not include it. (Or point BRAIN_CLI_BIN at the binary.)`);
        sayTo(ws, "I could not find the claude command on this machine. The real brain needs the Claude Code terminal command installed and signed in. The Claude desktop app alone is not enough.");
      } else {
        sayTo(ws, "Sorry, I lost my thread for a moment. Could you say that again?");
      }
    },
    onDone: () => sendTo(ws, { type: "thinking", on: false }),
  });
}

server.listen(PORT, "127.0.0.1", () => {
  // Carry bridgePort so the page's WS targets THIS relay even under a non-default SF_BRIDGE_PORT.
  const pageUrl = `http://localhost:${PAGE_PORT}/?app=1&token=${TOKEN}&bridgePort=${PORT}`;
  // The tools label must tell the truth: BRAIN_TOOLS="" is a talk-only face, a token list is
  // a narrowed set, and only the undefined default is the full bypassPermissions toolset.
  const toolsLabel = brain.tools === undefined
    ? "FULL POWER — full tools + MCP + bypassPermissions"
    : (brain.tools === "" ? "talk-only — all tools disabled (BRAIN_TOOLS=\"\")" : `tools narrowed to: ${brain.tools}`);
  const brainLabel = brain.backend === "cli"
    ? `Claude (cli) · model ${brain.model} · ${toolsLabel}`
    : "mock (set BRAIN_BACKEND=cli for the real Claude)";
  console.log(`Claude Face bridge up on 127.0.0.1:${PORT} (loopback only)`);
  console.log(`  brain  ->  ${brainLabel}`);
  if (brain.backend === "cli") {
    // Fail loudly at startup, not on the first ask: the cli backend is useless without the
    // Claude Code CLI, and the most common trap is having only the Claude desktop app.
    const isWin = process.platform === "win32";
    const bin = process.env.BRAIN_CLI_BIN || (isWin ? "claude.cmd" : "claude");
    const probe = spawnSync(isWin ? "where" : "which", [bin], { stdio: "ignore" });
    if (probe.status !== 0) {
      console.log(`  WARNING -> '${bin}' not found on PATH — asks WILL fail.`);
      console.log(`             Install the Claude Code CLI and sign in: https://claude.com/claude-code`);
      console.log(`             (The Claude desktop app alone does not include it. Or set BRAIN_CLI_BIN.)`);
    }
  }
  console.log(`  token  ->  ${TOKEN_SOURCE}`);
  console.log(`\n  Open the face in a browser:`);
  console.log(`     ${pageUrl}`);
  if (process.platform === "darwin") console.log(`     open -a "Google Chrome" "${pageUrl}"`);
  console.log(`\n  one-way say  ->  node bridge/say.mjs "…"   (from the repo root; reads the token for you)`);
});
