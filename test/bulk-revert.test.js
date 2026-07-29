import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import matter from "gray-matter";

import { stableStringify, changedKeys } from "../src/bulk.js";
import { runBulkUpdate, nextRevertId, listBundles, runBulkRevert } from "../src/bulk.js";

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

test("listBundles reports a legacy v1 bundle as schema 1", () => {
  const reverts = tmpDir("vault-kb-v1-legacy-");
  const v1Bundle = { ts: "2025-05-01T00-00-00-000Z", entries: [{ path: "a.md", frontmatter: { status: "orig" } }] };
  fs.writeFileSync(path.join(reverts, "revert-v1-legacy-id.json"), JSON.stringify(v1Bundle));
  const bundles = listBundles(reverts);
  assert.equal(bundles.length, 1);
  const entry = bundles[0];
  assert.equal(entry.schema, 1);
  assert.equal(entry.id, "v1-legacy-id");
  assert.equal(entry.vaultRoot, null);
  assert.equal(entry.createdAt, null);
  assert.equal(entry.notes, 1);
  assert.equal(entry.corrupt, undefined);
});

function bulkThenSetup(fm, ops) {
  const v = tmpDir("vault-kb-rev-");
  const reverts = tmpDir("vault-kb-rev-store-");
  writeNote(v, "a.md", fm);
  const up = runBulkUpdate({ config: mkConfig(v), match: {}, ops, apply: true, revertDir: reverts });
  return { v, reverts, up };
}

test("dry-run previews a field-level restore without writing", () => {
  const { v, reverts } = bulkThenSetup({ status: "draft", area: "health" }, { setFields: { status: "archived" } });
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.equal(res.applied, false);
  assert.equal(res.driftCheck, "available");
  assert.equal(res.willRestore.length, 1);
  assert.equal(res.willRestore[0].path, "a.md");
  assert.deepEqual(res.willRestore[0].diff.status, { before: "archived", after: "draft" });
  assert.equal(matter(fs.readFileSync(path.join(v, "a.md"), "utf8")).data.status, "archived"); // unchanged
});

test("dry-run flags drift on a bulk-changed key and excludes it from willRestore", () => {
  const { v, reverts } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  // Change the same key after the bulk edit:
  writeNote(v, "a.md", { status: "in-progress" });
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.equal(res.drifted.length, 1);
  assert.deepEqual(res.drifted[0].keys, ["status"]);
  assert.equal(res.willRestore.length, 0);
});

test("dry-run with force includes drifted notes in willRestore", () => {
  const { v, reverts } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  writeNote(v, "a.md", { status: "in-progress" });
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts, force: true });
  assert.equal(res.drifted.length, 1);
  assert.equal(res.willRestore.length, 1);
});

test("dry-run reports a missing note", () => {
  const { v, reverts } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  fs.rmSync(path.join(v, "a.md"));
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.deepEqual(res.missing, ["a.md"]);
  assert.equal(res.willRestore.length, 0);
});

test("empty case: no bundles for this vault returns a message, no throw", () => {
  const v = tmpDir("vault-kb-empty-");
  const reverts = tmpDir("vault-kb-empty-store-");
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.equal(res.applied, false);
  assert.deepEqual(res.availableBundles, []);
  assert.ok(res.message);
});

test("invalid bundleId throws", () => {
  const v = tmpDir("vault-kb-badid-");
  const reverts = tmpDir("vault-kb-badid-store-");
  assert.throws(() => runBulkRevert({ config: mkConfig(v), revertDir: reverts, bundleId: "../etc" }), /Invalid bundleId/);
});

test("field-level restore preserves a later edit to an untouched key (preview)", () => {
  const { v, reverts } = bulkThenSetup({ status: "draft", area: "health" }, { setFields: { status: "archived" } });
  // Edit a DIFFERENT key after the bulk op:
  writeNote(v, "a.md", { status: "archived", area: "fitness" });
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  // status is restorable, area is untouched by revert and not flagged as drift:
  assert.equal(res.willRestore.length, 1);
  assert.ok(!("area" in res.willRestore[0].diff));
  assert.equal(res.drifted.length, 0);
});

test("dry-run reports an unreadable note instead of throwing", () => {
  const { v, reverts } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  // Corrupt the note's frontmatter so gray-matter fails to parse it:
  fs.writeFileSync(path.join(v, "a.md"), "---\nfoo: [unclosed\n---\nbody\n");
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.equal(res.unreadable.length, 1);
  assert.equal(res.unreadable[0].path, "a.md");
  assert.equal(res.willRestore.length, 0);
});

test("dry-run rejects a bundle entry whose path escapes the vault", () => {
  const v = tmpDir("vault-kb-escape-");
  const reverts = tmpDir("vault-kb-escape-store-");
  // Hand-write a v2 bundle with a traversal path:
  fs.writeFileSync(path.join(reverts, "revert-2026-01-01T00-00-00-000Z.json"),
    JSON.stringify({ schema: 2, id: "2026-01-01T00-00-00-000Z", createdAt: "2026-01-01T00:00:00.000Z", vaultRoot: v,
      entries: [{ path: "../evil.md", frontmatter: { x: 1 }, after: { x: 2 } }] }));
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.equal(res.unreadable.length, 1);
  assert.match(res.unreadable[0].error, /escapes vault root/);
  assert.equal(res.willRestore.length, 0);
});

test("default selects newest bundle; bundleId targets an older one", () => {
  const v = tmpDir("vault-kb-pick-");
  const reverts = tmpDir("vault-kb-pick-store-");
  writeNote(v, "a.md", {});
  // Two edits touching DIFFERENT keys, so reverting the older one is not drift:
  const up1 = runBulkUpdate({ config: mkConfig(v), match: {}, ops: { setFields: { a: "1" } }, apply: true, revertDir: reverts });
  const up2 = runBulkUpdate({ config: mkConfig(v), match: {}, ops: { setFields: { b: "1" } }, apply: true, revertDir: reverts });
  const oldId = JSON.parse(fs.readFileSync(up1.revertFile, "utf8")).id;
  const newId = JSON.parse(fs.readFileSync(up2.revertFile, "utf8")).id;
  assert.notEqual(oldId, newId);
  // Default picks the newest bundle (undoes the `b` edit):
  const dflt = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.equal(dflt.bundleId, newId);
  assert.ok("b" in dflt.willRestore[0].diff);
  // Explicit older id undoes the `a` edit instead:
  const older = runBulkRevert({ config: mkConfig(v), revertDir: reverts, bundleId: oldId });
  assert.equal(older.bundleId, oldId);
  assert.ok("a" in older.willRestore[0].diff);
});

test("dry-run reports vaultMatch: false for a foreign vault, true for the current vault", () => {
  // Hand-write a schema-2 bundle recorded against a DIFFERENT vault than `config`:
  const v = tmpDir("vault-kb-vaultmatch-");
  const otherVault = tmpDir("vault-kb-othervault-");
  const reverts = tmpDir("vault-kb-vaultmatch-store-");
  writeNote(v, "a.md", { status: "archived" });
  const foreignId = "2026-01-01T00-00-00-000Z";
  fs.writeFileSync(path.join(reverts, `revert-${foreignId}.json`), JSON.stringify({
    schema: 2, id: foreignId, createdAt: "2026-01-01T00:00:00.000Z", vaultRoot: otherVault,
    entries: [{ path: "a.md", frontmatter: { status: "draft" }, after: { status: "archived" } }],
  }));
  const foreign = runBulkRevert({ config: mkConfig(v), revertDir: reverts, bundleId: foreignId });
  assert.equal(foreign.vaultMatch, false);

  // bulkThenSetup records vaultRoot = the vault it just edited, so a dry-run against
  // that same vault should report a match:
  const { v: ownVault, reverts: ownReverts } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  const own = runBulkRevert({ config: mkConfig(ownVault), revertDir: ownReverts });
  assert.equal(own.vaultMatch, true);
});

test("v1 legacy bundle dry-run: driftCheck unavailable, vaultMatch null, whole-object restore diff", () => {
  const v = tmpDir("vault-kb-v1-dryrun-");
  const reverts = tmpDir("vault-kb-v1-dryrun-store-");
  writeNote(v, "a.md", { status: "archived" }); // current on-disk state left by the unrecorded edit
  const id = "2026-01-01T00-00-00-000Z";
  // Genuine v1 shape: `ts` not `id`/`createdAt`, no `schema`, no `vaultRoot`, entries have
  // `frontmatter` only (no `after`), so drift cannot be computed.
  const v1Bundle = { ts: "2026-01-01T00-00-00-000Z", entries: [{ path: "a.md", frontmatter: { status: "draft" } }] };
  fs.writeFileSync(path.join(reverts, `revert-${id}.json`), JSON.stringify(v1Bundle));
  // v1 bundles are invisible to default selection (schema !== 2), so an explicit bundleId
  // whose stem matches the filename is required to reach this bundle at all.
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts, bundleId: id });
  assert.equal(res.driftCheck, "unavailable");
  assert.equal(res.vaultMatch, null);
  assert.equal(res.willRestore.length, 1);
  assert.equal(res.willRestore[0].path, "a.md");
  assert.deepEqual(res.willRestore[0].diff.status, { before: "archived", after: "draft" });
});
