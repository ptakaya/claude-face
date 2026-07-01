/**
 * Claude Face — Phase 1 static file server (zero-dependency, cross-platform).
 *
 * Replaces the old python3 serve-nocache.py. Serves the phase1/ directory over
 * plain HTTP, bound to 127.0.0.1 (loopback ONLY — never a public interface), with
 * no-cache headers so an edit to main.js/index.html is always the file you get back.
 *
 * Usage:
 *   node serve.mjs           # port 8610 (default)
 *   node serve.mjs 9000      # port from argv
 *   SF_PAGE_PORT=9000 node serve.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // the phase1/ directory
const HOST = "127.0.0.1"; // loopback only — do NOT bind 0.0.0.0
const PORT = +(process.argv[2] || process.env.SF_PAGE_PORT || 8610);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map":  "application/json; charset=utf-8",
  ".glb":  "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wasm": "application/wasm",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif":  "image/gif",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".txt":  "text/plain; charset=utf-8",
  ".wav":  "audio/wav",
  ".mp3":  "audio/mpeg",
  ".ogg":  "audio/ogg",
};

const NO_CACHE = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...NO_CACHE, ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, HEAD" }, "method not allowed\n");
  }

  // Browsers auto-request /favicon.ico; we ship no icon, so answer 204 (no content) rather
  // than a 404 that would surface as a red console error on first load.
  if (req.url === "/favicon.ico") return send(res, 204, {}, null);

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  } catch {
    return send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "bad request\n");
  }

  if (pathname.endsWith("/")) pathname += "index.html";

  // Resolve within ROOT and refuse anything that escapes it (path traversal guard).
  const filePath = path.join(ROOT, path.normalize(pathname));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "forbidden\n");
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "not found\n");
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    // Editable source (html/js/css) stays no-store, so a mid-edit reload always gets the fresh
    // file. The large head binary is served no-cache instead — storable + must-revalidate —
    // which lets Chrome coalesce the in-flight fetch. Under no-store the browser fires a
    // duplicate request for a big GLB and aborts one (a harmless but ugly net::ERR_ABORTED in
    // DevTools); no-cache avoids that. Freshness is unchanged: no validator is sent, so each
    // page load still refetches the model in full.
    const cache = (ext === ".glb" || ext === ".gltf") ? { "Cache-Control": "no-cache" } : NO_CACHE;
    const headers = { ...cache, "Content-Type": type, "Content-Length": stat.size };
    if (req.method === "HEAD") { res.writeHead(200, headers); return res.end(); }

    res.writeHead(200, headers);
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => { if (!res.headersSent) res.writeHead(500); res.end(); });
    stream.pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Face phase1 served on http://${HOST}:${PORT} (loopback only, no-cache)`);
});
