import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import matter from "gray-matter";

import { VaultIndex } from "../src/vault-index.js";
import { createWebServer } from "../src/web.js";

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-web-"));
}

function mkConfig(vaultRoot) {
  return {
    vaultRoot,
    indexPath: path.join(vaultRoot, ".data", "index.sqlite"),
    hardExcludedFolders: [],
    hardExcludedFoldersLower: [],
    defaultLimits: { search: 8, list: 25, readChars: 12000 },
    maxLimits: { search: 20, list: 100, readChars: 40000 },
  };
}

function write(v, rel, fm, body) {
  const abs = path.join(v, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, matter.stringify(body, fm));
}

async function withServer(fn) {
  const v = tmpVault();
  write(v, "a.md", { "ai-access": true, status: "active" }, "links to [[B]] hello world");
  write(v, "b.md", { "ai-access": true, status: "active" }, "body of B");
  const config = mkConfig(v);
  const index = new VaultIndex(config);
  index.ingest();

  const web = createWebServer({
    vaultIndex: index,
    statsSource: () => ({
      indexed: 2,
      watcher: { active: false, events: null },
      embeddings: { covered: 0, total: 2, reachable: null, model: null, lastError: null },
      lastIngest: new Date().toISOString(),
    }),
    host: "127.0.0.1",
    port: 0,
  });
  const info = await web.start();
  const base = `http://${info.host}:${info.port}`;
  try {
    await fn(base);
  } finally {
    await web.stop();
    index.close();
  }
}

test("GET /api/stats returns snapshot", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/stats`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.indexed, 2);
    assert.equal(json.watcher.active, false);
  });
});

test("GET /api/search returns rows with backlinkCount", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/search?q=hello`);
    const json = await res.json();
    assert.ok(Array.isArray(json.rows));
    assert.ok(json.rows.length >= 1);
    assert.equal(typeof json.rows[0].backlinkCount, "number");
  });
});

test("GET /api/search without q returns 400", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/search`);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error.message, /q required/);
  });
});

test("GET /api/list returns rows", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/list?status=active`);
    const json = await res.json();
    assert.equal(json.rows.length, 2);
  });
});

test("GET /api/read returns backlinks + outlinks", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/read?path=b.md`);
    const json = await res.json();
    assert.equal(json.path, "b.md");
    assert.equal(json.backlinks.length, 1);
    assert.equal(json.backlinks[0].path, "a.md");
  });
});

test("GET /api/read missing path returns 400", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/read`);
    assert.equal(res.status, 400);
  });
});

test("GET / serves index.html", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /vault-kb/);
  });
});

test("GET /api/unknown returns 404", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
  });
});

test("GET /api/suggest-links returns rows with reasons", async () => {
  const vaultIndex = {
    readNote: () => ({
      path: "a.md", title: "A", rawContent: "body of A",
      outlinks: [], backlinks: [], excerpt: "body of A",
    }),
    findRelatedByPath: () => [{ path: "b.md", title: "B", excerpt: "body of B", score: 0.9 }],
  };
  const embedder = {
    async summarize() { return "they overlap on topic X"; },
    status() { return { llmModel: "test" }; },
  };
  const web = createWebServer({
    vaultIndex,
    embedder,
    statsSource: () => ({}),
    host: "127.0.0.1",
    port: 0,
  });
  const info = await web.start();
  const base = `http://${info.host}:${info.port}`;
  try {
    const res = await fetch(`${base}/api/suggest-links?path=a.md&limit=3`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.rows.length, 1);
    assert.equal(json.rows[0].path, "b.md");
    assert.equal(json.rows[0].reason, "they overlap on topic X");
  } finally {
    await web.stop();
  }
});

test("GET /api/suggest-links without embedder returns 503", async () => {
  const web = createWebServer({
    vaultIndex: { readNote: () => ({}), findRelatedByPath: () => [] },
    embedder: null,
    statsSource: () => ({}),
    host: "127.0.0.1",
    port: 0,
  });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/suggest-links?path=a.md`);
    assert.equal(res.status, 503);
  } finally {
    await web.stop();
  }
});

test("GET /api/suggest-links without path returns 400", async () => {
  const web = createWebServer({
    vaultIndex: {}, embedder: {}, statsSource: () => ({}),
    host: "127.0.0.1", port: 0,
  });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/suggest-links`);
    assert.equal(res.status, 400);
  } finally {
    await web.stop();
  }
});

test("GET /api/suggest-links with non-numeric minScore returns 400", async () => {
  const web = createWebServer({
    vaultIndex: { readNote: () => ({}), findRelatedByPath: () => [] },
    embedder: { async summarize() { return null; }, status() { return { llmModel: null }; } },
    statsSource: () => ({}),
    host: "127.0.0.1",
    port: 0,
  });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/suggest-links?path=a.md&minScore=abc`);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error.message, /minScore must be a number/);
  } finally {
    await web.stop();
  }
});

test("GET /api/suggest-links returns 422 when source has no embedding", async () => {
  const vaultIndex = {
    readNote: () => ({ path: "a.md", title: "A", rawContent: "x", outlinks: [], backlinks: [], excerpt: "x" }),
    findRelatedByPath: () => { throw new Error("No embedding for path: a.md"); },
  };
  const embedder = { async summarize() { return null; }, status() { return { llmModel: null }; } };
  const web = createWebServer({ vaultIndex, embedder, statsSource: () => ({}), host: "127.0.0.1", port: 0 });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/suggest-links?path=a.md`);
    assert.equal(res.status, 422);
    const json = await res.json();
    assert.match(json.error.message, /no embedding/i);
  } finally {
    await web.stop();
  }
});

test("GET /api/suggest-links with unknown path returns 404", async () => {
  const vaultIndex = {
    readNote: () => { throw new Error("Note not found: ghost.md"); },
    findRelatedByPath: () => [],
  };
  const embedder = { async summarize() { return null; }, status() { return { llmModel: null }; } };
  const web = createWebServer({ vaultIndex, embedder, statsSource: () => ({}), host: "127.0.0.1", port: 0 });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/suggest-links?path=ghost.md`);
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.match(json.error.message, /not found/i);
  } finally {
    await web.stop();
  }
});

test("GET /api/suggest-links with limit > 20 returns 400", async () => {
  const web = createWebServer({
    vaultIndex: {}, embedder: {}, statsSource: () => ({}),
    host: "127.0.0.1", port: 0,
  });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/suggest-links?path=a.md&limit=99`);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error.message, /limit must be an integer/i);
  } finally {
    await web.stop();
  }
});

test("GET /api/identity returns email when Cloudflare header is present", async () => {
  const web = createWebServer({
    vaultIndex: {},
    embedder: null,
    statsSource: () => ({}),
    host: "127.0.0.1",
    port: 0,
  });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/identity`, {
      headers: { "cf-access-authenticated-user-email": "alice@example.com" },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.email, "alice@example.com");
  } finally {
    await web.stop();
  }
});

test("GET /api/related returns rows for a path", async () => {
  const vaultIndex = {
    findRelatedByPath: () => [{ path: "b.md", title: "B", excerpt: "body of B", score: 0.9 }],
  };
  const embedder = { status() { return { llmModel: null }; } };
  const web = createWebServer({
    vaultIndex,
    embedder,
    statsSource: () => ({}),
    host: "127.0.0.1",
    port: 0,
  });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/related?path=a.md&limit=3`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.rows.length, 1);
    assert.equal(json.rows[0].path, "b.md");
  } finally {
    await web.stop();
  }
});

test("GET /api/related without path returns 400", async () => {
  const web = createWebServer({
    vaultIndex: {}, embedder: {}, statsSource: () => ({}),
    host: "127.0.0.1", port: 0,
  });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/related`);
    assert.equal(res.status, 400);
  } finally {
    await web.stop();
  }
});

test("GET /api/related without embedder returns 503", async () => {
  const web = createWebServer({
    vaultIndex: {}, embedder: null, statsSource: () => ({}),
    host: "127.0.0.1", port: 0,
  });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/related?path=a.md`);
    assert.equal(res.status, 503);
  } finally {
    await web.stop();
  }
});

test("GET /api/identity returns email=null when header absent", async () => {
  const web = createWebServer({
    vaultIndex: {},
    embedder: null,
    statsSource: () => ({}),
    host: "127.0.0.1",
    port: 0,
  });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/identity`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.email, null);
  } finally {
    await web.stop();
  }
});

test("GET /api/orphans returns rows", async () => {
  const vaultIndex = {
    findOrphans: ({ limit }) => [
      { path: "orphan.md", title: "Orphan", folder: "", tags_text: "", excerpt: "", area: "", type: "note", status: "active", updated: "2026-05-01" },
    ],
  };
  const web = createWebServer({
    vaultIndex,
    embedder: null,
    statsSource: () => ({}),
    host: "127.0.0.1",
    port: 0,
  });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/orphans?limit=10`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.rows.length, 1);
    assert.equal(json.rows[0].path, "orphan.md");
  } finally {
    await web.stop();
  }
});

test("GET /api/orphans with out-of-range limit returns 400", async () => {
  const web = createWebServer({
    vaultIndex: {}, embedder: null, statsSource: () => ({}),
    host: "127.0.0.1", port: 0,
  });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/orphans?limit=999`);
    assert.equal(res.status, 400);
  } finally {
    await web.stop();
  }
});
