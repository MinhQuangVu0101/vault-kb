import test from "node:test";
import assert from "node:assert/strict";

import { createStats } from "../src/stats.js";

test("recordIngest captures skip breakdown and counts", () => {
  const stats = createStats();
  stats.recordIngest({
    indexedAt: "2026-04-14T00:00:00Z",
    indexedNotes: 10,
    scannedMarkdownFiles: 20,
    skipped: { missingAccess: 1, explicitFalse: 2, hardExcluded: 3, parseError: 4 },
  });
  const snap = stats.snapshot();
  assert.equal(snap.indexed, 10);
  assert.equal(snap.scannedMarkdownFiles, 20);
  assert.deepEqual(snap.skipped, { missingAccess: 1, explicitFalse: 2, hardExcluded: 3, parseError: 4 });
  assert.equal(snap.lastIngest, "2026-04-14T00:00:00Z");
});

test("recordIngest defaults missing skip fields to 0", () => {
  const stats = createStats();
  stats.recordIngest({ indexedNotes: 5 });
  const snap = stats.snapshot();
  assert.deepEqual(snap.skipped, { missingAccess: 0, explicitFalse: 0, hardExcluded: 0, parseError: 0 });
  assert.ok(snap.lastIngest);
});

test("pushError keeps a ring buffer of 20 most recent errors", () => {
  const stats = createStats();
  for (let i = 0; i < 25; i += 1) {
    stats.pushError({ tool: "kb_read", path: `p${i}`, message: `err ${i}` });
  }
  const snap = stats.snapshot();
  assert.equal(snap.recentErrors.length, 20);
  assert.equal(snap.recentErrors[0].path, "p24");
  assert.equal(snap.recentErrors[19].path, "p5");
  assert.equal(snap.toolCalls.errors, 25);
});

test("recordToolCall increments per-tool counts", () => {
  const stats = createStats();
  stats.recordToolCall("kb_read");
  stats.recordToolCall("kb_read");
  stats.recordToolCall("kb_search");
  const snap = stats.snapshot();
  assert.equal(snap.toolCalls.total, 3);
  assert.equal(snap.toolCalls.byTool.kb_read, 2);
  assert.equal(snap.toolCalls.byTool.kb_search, 1);
});

test("snapshot returns a copy, not a live reference", () => {
  const stats = createStats();
  stats.pushError({ tool: "x", message: "m" });
  const snap1 = stats.snapshot();
  stats.pushError({ tool: "y", message: "m2" });
  assert.equal(snap1.recentErrors.length, 1);
});
