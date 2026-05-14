import test from "node:test";
import assert from "node:assert/strict";

import { relatedNotes } from "../src/related.js";

function fakeIndex(rows) {
  return {
    findRelatedByPath(path, { limit, excludePaths }) {
      const excl = new Set([path, ...excludePaths]);
      return rows
        .filter((r) => !excl.has(r.path))
        .map((r) => ({ path: r.path, title: r.title, excerpt: r.body?.slice(0, 80) ?? "", score: r._score ?? 0.5 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
  };
}

test("relatedNotes: delegates to findRelatedByPath with empty excludePaths", async () => {
  const rows = [
    { path: "a.md", title: "A", body: "alpha", _score: 1 },
    { path: "b.md", title: "B", body: "beta", _score: 0.9 },
    { path: "c.md", title: "C", body: "gamma", _score: 0.6 },
  ];
  const out = await relatedNotes({
    vaultIndex: fakeIndex(rows),
    path: "a.md",
    limit: 5,
    minScore: 0,
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "b.md");
  assert.equal(out[1].path, "c.md");
});

test("relatedNotes: applies minScore filter", async () => {
  const rows = [
    { path: "a.md", title: "A", body: "alpha", _score: 1 },
    { path: "b.md", title: "B", body: "beta", _score: 0.8 },
    { path: "c.md", title: "C", body: "gamma", _score: 0.3 },
  ];
  const out = await relatedNotes({
    vaultIndex: fakeIndex(rows),
    path: "a.md",
    limit: 5,
    minScore: 0.5,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, "b.md");
});

test("relatedNotes: caps at limit and orders by score desc", async () => {
  const rows = [
    { path: "a.md", title: "A", body: "alpha" },
    { path: "b.md", title: "B", body: "beta", _score: 0.5 },
    { path: "c.md", title: "C", body: "gamma", _score: 0.9 },
    { path: "d.md", title: "D", body: "delta", _score: 0.7 },
  ];
  const out = await relatedNotes({
    vaultIndex: fakeIndex(rows),
    path: "a.md",
    limit: 2,
    minScore: 0,
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "c.md");
  assert.equal(out[1].path, "d.md");
});
