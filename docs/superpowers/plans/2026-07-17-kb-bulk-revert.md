# kb_bulk_revert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `kb_bulk_revert` MCP tool that restores note frontmatter from the revert bundles `kb_bulk_update` already writes, with field-level restore, drift detection, and vault isolation.

**Architecture:** All file/bundle logic lives in `src/bulk.js` as pure functions (`stableStringify`, `changedKeys`, `writeRevertBundle` v2, `listBundles`, `runBulkRevert`). The MCP glue in `src/index.js` registers the tool and re-indexes restored notes, mirroring how `kb_bulk_update` is wired. Revert is field-level: it only rewrites the frontmatter keys the original bulk edit changed, so later edits to other keys always survive.

**Tech Stack:** Node >= 20, ESM, `gray-matter` for frontmatter, `node:test`, `node:assert/strict`. No new dependencies.

## Global Constraints

- Node >= 20, plain-JS ESM (no TypeScript syntax; type safety via JSDoc + `tsc` checkJs).
- No em dashes (`-`) in any output, code, comments, commits, or docs. Use `-`, `,`, `:`, or parentheses.
- Type safety is enforced: `npm run typecheck` must pass (checkJs over JSDoc). Annotate new exported functions with JSDoc param/return types.
- Tests must never write into the real `~/.cache/vault-kb/reverts/`; always pass a `revertDir` temp dir.
- Bundle id format: sanitized ISO timestamp, chars `[0-9TZ-]` only. `frontmatter` key in a bundle entry always means the pre-edit ("before") state.
- Commit after every task. Co-author trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

Spec: `docs/superpowers/specs/2026-07-17-kb-bulk-revert-design.md`.

---

## File Structure

- `src/bulk.js` (modify): add `stableStringify`, `changedKeys`, `listBundles`, `runBulkRevert`; extend `writeRevertBundle` and `runBulkUpdate`.
- `src/index.js` (modify): import `runBulkRevert`, register the `kb_bulk_revert` tool, re-ingest restored notes.
- `test/bulk-revert.test.js` (create): full suite for the new logic.
- `test/bulk.test.js` (modify): point the apply test's `revertDir` at a temp dir; assert the new schema-2 fields.
- `CHANGELOG.md` (modify): Unreleased -> Added.
- `README.md` (modify): add a tool-table row and update the write-tools note.

---

### Task 1: Stable equality helpers

**Files:**
- Modify: `src/bulk.js` (add two exported helpers near the top, after the imports)
- Test: `test/bulk-revert.test.js` (create)

**Interfaces:**
- Produces: `stableStringify(value): string` - canonical JSON with recursively sorted object keys (arrays keep order). `changedKeys(before: object, after: object): string[]` - keys whose values differ by `stableStringify`.

- [ ] **Step 1: Write the failing test**

Create `test/bulk-revert.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { stableStringify, changedKeys } from "../src/bulk.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bulk-revert.test.js`
Expected: FAIL with `stableStringify` / `changedKeys` not exported (SyntaxError or undefined import).

- [ ] **Step 3: Write minimal implementation**

In `src/bulk.js`, after the existing `import { normalizeRelativeVaultPath } from "./config.js";` line and before `const REVERT_DIR = ...`, add:

```js
/**
 * Canonical JSON: object keys sorted recursively, array order preserved.
 * @param {any} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  // gray-matter parses unquoted YAML dates into Date objects. typeof is
  // "object" and Object.keys() is empty, so without this every Date would
  // collapse to "{}". JSON.stringify's form also makes a Date compare equal
  // to its post-round-trip ISO string, which is how bundles store it.
  if (value instanceof Date) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Keys whose values differ between two frontmatter objects (by stableStringify).
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @returns {string[]}
 */
export function changedKeys(before, after) {
  const b = before ?? {};
  const a = after ?? {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out = [];
  for (const k of keys) {
    if (stableStringify(b[k]) !== stableStringify(a[k])) out.push(k);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bulk-revert.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/bulk.js test/bulk-revert.test.js
git commit -m "feat(bulk): add stableStringify + changedKeys helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Schema-2 revert bundles

**Files:**
- Modify: `src/bulk.js` (`writeRevertBundle`, `runBulkUpdate`)
- Modify: `test/bulk.test.js` (apply test: temp `revertDir`, assert new fields)
- Test: `test/bulk-revert.test.js` (add a bundle-format test)

**Interfaces:**
- Consumes: `stableStringify` (not needed here), the existing `changes` array in `runBulkUpdate` which already carries `after: nextData`.
- Produces: `nextRevertId(revertDir, baseId, existsFn?): string` (pure id-collision resolver). `writeRevertBundle(entries, { vaultRoot, revertDir }): string` writing `{ schema: 2, id, createdAt, vaultRoot, entries }` with exclusive create + collision suffix. `runBulkUpdate` gains a `revertDir` option and records `after` per entry.

- [ ] **Step 1: Write the failing test**

Add these imports to the top import block of `test/bulk-revert.test.js` (alongside the Task 1 imports), then add the helpers and tests below:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";

import { runBulkUpdate, nextRevertId } from "../src/bulk.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bulk-revert.test.js`
Expected: FAIL - `nextRevertId` is not exported, `revertDir` is ignored (bundle written to `~/.cache/...`, so `startsWith(reverts)` fails), and `bundle.schema` / `bundle.entries[0].after` are undefined.

- [ ] **Step 3: Rewrite `writeRevertBundle` and add `nextRevertId`**

In `src/bulk.js`, replace the existing `writeRevertBundle` function with the following two functions:

```js
/**
 * First `revert-<id>.json` name not already present, suffixing `-1`, `-2`, ...
 * Pure so the collision path is deterministically testable.
 * @param {string} revertDir
 * @param {string} baseId
 * @param {(file: string) => boolean} [existsFn]
 * @returns {string}
 */
export function nextRevertId(revertDir, baseId, existsFn = (f) => fs.existsSync(f)) {
  let id = baseId;
  let counter = 0;
  while (existsFn(path.join(revertDir, `revert-${id}.json`))) {
    counter += 1;
    id = `${baseId}-${counter}`;
  }
  return id;
}

/**
 * @param {Array<{ path: string, frontmatter: object, after: object }>} entries
 * @param {{ vaultRoot: string, revertDir?: string }} opts
 * @returns {string} absolute path to the written bundle
 */
function writeRevertBundle(entries, { vaultRoot, revertDir = REVERT_DIR }) {
  fs.mkdirSync(revertDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const baseId = createdAt.replace(/[:.]/g, "-");
  let id = nextRevertId(revertDir, baseId);
  for (;;) {
    const file = path.join(revertDir, `revert-${id}.json`);
    try {
      const fd = fs.openSync(file, "wx"); // exclusive: atomic backstop against a race
      try {
        const bundle = { schema: 2, id, createdAt, vaultRoot, entries };
        fs.writeFileSync(fd, JSON.stringify(bundle, null, 2));
      } finally {
        fs.closeSync(fd);
      }
      return file;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        id = nextRevertId(revertDir, baseId);
        continue;
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Update `runBulkUpdate` to pass `revertDir`, `vaultRoot`, and `after`**

In `src/bulk.js`, update the JSDoc and signature of `runBulkUpdate` to add `revertDir`:

```js
/**
 * @param {{
 *   config?: any,
 *   match?: { paths?: string[], folder?: string, tag?: string, frontmatter?: Record<string, any> },
 *   ops?: { addTags?: string[], removeTags?: string[], setFields?: Record<string, any>, unsetFields?: string[], setAccess?: boolean },
 *   apply?: boolean,
 *   logger?: any,
 *   revertDir?: string,
 * }} [opts]
 */
export function runBulkUpdate({ config, match = {}, ops = {}, apply = false, logger = null, revertDir = undefined } = {}) {
```

Then change the revert-bundle block (currently lines that build `revertEntries` and call `writeRevertBundle`) to include `after` and pass the options:

```js
  const revertEntries = changes.map(({ path: p, before, after }) => ({ path: p, frontmatter: before, after }));
  const revertFile = revertEntries.length
    ? writeRevertBundle(revertEntries, { vaultRoot: config.vaultRoot, revertDir })
    : null;
```

- [ ] **Step 5: Update the existing bulk apply test to stop polluting the cache**

In `test/bulk.test.js`, the test `"apply writes changes and creates a revert bundle"` currently calls `runBulkUpdate` without `revertDir`. Add a temp reverts dir and pass it:

```js
test("apply writes changes and creates a revert bundle", () => {
  const v = tmpVault();
  const reverts = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-reverts-"));
  write(v, "a.md", { "ai-access": true, status: "draft" });
  const result = runBulkUpdate({
    config: mkConfig(v),
    match: {},
    ops: { setFields: { status: "archived" } },
    apply: true,
    revertDir: reverts,
  });
  assert.equal(result.applied, true);
  assert.equal(read(v, "a.md").status, "archived");
  assert.ok(fs.existsSync(result.revertFile));
  const bundle = JSON.parse(fs.readFileSync(result.revertFile, "utf8"));
  assert.equal(bundle.entries[0].path, "a.md");
  assert.equal(bundle.entries[0].frontmatter.status, "draft");
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/bulk-revert.test.js test/bulk.test.js`
Expected: PASS (all bulk + bulk-revert tests).

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/bulk.js test/bulk.test.js test/bulk-revert.test.js
git commit -m "feat(bulk): write schema-2 revert bundles with vault identity + after

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Enumerate bundles

**Files:**
- Modify: `src/bulk.js` (add `listBundles`)
- Test: `test/bulk-revert.test.js`

**Interfaces:**
- Produces: `listBundles(revertDir?): Array<{ id, file, schema, vaultRoot, createdAt, notes, corrupt? }>` sorted by id ascending. Missing dir returns `[]`. Corrupt bundle files are marked `corrupt: true`, never throw.

- [ ] **Step 1: Write the failing test**

Add to `test/bulk-revert.test.js`:

```js
import { listBundles } from "../src/bulk.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bulk-revert.test.js`
Expected: FAIL - `listBundles` not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/bulk.js` (after `writeRevertBundle`):

```js
/**
 * Enumerate revert bundles by basename. Never throws on a corrupt sibling.
 * @param {string} [revertDir]
 * @returns {Array<{ id: string, file: string, schema: number|null, vaultRoot: string|null, createdAt: string|null, notes: number, corrupt?: boolean }>}
 */
export function listBundles(revertDir = REVERT_DIR) {
  let files;
  try {
    files = fs.readdirSync(revertDir).filter((f) => /^revert-.*\.json$/.test(f));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const bundles = [];
  for (const f of files) {
    const stem = f.replace(/^revert-/, "").replace(/\.json$/, "");
    const file = path.join(revertDir, f);
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      bundles.push({
        id: typeof data.id === "string" ? data.id : stem,
        file,
        schema: typeof data.schema === "number" ? data.schema : 1,
        vaultRoot: typeof data.vaultRoot === "string" ? data.vaultRoot : null,
        createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
        notes: Array.isArray(data.entries) ? data.entries.length : 0,
      });
    } catch {
      bundles.push({ id: stem, file, schema: null, vaultRoot: null, createdAt: null, notes: 0, corrupt: true });
    }
  }
  bundles.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return bundles;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bulk-revert.test.js`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/bulk.js test/bulk-revert.test.js
git commit -m "feat(bulk): add listBundles enumerator

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: runBulkRevert - dry-run planning

**Files:**
- Modify: `src/bulk.js` (add `runBulkRevert`, dry-run path)
- Test: `test/bulk-revert.test.js`

**Interfaces:**
- Consumes: `stableStringify`, `changedKeys`, `listBundles`, `normalizeRelativeVaultPath`, `matter`.
- Produces: `runBulkRevert({ config, bundleId?, apply?, force?, revertDir?, logger? }): object`. Dry-run returns `{ applied:false, bundleId, vaultMatch, driftCheck, willRestore, drifted, missing, unreadable, availableBundles }` (or an empty-case object with `message`). Field-level: only keys in K (the bulk-changed keys) are planned; drift = a K key whose current value differs from the bundle's recorded `after`.

- [ ] **Step 1: Write the failing tests**

Add `runBulkRevert` to the top import block, then add the helper and tests. These build a real bundle via `runBulkUpdate`, then preview a revert:

```js
// add to the existing "../src/bulk.js" import at the top of the file:
//   import { runBulkUpdate, nextRevertId, listBundles, runBulkRevert } from "../src/bulk.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/bulk-revert.test.js`
Expected: FAIL - `runBulkRevert` not exported.

- [ ] **Step 3: Write the dry-run implementation**

Add to `src/bulk.js` (after `listBundles`):

```js
const BUNDLE_ID_RE = /^[0-9TZ-]+$/;

/**
 * @param {{
 *   config?: any,
 *   bundleId?: string,
 *   apply?: boolean,
 *   force?: boolean,
 *   revertDir?: string,
 *   logger?: any,
 * }} [opts]
 */
export function runBulkRevert({ config, bundleId, apply = false, force = false, revertDir = undefined, logger = null } = {}) {
  const vaultRoot = config.vaultRoot;
  const dir = revertDir ?? REVERT_DIR;
  const all = listBundles(dir);
  const forVault = all.filter((b) => b.schema === 2 && b.vaultRoot === vaultRoot && !b.corrupt);
  const availableBundles = forVault.map((b) => ({ id: b.id, createdAt: b.createdAt, notes: b.notes }));

  if (bundleId !== undefined && bundleId !== null) {
    if (!BUNDLE_ID_RE.test(String(bundleId))) {
      throw new Error(`Invalid bundleId: ${bundleId}`);
    }
  }

  // Select the bundle: search enumerated basenames, never build a path from input.
  let chosen;
  if (bundleId) {
    chosen = all.find((b) => b.id === String(bundleId));
    if (!chosen) throw new Error(`No revert bundle with id ${bundleId}`);
  } else {
    if (forVault.length === 0) {
      return {
        applied: false, bundleId: null, vaultMatch: true, driftCheck: "available",
        willRestore: [], drifted: [], missing: [], unreadable: [],
        availableBundles, message: "No revert bundles for this vault.",
      };
    }
    chosen = forVault[forVault.length - 1]; // newest by ascending id sort
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(chosen.file, "utf8"));
  } catch (err) {
    throw new Error(`Revert bundle ${chosen.id} is unreadable: ${String(err?.message ?? err)}`);
  }
  if (!Array.isArray(data.entries)) throw new Error(`Revert bundle ${chosen.id} has no entries`);

  const driftCheck = data.entries.every((e) => e && typeof e === "object" && "after" in e)
    ? "available" : "unavailable";
  const bundleVaultRoot = typeof data.vaultRoot === "string" ? data.vaultRoot : null;
  const vaultMatch = bundleVaultRoot === null ? null : bundleVaultRoot === vaultRoot;

  const willRestore = [];
  const drifted = [];
  const missing = [];
  const unreadable = [];
  const restorePlans = []; // { abs, rel, current, nextData, content }

  for (const entry of data.entries) {
    const rawRel = entry && entry.path;
    let safeRel;
    try {
      safeRel = normalizeRelativeVaultPath(rawRel);
    } catch {
      unreadable.push({ path: String(rawRel), error: "path escapes vault root" });
      continue;
    }
    const abs = path.resolve(vaultRoot, ...safeRel.split("/"));
    const rootResolved = path.resolve(vaultRoot);
    if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
      unreadable.push({ path: safeRel, error: "path escapes vault root" });
      continue;
    }
    if (!fs.existsSync(abs)) { missing.push(safeRel); continue; }

    let parsed;
    try {
      parsed = matter(fs.readFileSync(abs, "utf8"));
    } catch (err) {
      unreadable.push({ path: safeRel, error: String(err?.message ?? err) });
      continue;
    }
    const current = parsed.data ?? {};
    const before = entry.frontmatter ?? {};
    const hasAfter = "after" in entry;
    const after = hasAfter ? (entry.after ?? {}) : null;

    let K;
    let next;
    let driftedKeys = [];
    if (hasAfter) {
      K = changedKeys(before, after);
      driftedKeys = K.filter((k) => stableStringify(current[k]) !== stableStringify(after[k]));
      next = { ...current };
      for (const k of K) {
        if (k in before) next[k] = before[k];
        else delete next[k];
      }
    } else {
      // v1 blind restore: replace the whole frontmatter with the recorded before.
      next = { ...before };
      K = changedKeys(current, next);
    }

    if (driftedKeys.length > 0) {
      drifted.push({ path: safeRel, keys: driftedKeys });
      if (!force) continue;
    }

    const diff = {};
    for (const k of K) {
      const a = current[k];
      const b = k in next ? next[k] : undefined;
      if (stableStringify(a) !== stableStringify(b)) {
        diff[k] = { before: a ?? null, after: b ?? null };
      }
    }
    if (Object.keys(diff).length === 0) continue;
    willRestore.push({ path: safeRel, diff });
    restorePlans.push({ abs, rel: safeRel, current, nextData: next, content: parsed.content });
  }

  const view = {
    applied: false, bundleId: chosen.id, vaultMatch, driftCheck,
    willRestore, drifted, missing, unreadable, availableBundles,
  };
  return view;
}
```

Note: `restorePlans` is unused in the dry-run return but is consumed by the apply path added in Task 5. Leave it in place.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/bulk-revert.test.js`
Expected: PASS (all dry-run tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0. (If tsc warns that `restorePlans` is declared but its value is never read, that is expected until Task 5; if it errors, add a temporary `void restorePlans;` before the `const view` line and remove it in Task 5. checkJs with `strict:false` does not error on unused locals, so no change should be needed.)

```bash
git add src/bulk.js test/bulk-revert.test.js
git commit -m "feat(bulk): runBulkRevert dry-run planning (field-level, drift, isolation)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: runBulkRevert - apply, guards, redo bundle

**Files:**
- Modify: `src/bulk.js` (`runBulkRevert` apply path)
- Test: `test/bulk-revert.test.js`

**Interfaces:**
- Consumes: the `view` and `restorePlans` from Task 4.
- Produces: apply path returns `{ ...view, applied:true, revertFile, restored: string[] }`. Guards: vault mismatch throws on apply; `driftCheck === "unavailable"` (v1) requires `force`; a v1 bundle (no `vaultRoot`) requires `force`. The pre-revert bundle is written before any note file, so the revert is itself undoable.

- [ ] **Step 1: Write the failing tests**

Add to `test/bulk-revert.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/bulk-revert.test.js`
Expected: FAIL - apply path not implemented; `runBulkRevert` still returns `applied:false` and never writes.

- [ ] **Step 3: Replace the dry-run `return view;` with the apply-aware block**

In `src/bulk.js`, find the end of `runBulkRevert`:

```js
  const view = {
    applied: false, bundleId: chosen.id, vaultMatch, driftCheck,
    willRestore, drifted, missing, unreadable, availableBundles,
  };
  return view;
}
```

Replace `return view;` (only that line) with:

```js
  if (!apply) return view;

  // Apply-time guards.
  if (bundleVaultRoot !== null && bundleVaultRoot !== vaultRoot) {
    throw new Error(`Bundle ${chosen.id} belongs to a different vault (${bundleVaultRoot}); refusing to apply.`);
  }
  if (bundleVaultRoot === null && !force) {
    throw new Error(`Bundle ${chosen.id} has no vault identity; re-run with force:true to apply it here.`);
  }
  if (driftCheck === "unavailable" && !force) {
    throw new Error(`Bundle ${chosen.id} predates drift tracking; re-run with force:true for a blind restore.`);
  }

  // Write the pre-revert (redo) bundle FIRST so the revert is itself undoable.
  const redoEntries = restorePlans.map(({ rel, current, nextData }) => ({
    path: rel, frontmatter: current, after: nextData,
  }));
  const revertFile = redoEntries.length
    ? writeRevertBundle(redoEntries, { vaultRoot, revertDir: dir })
    : null;

  let written = 0;
  for (const { abs, nextData, content } of restorePlans) {
    fs.writeFileSync(abs, matter.stringify(content, nextData), "utf8");
    written += 1;
  }

  logger?.info({ event: "bulk_revert", bundleId: chosen.id, restored: written, revertFile });

  return { ...view, applied: true, revertFile, restored: willRestore.map((w) => w.path) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/bulk-revert.test.js`
Expected: PASS (all apply + guard tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/bulk.js test/bulk-revert.test.js
git commit -m "feat(bulk): runBulkRevert apply path with guards and redo bundle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Register the kb_bulk_revert MCP tool

**Files:**
- Modify: `src/index.js` (import, tool registration, re-ingest)

**Interfaces:**
- Consumes: `runBulkRevert` from `./bulk.js`; `wrapTool`, `toolText`, `config`, `vaultIndex`, `logger`, `z` already in scope.
- Produces: an MCP tool `kb_bulk_revert({ bundleId?, apply?, force? })`.

- [ ] **Step 1: Add the import**

In `src/index.js`, change:

```js
import { runBulkUpdate } from "./bulk.js";
```
to:
```js
import { runBulkUpdate, runBulkRevert } from "./bulk.js";
```

- [ ] **Step 2: Register the tool after kb_bulk_update**

In `src/index.js`, immediately after the `kb_bulk_update` registration block (the `}));` that closes `wrapTool("kb_bulk_update", ...)`), insert:

```js
server.registerTool("kb_bulk_revert", {
  title: "Revert a bulk frontmatter update",
  description: "Undo a kb_bulk_update by restoring frontmatter from its revert bundle. Reverts the newest bundle for this vault by default, or a specific one via bundleId. Field-level: only the keys the bulk edit changed are restored, so later edits to other keys survive. Dry-run unless apply=true. Notes changed since the edit are skipped and reported as drifted unless force=true. Writes a new revert bundle so the revert is itself undoable.",
  inputSchema: {
    bundleId: z.string().optional(),
    apply: z.boolean().optional(),
    force: z.boolean().optional(),
  },
}, wrapTool("kb_bulk_revert", async ({ bundleId, apply, force }) => {
  const result = runBulkRevert({ config, bundleId, apply: Boolean(apply), force: Boolean(force), logger });
  if (apply && result.restored?.length) {
    for (const p of result.restored) vaultIndex.ingestOne(p);
  }
  return toolText(JSON.stringify(result, null, 2));
}));
```

- [ ] **Step 3: Syntax-check and typecheck**

Run: `node --check src/index.js && npm run typecheck`
Expected: exit 0, no output from `node --check`.

- [ ] **Step 4: Verify the tool is registered by the smoke run**

Run: `VAULT_KB_VAULT_PATH="$(pwd)/test/fixture/demo-vault" npm run smoke`
Expected: smoke connects and lists tools without error (exit 0). `kb_bulk_revert` is now among the registered tools.

- [ ] **Step 5: Commit**

```bash
git add src/index.js
git commit -m "feat(mcp): register kb_bulk_revert tool

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Docs and full verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`

- [ ] **Step 1: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]`, add an `### Added` section above the existing `### Fixed` (create `### Added` if absent):

```markdown
### Added
- `kb_bulk_revert` - undo a `kb_bulk_update` by restoring frontmatter from its revert bundle. Reverts the newest bundle for the current vault by default, or a specific one via `bundleId`; dry-run unless `apply: true`. Restore is field-level (only the keys the bulk edit changed), so later edits to other keys survive. Notes whose frontmatter changed since the edit are skipped and reported as `drifted` unless `force: true`. Bundles now record the vault root and cannot be applied to a different vault, and each revert writes its own bundle so it is itself undoable.
```

- [ ] **Step 2: Add the README tool-table row**

In `README.md`, after the `| \`kb_bulk_update\` | ... |` row (around line 139), add:

```markdown
| `kb_bulk_revert` | Undo a `kb_bulk_update` from its revert bundle (field-level, dry-run by default) |
```

- [ ] **Step 3: Update the write-tools note**

In `README.md`, change the line (around line 32):

```markdown
- The MCP server is read-mostly: write tools (`kb_bulk_update`) require explicit `apply: true` and always produce a revert bundle.
```
to:
```markdown
- The MCP server is read-mostly: write tools (`kb_bulk_update`, `kb_bulk_revert`) require explicit `apply: true` and always produce a revert bundle, so every write is undoable.
```

- [ ] **Step 4: Full health run**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests pass (138 existing + the new bulk-revert suite, 0 fail).

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: changelog + README for kb_bulk_revert

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Push**

```bash
git push origin main
```
Expected: push succeeds; CI (typecheck + test + smoke on Node 20 and 22) goes green.

---

## Notes for the implementer

- The `frontmatter` key inside a bundle entry always means the pre-edit ("before") state. Do not rename it; the existing `bulk.test.js` and any on-disk bundles depend on it.
- `runBulkRevert` never re-indexes. The `kb_bulk_revert` handler in `index.js` owns the `vaultIndex.ingestOne` loop, matching `kb_bulk_update`. Keep indexing out of `bulk.js`.
- Every test passes an explicit `revertDir` temp dir. A test that omits it would write into the real `~/.cache/vault-kb/reverts/` - treat that as a bug.
- Restore equality is parsed-frontmatter equality via `gray-matter`, not byte-for-byte YAML. Do not assert on raw file text in round-trip tests; parse and compare `.data`.
