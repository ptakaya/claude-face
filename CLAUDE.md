# CLAUDE.md -- agent setup guide

You are an AI coding agent on a fresh clone of **Claude Face**: a WebGL particle "talking head" plus an optional two-way voice bridge to a Claude brain. Follow these steps to make it run. Do not improvise around them.

## What runs where

- **Face** -- `phase1/`, a static browser page (Three.js via importmap from a pinned CDN). Must be served over HTTP on **port 8610**.
- **Bridge** -- `bridge/`, a Node relay on `127.0.0.1:8765`. Optional. Two backends: `mock` (default, safe, no Claude) and `cli` (real Claude Code).
- **Voice** -- HeadTTS, a separate repo you clone; the face calls it at `http://127.0.0.1:8882/v1/synthesize`. Optional.

## Ports

- `8610` -- face static server (`SF_PAGE_PORT`)
- `8765` -- bridge HTTP+WS (`SF_BRIDGE_PORT`)
- `8882` -- HeadTTS voice engine

## Step 1 -- serve the face (required)

```bash
cd phase1
npm run serve        # zero-dependency Node static server on :8610 (loopback only)
```

Prerequisite: **Node 20 or newer** (check with `node --version`). No `npm install` is needed for the face: `index.html` imports Three.js from a pinned CDN via an importmap, and `serve.mjs` has no dependencies. `npm run serve` runs the shipped `serve.mjs` (no Python needed). Alternatively, from the repo root, `npm start` launches both the face server and the bridge at once.

Open (or tell the user to open):

```
http://localhost:8610/
```

The shipped head (`phase1/vendor/head-default.glb`) loads by default -- no query params needed. The bare page is the clean app window (no talk drawer; that appears only when a bridge URL is used). `?panel=1` opens the full tuning dashboard if the user asks to adjust her look. The page needs one **click anywhere** to unlock browser audio.

This alone is Level 1 (the face). It renders and animates without Claude and without voice.

## Step 2 -- run the bridge (optional: two-way talk)

In a second terminal:

```bash
cd bridge
npm install
npm start
```

`BRAIN_BACKEND` defaults to **`mock`** -- deterministic canned replies, no Claude account, no usage. The relay prints a ready-to-open URL that already contains the per-install token and `bridgePort`, of the form:

```
http://localhost:8610/?app=1&token=<generated>&bridgePort=8765
```

Open that URL, click once to unlock audio, and type into the talk box. This is Level 2. Keep this as the default unless the user explicitly asks for the real brain.

## Step 3 -- opt into the real Claude brain (Level 3, explicit)

Only do this if the user asks for it, and only after they have acknowledged the security note below.

```bash
cd bridge
BRAIN_BACKEND=cli BRAIN_CWD="/absolute/path/to/a/workspace" npm start
```

- `BRAIN_BACKEND=cli` -- spawn a real headless `claude -p` per turn (it exits when the turn ends; nothing stays running).
- `BRAIN_CWD` -- the working directory the session runs in. Optional; defaults to the repo root. If set, use a real, absolute path.
- Prerequisite: **Claude Code installed and authenticated** on this machine.
- Optional dials: `BRAIN_MODEL` (default `sonnet`), `BRAIN_EFFORT`, `BRAIN_TOOLS` (unset = full tools; `""` = read-only face), `SF_BRIDGE_PORT`, `SF_PAGE_PORT`.

### Security -- mandatory before enabling `cli`

The `cli` backend runs Claude with `--permission-mode bypassPermissions` and the full built-in toolset (Bash, Write, Edit, Read, Task, plus any configured MCP servers). **Anything typed into the talk box can make Claude run shell commands and modify files on this machine, with no confirmation.** `mock` is safe and cannot do this. Do not enable `cli` unless the user has explicitly opted in and understands this. To keep two-way talk but block execution, run with `BRAIN_TOOLS=""` (read-only face).

## Step 4 -- voice (optional, enables audible speech)

The face lip-syncs to [HeadTTS](https://github.com/met4citizen/HeadTTS), cloned and run separately.

```bash
git clone https://github.com/met4citizen/HeadTTS
```

Install it per its own README and download its model (~326 MB). Run its server so it answers at `http://127.0.0.1:8882/v1/synthesize` (the endpoint hardcoded in `phase1/main.js`), voice `bf_isabella`. Without it the face still renders; it just has no audio.

## Verify

- Face: `http://localhost:8610/` shows a particle head; `curl http://127.0.0.1:8765/health` returns `{"ok":true}` when the bridge is up.
- Level 2: typing in the talk box streams a canned "mock" reply.
- Level 3: the relay's startup banner shows `Claude (cli) · FULL POWER`, and replies are real.
