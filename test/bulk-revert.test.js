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

test("listBundles defaults a schema-2 bundle without `origin` to bulk_update", () => {
  const reverts = tmpDir("vault-kb-origin-default-");
  // Written before `origin` existed. Revert did not exist then either, so the only thing
  // that can have produced it is a bulk update.
  fs.writeFileSync(path.join(reverts, "revert-2026-01-01T00-00-00-000Z.json"),
    JSON.stringify({ schema: 2, id: "2026-01-01T00-00-00-000Z", createdAt: "2026-01-01T00:00:00.000Z", vaultRoot: "/v", entries: [] }));
  assert.equal(listBundles(reverts)[0].origin, "bulk_update");
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

test("a schema-2 bundle without `origin` is still selectable by default", () => {
  const v = tmpDir("vault-kb-noorigin-");
  const reverts = tmpDir("vault-kb-noorigin-store-");
  writeNote(v, "a.md", { status: "archived" });
  const id = "2026-01-01T00-00-00-000Z";
  fs.writeFileSync(path.join(reverts, `revert-${id}.json`), JSON.stringify({
    schema: 2, id, createdAt: "2026-01-01T00:00:00.000Z", vaultRoot: v, // no `origin`
    entries: [{ path: "a.md", frontmatter: { status: "draft" }, after: { status: "archived" } }],
  }));
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.equal(res.bundleId, id);
  assert.equal(res.willRestore.length, 1);
});

test("empty case with only revert-origin bundles names them and points at redoBundleId", () => {
  const v = tmpDir("vault-kb-redo-only-");
  const reverts = tmpDir("vault-kb-redo-only-store-");
  writeNote(v, "a.md", { status: "draft" });
  const id = "2026-01-01T00-00-00-000Z";
  fs.writeFileSync(path.join(reverts, `revert-${id}.json`), JSON.stringify({
    schema: 2, id, createdAt: "2026-01-01T00:00:00.000Z", origin: "bulk_revert", vaultRoot: v,
    entries: [{ path: "a.md", frontmatter: { status: "archived" }, after: { status: "draft" } }],
  }));
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.equal(res.bundleId, null); // not selected by default
  assert.deepEqual(res.availableBundles, []);
  assert.equal(res.redoBundleId, id); // but reachable
  assert.match(res.message, /redoBundleId/);
  // Explicit id still reaches it and previews the redo:
  const explicit = runBulkRevert({ config: mkConfig(v), revertDir: reverts, bundleId: id });
  assert.equal(explicit.bundleId, id);
  assert.deepEqual(explicit.willRestore[0].diff.status, { before: "draft", after: "archived" });
});

test("with only legacy bundles, they are listed and the message says how to reach them", () => {
  const v = tmpDir("vault-kb-legacy-only-");
  const reverts = tmpDir("vault-kb-legacy-only-store-");
  writeNote(v, "a.md", { status: "archived" });
  for (const id of ["2026-01-01T00-00-00-000Z", "2026-01-02T00-00-00-000Z"]) {
    fs.writeFileSync(path.join(reverts, `revert-${id}.json`),
      JSON.stringify({ ts: id, entries: [{ path: "a.md", frontmatter: { status: "draft" } }] }));
  }
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.equal(res.bundleId, null);
  assert.deepEqual(res.availableBundles, []);
  assert.equal(res.legacyBundlesTotal, 2);
  assert.equal(res.legacyBundles.length, 2);
  assert.equal(res.legacyBundles[0].id, "2026-01-02T00-00-00-000Z"); // newest first
  assert.equal(res.legacyBundles[0].notes, 1);
  // Not a bare "nothing to revert": the route to these bundles is in the message.
  assert.match(res.message, /bundleId/);
  assert.match(res.message, /force: true/);
});

test("availableBundles is capped at the newest 10, availableBundlesTotal keeps the true count", () => {
  const v = tmpDir("vault-kb-cap-");
  const reverts = tmpDir("vault-kb-cap-store-");
  writeNote(v, "a.md", { n: 12 });
  for (let i = 1; i <= 12; i += 1) {
    const day = String(i).padStart(2, "0");
    const id = `2026-01-${day}T00-00-00-000Z`;
    fs.writeFileSync(path.join(reverts, `revert-${id}.json`), JSON.stringify({
      schema: 2, id, createdAt: `2026-01-${day}T00:00:00.000Z`, origin: "bulk_update", vaultRoot: v,
      entries: [{ path: "a.md", frontmatter: { n: i - 1 }, after: { n: i } }],
    }));
  }
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.equal(res.availableBundlesTotal, 12);
  assert.equal(res.availableBundles.length, 10);
  assert.equal(res.availableBundles[0].id, "2026-01-12T00-00-00-000Z"); // newest first
  assert.equal(res.availableBundles[9].id, "2026-01-03T00-00-00-000Z"); // the two oldest are dropped
  assert.equal(res.bundleId, "2026-01-12T00-00-00-000Z"); // default selection unaffected by the cap
});

test("legacyBundles is capped at the newest 10, legacyBundlesTotal keeps the true count", () => {
  const v = tmpDir("vault-kb-legacy-cap-");
  const reverts = tmpDir("vault-kb-legacy-cap-store-");
  for (let i = 1; i <= 11; i += 1) {
    const day = String(i).padStart(2, "0");
    const id = `2026-02-${day}T00-00-00-000Z`;
    fs.writeFileSync(path.join(reverts, `revert-${id}.json`),
      JSON.stringify({ ts: id, entries: [{ path: "a.md", frontmatter: { status: "draft" } }] }));
  }
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.equal(res.legacyBundlesTotal, 11);
  assert.equal(res.legacyBundles.length, 10);
  assert.equal(res.legacyBundles[0].id, "2026-02-11T00-00-00-000Z");
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

test("dry-run against a foreign-vault bundle plans nothing and explains why, without throwing", () => {
  const v = tmpDir("vault-kb-foreign-dry-");
  const otherVault = tmpDir("vault-kb-foreign-other-");
  const reverts = tmpDir("vault-kb-foreign-dry-store-");
  // The same relative path exists in both vaults, which is the normal case (Inbox.md,
  // README.md). Its current value even matches the foreign bundle's `after`, so without
  // an early return the loop would report a plausible restore that apply always refuses.
  writeNote(v, "Inbox.md", { status: "archived" });
  const foreignId = "2026-01-01T00-00-00-000Z";
  fs.writeFileSync(path.join(reverts, `revert-${foreignId}.json`), JSON.stringify({
    schema: 2, id: foreignId, createdAt: "2026-01-01T00:00:00.000Z", origin: "bulk_update", vaultRoot: otherVault,
    entries: [{ path: "Inbox.md", frontmatter: { status: "draft" }, after: { status: "archived" } }],
  }));
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts, bundleId: foreignId });
  assert.equal(res.applied, false);
  assert.equal(res.vaultMatch, false);
  assert.deepEqual(res.willRestore, []);
  assert.deepEqual(res.drifted, []);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.unreadable, []);
  assert.match(res.message, /different vault/);
  assert.ok(res.message.includes(otherVault)); // names the vault it belongs to
  assert.equal(matter(fs.readFileSync(path.join(v, "Inbox.md"), "utf8")).data.status, "archived"); // untouched
  // Apply still refuses, unchanged:
  assert.throws(
    () => runBulkRevert({ config: mkConfig(v), revertDir: reverts, bundleId: foreignId, apply: true }),
    /different vault/,
  );
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

test("v1 whole-object restore clears a key added after the recorded edit", () => {
  const v = tmpDir("vault-kb-v1-wholeobj-");
  const reverts = tmpDir("vault-kb-v1-wholeobj-store-");
  // `added` is absent from the bundle's recorded frontmatter, i.e. it appeared after the
  // recorded edit. The v1 path restores the whole object, so it must be cleared; a
  // field-level restore would leave it in place.
  writeNote(v, "a.md", { status: "archived", added: "later" });
  const id = "2026-01-01T00-00-00-000Z";
  fs.writeFileSync(path.join(reverts, `revert-${id}.json`),
    JSON.stringify({ ts: id, entries: [{ path: "a.md", frontmatter: { status: "draft" } }] }));
  const dry = runBulkRevert({ config: mkConfig(v), revertDir: reverts, bundleId: id });
  assert.equal(dry.willRestore.length, 1);
  assert.deepEqual(dry.willRestore[0].diff.status, { before: "archived", after: "draft" });
  assert.deepEqual(dry.willRestore[0].diff.added, { before: "later", after: null }); // cleared
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts, bundleId: id, apply: true, force: true });
  assert.equal(res.applied, true);
  const fm = matter(fs.readFileSync(path.join(v, "a.md"), "utf8")).data;
  assert.equal(fm.status, "draft");
  assert.equal("added" in fm, false); // whole-object, not field-level
});

test("apply restores frontmatter and re-index is caller's job", () => {
  const { v, reverts } = bulkThenSetup({ status: "draft", area: "health" }, { setFields: { status: "archived" } });
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true });
  assert.equal(res.applied, true);
  assert.deepEqual(res.restored, ["a.md"]);
  assert.equal(matter(fs.readFileSync(path.join(v, "a.md"), "utf8")).data.status, "draft");
});

test("round-trip: bulk edit then revert restores exact prior values", () => {
  const { v, reverts } = bulkThenSetup({ status: "draft", area: "health", tags: ["x"] }, { setFields: { status: "archived" }, addTags: ["flagged"] });
  runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true });
  const fm = matter(fs.readFileSync(path.join(v, "a.md"), "utf8")).data;
  assert.equal(fm.status, "draft");
  assert.deepEqual(fm.tags, ["x"]);
});

test("apply writes a new schema-2 redo bundle before touching files", () => {
  const { v, reverts } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  const before = listBundles(reverts).length;
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true });
  const after = listBundles(reverts).length;
  assert.equal(after, before + 1);
  const redo = JSON.parse(fs.readFileSync(res.revertFile, "utf8"));
  assert.equal(redo.schema, 2);
  assert.equal(redo.entries[0].frontmatter.status, "archived"); // pre-revert state
  assert.equal(redo.entries[0].after.status, "draft");          // restored state
});

test("bundles record who wrote them: bulk_update from an edit, bulk_revert from a revert", () => {
  const { v, reverts, up } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  assert.equal(JSON.parse(fs.readFileSync(up.revertFile, "utf8")).origin, "bulk_update");
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true });
  assert.equal(JSON.parse(fs.readFileSync(res.revertFile, "utf8")).origin, "bulk_revert");
});

test("after an apply, the default no longer selects the redo bundle but names it as redoBundleId", () => {
  const { v, reverts, up } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  const updateId = JSON.parse(fs.readFileSync(up.revertFile, "utf8")).id;
  const applied = runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true });
  const redoId = JSON.parse(fs.readFileSync(applied.revertFile, "utf8")).id;
  assert.notEqual(redoId, updateId);
  const second = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.equal(second.bundleId, updateId);   // the redo bundle is newer but not selectable
  assert.equal(second.redoBundleId, redoId); // one explicit call away, not lost
  assert.equal(second.willRestore.length, 0);
});

test("repeating the default-argument apply does not redo the bulk edit", () => {
  const { v, reverts } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true });
  // A client retrying after an ambiguous result must not flip the vault back to the edited
  // state, which is what selecting the newly written redo bundle would do.
  const again = runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true });
  assert.deepEqual(again.restored, []);
  assert.equal(matter(fs.readFileSync(path.join(v, "a.md"), "utf8")).data.status, "draft");
});

test("an explicit redoBundleId redoes the reverted edit", () => {
  const { v, reverts } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true });
  const { redoBundleId } = runBulkRevert({ config: mkConfig(v), revertDir: reverts });
  assert.ok(redoBundleId);
  const redo = runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true, bundleId: redoBundleId });
  assert.equal(redo.applied, true);
  assert.equal(matter(fs.readFileSync(path.join(v, "a.md"), "utf8")).data.status, "archived");
});

test("force restores a drifted note", () => {
  const { v, reverts } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  writeNote(v, "a.md", { status: "in-progress" });
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true, force: true });
  assert.equal(res.applied, true);
  assert.equal(matter(fs.readFileSync(path.join(v, "a.md"), "utf8")).data.status, "draft");
});

test("apply refuses a bundle from a different vault", () => {
  const { reverts } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  const other = tmpDir("vault-kb-other-");
  writeNote(other, "a.md", { status: "archived" });
  const bundleId = listBundles(reverts)[0].id;
  assert.throws(
    () => runBulkRevert({ config: mkConfig(other), revertDir: reverts, apply: true, bundleId }),
    /different vault/,
  );
});

test("v1 bundle requires force to apply", () => {
  const v = tmpDir("vault-kb-v1-");
  const reverts = tmpDir("vault-kb-v1-store-");
  writeNote(v, "a.md", { status: "changed" });
  fs.writeFileSync(path.join(reverts, "revert-2026-01-01T00-00-00-000Z.json"),
    JSON.stringify({ ts: "2026-01-01T00-00-00-000Z", entries: [{ path: "a.md", frontmatter: { status: "orig" } }] }));
  const id = "2026-01-01T00-00-00-000Z";
  assert.throws(
    () => runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true, bundleId: id }),
    /force/,
  );
  const res = runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true, force: true, bundleId: id });
  assert.equal(res.applied, true);
  assert.equal(matter(fs.readFileSync(path.join(v, "a.md"), "utf8")).data.status, "orig");
});

test(
  "apply: when the note write fails, the redo bundle was already durably written",
  {
    skip: typeof process.getuid === "function" && process.getuid() === 0
      ? "chmod-based write failure cannot be verified as root (root bypasses permission bits)"
      : false,
  },
  () => {
    const { v, reverts } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
    const notePath = path.join(v, "a.md");
    const beforeFiles = new Set(listBundles(reverts).map((b) => b.file));
    // Readable (runBulkRevert can still build its restore plan), but not writable, so the
    // note-write step - and only that step - fails with EACCES.
    fs.chmodSync(notePath, 0o444);
    try {
      assert.throws(
        () => runBulkRevert({ config: mkConfig(v), revertDir: reverts, apply: true }),
        /EACCES/,
      );
      const afterBundles = listBundles(reverts);
      const newBundles = afterBundles.filter((b) => !beforeFiles.has(b.file));
      // The redo bundle must exist on disk despite the note write throwing: under the
      // correct ordering it is written before any note is touched, so a crash here still
      // leaves a way back.
      assert.equal(newBundles.length, 1);
      const redo = JSON.parse(fs.readFileSync(newBundles[0].file, "utf8"));
      assert.equal(redo.schema, 2);
      assert.equal(redo.entries[0].frontmatter.status, "archived"); // pre-revert state
      assert.equal(redo.entries[0].after.status, "draft");          // state the revert was about to write
    } finally {
      fs.chmodSync(notePath, 0o644); // let temp-dir cleanup remove the file
    }
  },
);

test("apply refuses a bundle from a different vault even with force: true", () => {
  const { reverts } = bulkThenSetup({ status: "draft" }, { setFields: { status: "archived" } });
  const other = tmpDir("vault-kb-other-force-");
  writeNote(other, "a.md", { status: "archived" });
  const bundleId = listBundles(reverts)[0].id;
  // Unlike the "no vault identity" and "driftCheck unavailable" guards, the cross-vault
  // guard must have no force escape: writing another vault's paths here is never safe.
  assert.throws(
    () => runBulkRevert({ config: mkConfig(other), revertDir: reverts, apply: true, force: true, bundleId }),
    /different vault/,
  );
});
