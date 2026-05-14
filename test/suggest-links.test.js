import test from "node:test";
import assert from "node:assert/strict";

import { suggestLinks } from "../src/suggest-links.js";

function fakeIndex(rows) {
  return {
    readNote(path) {
      const r = rows.find((x) => x.path === path);
      if (!r) throw new Error(`not found: ${path}`);
      return {
        path: r.path,
        title: r.title,
        rawContent: r.body,
        outlinks: r.outlinks ?? [],
        backlinks: r.backlinks ?? [],
        excerpt: r.body.slice(0, 80),
      };
    },
    findRelatedByPath(path, { limit, excludePaths }) {
      const excl = new Set([path, ...excludePaths]);
      return rows
        .filter((r) => !excl.has(r.path))
        .map((r) => ({ path: r.path, title: r.title, excerpt: r.body.slice(0, 80), score: r._score ?? 0.5 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
  };
}

function fakeEmbedder(summary = "they're related") {
  return { async summarize() { return summary; }, status() { return { llmModel: "test" }; } };
}

test("suggestLinks: excludes source and already-linked paths", async () => {
  const rows = [
    { path: "a.md", title: "A", body: "alpha", outlinks: [{ path: "b.md" }], backlinks: [{ path: "c.md" }], _score: 1 },
    { path: "b.md", title: "B", body: "beta", _score: 0.9 },
    { path: "c.md", title: "C", body: "gamma", _score: 0.85 },
    { path: "d.md", title: "D", body: "delta", _score: 0.8 },
  ];
  const out = await suggestLinks({
    vaultIndex: fakeIndex(rows),
    embedder: fakeEmbedder(),
    path: "a.md",
    limit: 5,
    minScore: 0,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, "d.md");
  assert.equal(out[0].reason, "they're related");
});

test("suggestLinks: respects minScore cutoff", async () => {
  const rows = [
    { path: "a.md", title: "A", body: "alpha", outlinks: [], backlinks: [], _score: 1 },
    { path: "b.md", title: "B", body: "beta", _score: 0.7 },
    { path: "c.md", title: "C", body: "gamma", _score: 0.3 },
  ];
  const out = await suggestLinks({
    vaultIndex: fakeIndex(rows),
    embedder: fakeEmbedder(),
    path: "a.md",
    limit: 5,
    minScore: 0.5,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, "b.md");
});

test("suggestLinks: returns reason=null when summarize falls back", async () => {
  const rows = [
    { path: "a.md", title: "A", body: "alpha", outlinks: [], backlinks: [], _score: 1 },
    { path: "b.md", title: "B", body: "beta", _score: 0.9 },
  ];
  const embedder = { async summarize() { return null; }, status() { return { llmModel: null }; } };
  const out = await suggestLinks({
    vaultIndex: fakeIndex(rows),
    embedder,
    path: "a.md",
    limit: 5,
    minScore: 0,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, null);
});

test("suggestLinks: caps limit and orders by score desc", async () => {
  const rows = [
    { path: "a.md", title: "A", body: "alpha", outlinks: [], backlinks: [] },
    { path: "b.md", title: "B", body: "beta", _score: 0.5 },
    { path: "c.md", title: "C", body: "gamma", _score: 0.9 },
    { path: "d.md", title: "D", body: "delta", _score: 0.7 },
  ];
  const out = await suggestLinks({
    vaultIndex: fakeIndex(rows),
    embedder: fakeEmbedder("ok"),
    path: "a.md",
    limit: 2,
    minScore: 0,
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "c.md");
  assert.equal(out[1].path, "d.md");
});
