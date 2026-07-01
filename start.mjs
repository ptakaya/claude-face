/**
 * Claude Face — one-command launcher (zero-dependency, cross-platform).
 *
 * Starts BOTH halves of the local app and wires their lifetimes together:
 *   1) the phase1 static server (phase1/serve.mjs)  — serves the face on 127.0.0.1
 *   2) the bridge relay          (bridge/relay.mjs)  — the talk/say WebSocket + /say
 *
 * Run:   node start.mjs      (or: npm start)
 *
 * Everything here is loopback-only and needs no build step. Two things are OPTIONAL extras,
 * not required to see the face talk:
 *   - The live Claude brain: set BRAIN_BACKEND=cli before running for the real Claude
 *     (full tools + MCP). Without it the bridge uses a mock brain.
 *   - HeadTTS voice: an optional local voice server for higher-quality speech; the browser's
 *     built-in speech synthesis is used when it isn't running.
 *
 * The bridge prints the ready-to-open URL (it holds the token). Ctrl-C shuts both down cleanly.
 *
 * Ports (override via env):
 *   SF_PAGE_PORT    static server port (default 8610)
 *   SF_BRIDGE_PORT  bridge relay port  (default 8765)
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PORT = process.env.SF_PAGE_PORT || "8610";

const children = [];
let shuttingDown = false;

// Spawn a Node child with shell:false (cross-platform, no shell quoting pitfalls) and
// pipe its output through with a short label so both processes read cleanly in one console.
function launch(label, scriptRelPath, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, scriptRelPath)], {
    cwd: ROOT,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  const tag = (line) => `[${label}] ${line}`;
  const pipe = (src, dst) => {
    src.setEncoding("utf8");
    let buf = "";
    src.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        dst.write(tag(buf.slice(0, nl)) + "\n");
        buf = buf.slice(nl + 1);
      }
    });
    src.on("end", () => { if (buf) dst.write(tag(buf) + "\n"); });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`[start] ${label} exited (${signal || code}). Shutting everything down.`);
    shutdown(code == null ? 1 : code);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  // Give children a moment to close, then hard-exit.
  setTimeout(() => process.exit(code), 500).unref();
}

process.on("SIGINT",  () => { console.log("\n[start] SIGINT — stopping."); shutdown(0); });
process.on("SIGTERM", () => { shutdown(0); });

console.log("Claude Face — starting phase1 server + bridge relay…");
launch("phase1", path.join("phase1", "serve.mjs"));
launch("bridge", path.join("bridge", "relay.mjs"));
console.log(`\nWhen the bridge prints its link, open it (it carries the token).`);
console.log(`Page will be served at  http://localhost:${PAGE_PORT}/  (Ctrl-C stops both)\n`);
