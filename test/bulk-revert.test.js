import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import matter from "gray-matter";

import { stableStringify, changedKeys } from "../src/bulk.js";
import { runBulkUpdate, nextRevertId, listBundles } from "../src/bulk.js";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkConfig(vaultRoot) {
  return { vaultRoot, hardExcludedFolders: [".obsidian"], hardExcludedFoldersLower: [".obsidian"] };
}

function writeNote(vaultRoot, rel, fm, body = "body") {
  const abs = path.join(vaultRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, matter.stringify(body, fm));
}

test("stableStringify is order-insensitive for object keys", () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});

test("stableStringify is order-sensitive for arrays", () => {
  assert.notEqual(stableStringify(["a", "b"]), stableStringify(["b", "a"]));
});

test("stableStringify handles nested objects without false diff", () => {
  assert.equal(
    stableStringify({ x: { p: 1, q: 2 } }),
    stableStringify({ x: { q: 2, p: 1 } }),
  );
});

test("changedKeys reports only differing keys", () => {
  const before = { status: "draft", area: "health" };
  const after = { status: "active", area: "health" };
  assert.deepEqual(changedKeys(before, after), ["status"]);
});

test("changedKeys reports added and removed keys", () => {
  assert.deepEqual(changedKeys({}, { tags: ["x"] }).sort(), ["tags"]);
  assert.deepEqual(changedKeys({ old: 1 }, {}).sort(), ["old"]);
});

test("stableStringify distinguishes different Date values", () => {
  const d1 = new Date("2024-01-15");
  const d2 = new Date("2024-02-20");
  assert.notEqual(stableStringify(d1), stableStringify(d2));
});

test("changedKeys detects changes to date-valued fields", () => {
  const d1 = new Date("2024-01-15");
  const d2 = new Date("2024-02-20");
  const before = { created: d1 };
  const after = { created: d2 };
  assert.deepEqual(changedKeys(before, after), ["created"]);
});

test("stableStringify serializes Date identically to its ISO string", () => {
  const d = new Date("2024-01-15T00:00:00.000Z");
  const isoString = d.toISOString();
  assert.equal(stableStringify(d), stableStringify(isoString));
});

test("apply writes a schema-2 bundle with id, createdAt, vaultRoot, and after", () => {
  const v = tmpDir("vault-kb-fmt-");
  const reverts = tmpDir("vault-kb-reverts-");
  writeNote(v, "a.md", { "ai-access": true, status: "draft" });
  const result = runBulkUpdate({
    config: mkConfig(v),
    match: {},
    ops: { setFields: { status: "archived" } },
    apply: true,
    revertDir: reverts,
  });
  const bundle = JSON.parse(fs.readFileSync(result.revertFile, "utf8"));
  assert.equal(bundle.schema, 2);
  assert.equal(bundle.vaultRoot, v);
  assert.match(bundle.id, /^[0-9TZ-]+$/);
  assert.ok(bundle.createdAt);
  assert.equal(bundle.entries[0].frontmatter.status, "draft"); // before
  assert.equal(bundle.entries[0].after.status, "archived");    // post-edit
  assert.ok(result.revertFile.startsWith(reverts)); // never touched the real cache
});

test("nextRevertId suffixes past existing bundle files", () => {
  const seen = new Set(["/d/revert-ID.json", "/d/revert-ID-1.json"]);
  assert.equal(nextRevertId("/d", "ID", (f) => seen.has(f)), "ID-2");
  assert.equal(nextRevertId("/d", "FRESH", () => false), "FRESH");
});

test("listBundles returns empty for a missing dir", () => {
  const missing = path.join(os.tmpdir(), "vault-kb-nope-" + process.pid);
  assert.deepEqual(listBundles(missing), []);
});

test("listBundles reads metadata and sorts by id ascending", () => {
  const reverts = tmpDir("vault-kb-list-");
  fs.writeFileSync(path.join(reverts, "revert-2026-01-01T00-00-00-000Z.json"),
    JSON.stringify({ schema: 2, id: "2026-01-01T00-00-00-000Z", createdAt: "2026-01-01T00:00:00.000Z", vaultRoot: "/v", entries: [{ path: "a.md", frontmatter: {}, after: {} }] }));
  fs.writeFileSync(path.join(reverts, "revert-2026-02-01T00-00-00-000Z.json"),
    JSON.stringify({ schema: 2, id: "2026-02-01T00-00-00-000Z", createdAt: "2026-02-01T00:00:00.000Z", vaultRoot: "/v", entries: [] }));
  const bundles = listBundles(reverts);
  assert.equal(bundles.length, 2);
  assert.equal(bundles[0].id, "2026-01-01T00-00-00-000Z");
  assert.equal(bundles[1].id, "2026-02-01T00-00-00-000Z");
  assert.equal(bundles[0].notes, 1);
  assert.equal(bundles[0].vaultRoot, "/v");
});

test("listBundles marks a corrupt bundle instead of throwing", () => {
  const reverts = tmpDir("vault-kb-corrupt-");
  fs.writeFileSync(path.join(reverts, "revert-bad.json"), "{ not json");
  const bundles = listBundles(reverts);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].corrupt, true);
});
