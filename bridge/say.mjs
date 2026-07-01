/**
 * Claude Face — one-way "say" CLI (zero-dependency, cross-platform).
 *
 * Replaces bridge/say.sh. POSTs a single line to the running bridge's /say endpoint
 * using Node's global fetch (no bash / readlink / curl). The relay cleans it for TTS
 * and speaks it through every connected face.
 *
 * The bridge must already be running (node start.mjs, or node bridge/relay.mjs).
 *
 * Usage:
 *   node say.mjs "Hello there."
 *   echo "Hello there." | node say.mjs
 *
 * Config (matches relay.mjs):
 *   SF_BRIDGE_TOKEN   token; else read from bridge/.sf-token (same file the relay writes)
 *   SF_BRIDGE_PORT    bridge port (default 8765)
 *   SF_BRIDGE_HOST    bridge host (default 127.0.0.1)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.SF_BRIDGE_PORT || 8765);
const HOST = process.env.SF_BRIDGE_HOST || "127.0.0.1";

function resolveToken() {
  if (process.env.SF_BRIDGE_TOKEN) return process.env.SF_BRIDGE_TOKEN;
  try {
    const t = fs.readFileSync(path.join(HERE, ".sf-token"), "utf8").trim();
    if (t) return t;
  } catch { /* fall through */ }
  return null;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  // Text from argv (joined) or, if none, from stdin.
  let text = process.argv.slice(2).join(" ").trim();
  if (!text) text = (await readStdin()).trim();
  if (!text) {
    console.error('usage: node say.mjs "the line to speak"   (or pipe it on stdin)');
    process.exit(2);
  }

  const token = resolveToken();
  if (!token) {
    console.error("no token found. Set SF_BRIDGE_TOKEN, or start the bridge so it writes bridge/.sf-token.");
    process.exit(1);
  }

  const url = `http://${HOST}:${PORT}/say`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sf-token": token },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error(`could not reach the bridge at ${url} — is it running?  (${e.message})`);
    process.exit(1);
  }

  const bodyText = await res.text();
  if (!res.ok) {
    console.error(`bridge returned ${res.status}: ${bodyText.trim()}`);
    process.exit(1);
  }

  let delivered;
  try { delivered = JSON.parse(bodyText).delivered; } catch { /* ignore */ }
  if (delivered === 0) {
    console.log("sent, but no face is connected — open the page with ?app=1 and the matching token.");
  } else {
    console.log(`spoken to ${delivered ?? "?"} face(s).`);
  }
}

main();
