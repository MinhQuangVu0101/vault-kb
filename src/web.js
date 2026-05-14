import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, code, message) {
  sendJson(res, code, { error: { code, message } });
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  if (rel.includes("..")) return sendError(res, 400, "invalid path");
  const abs = path.join(PUBLIC_DIR, rel);
  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) return sendError(res, 404, "not found");
    res.writeHead(200, {
      "content-type": MIME[path.extname(abs)] ?? "application/octet-stream",
      "content-length": stat.size,
    });
    fs.createReadStream(abs).pipe(res);
  });
}

export function createWebServer({
  vaultIndex,
  embedder = null,
  statsSource,
  logger,
  port = Number(process.env.VAULT_KB_WEB_PORT) || 7345,
  host = "127.0.0.1",
} = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}`);
      if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);

      const q = url.searchParams;
      const limit = Number(q.get("limit")) || undefined;

      switch (url.pathname) {
        case "/api/stats":
          return sendJson(res, 200, statsSource());
        case "/api/search": {
          const query = q.get("q");
          if (!query) return sendError(res, 400, "q required");
          return sendJson(res, 200, {
            rows: vaultIndex.search({ query, folder: q.get("folder") || undefined, tag: q.get("tag") || undefined, limit }),
          });
        }
        case "/api/semantic": {
          const query = q.get("q");
          if (!query) return sendError(res, 400, "q required");
          try {
            const rows = await vaultIndex.semanticSearch({
              query,
              folder: q.get("folder") || undefined,
              tag: q.get("tag") || undefined,
              limit,
            });
            return sendJson(res, 200, { rows });
          } catch (err) {
            return sendError(res, 503, String(err?.message ?? err));
          }
        }
        case "/api/list": {
          return sendJson(res, 200, {
            rows: vaultIndex.list({
              folder: q.get("folder") || undefined,
              tag: q.get("tag") || undefined,
              status: q.get("status") || undefined,
              limit,
            }),
          });
        }
        case "/api/read": {
          const p = q.get("path");
          if (!p) return sendError(res, 400, "path required");
          try {
            const note = vaultIndex.readNote(p, Number(q.get("maxChars")) || undefined);
            return sendJson(res, 200, note);
          } catch (err) {
            return sendError(res, 404, String(err?.message ?? err));
          }
        }
        case "/api/suggest-links": {
          const p = q.get("path");
          if (!p) return sendError(res, 400, "path required");
          if (!embedder) return sendError(res, 503, "embedder disabled");
          try {
            const { suggestLinks } = await import("./suggest-links.js");
            const rows = await suggestLinks({
              vaultIndex,
              embedder,
              path: p,
              limit: limit,
              minScore: q.get("minScore") != null ? Number(q.get("minScore")) : undefined,
            });
            return sendJson(res, 200, { rows });
          } catch (err) {
            return sendError(res, 500, String(err?.message ?? err));
          }
        }
        default:
          return sendError(res, 404, "unknown endpoint");
      }
    } catch (err) {
      logger?.error({ event: "web_error", error: String(err?.message ?? err) });
      return sendError(res, 500, "internal error");
    }
  });

  function start() {
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        const actual = server.address();
        logger?.info({ event: "web_started", url: `http://${host}:${actual.port}` });
        resolve({ host, port: actual.port });
      });
    });
  }

  function stop() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { start, stop, server, host, port };
}
