# vault-kb Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two MCP tools (`kb_overview`, `kb_tree`) plus sharpened tool descriptions so AI clients reliably consult the vault first when working in the user's notes.

**Architecture:** Two new methods on `VaultIndex` (`overview()`, `tree()`) — pure aggregations over the existing `notes.folder` column, no schema changes. Two new `registerTool()` calls in `src/index.js` following the same pattern as `kb_stats` (JSON output via `JSON.stringify`). Five existing tool descriptions get a workflow-hint line appended.

**Tech Stack:** Node.js 20+, `node:test` + `node:assert/strict`, `better-sqlite3`, `@modelcontextprotocol/sdk`, `zod`.

**Spec:** [docs/superpowers/specs/2026-05-23-vault-kb-discoverability-design.md](../specs/2026-05-23-vault-kb-discoverability-design.md)

**Repo:** `/Users/minhquangvu/Documents/dev/obsidian-plugins/vault-kb`

**Branch:** `docs/discoverability-spec` (already checked out with the spec committed)

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/vault-index.js` | modify | Add `overview()` + `tree({ path, depth })` methods alongside existing `list`/`search`/`readNote` |
| `src/index.js` | modify | Register `kb_overview` + `kb_tree` tools; append workflow hints to 5 existing tool descriptions |
| `src/smoke.js` | modify | Exercise both new tools in the MCP roundtrip smoke check |
| `test/vault-index-overview.test.js` | create | TDD coverage for `VaultIndex.overview()` |
| `test/vault-index-tree.test.js` | create | TDD coverage for `VaultIndex.tree({ path, depth })` |
| `CHANGELOG.md` | modify | User-facing release notes for the two new tools |
| `package.json` | modify | Version bump 0.2.0 → 0.3.0 (minor: backward-compatible additions) |

Each task below produces a self-contained commit. Order is bottom-up: data layer first (Tasks 1–2), MCP wiring (Tasks 3–4), description polish (Task 5), smoke integration (Task 6), release notes + version (Task 7).

---

## Task 1: Add `VaultIndex.overview()` method (TDD)

**Files:**
- Create: `test/vault-index-overview.test.js`
- Modify: `src/vault-index.js` (add method near `list()` around line 764)

**Output shape produced:**
```json
{
  "vaultRoot": "/path/to/vault",
  "indexedAt": "2026-05-23T...",
  "totalNotes": 6,
  "topLevelFolders": [
    { "path": "10 Projects", "noteCount": 3, "subfolderCount": 1 },
    { "path": "20 Reference", "noteCount": 2, "subfolderCount": 0 }
  ],
  "recentlyTouched": [
    { "path": "10 Projects/A.md", "title": "A", "updated": "2026-05-22" }
  ]
}
```

- [ ] **Step 1: Write failing test**

Create `test/vault-index-overview.test.js`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { VaultIndex } from "../src/vault-index.js";

function makeTempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-overview-"));
  const writeNote = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  // Two top-level folders. "10 Projects" has one immediate subfolder + one direct file.
  // "20 Reference" is flat.
  writeNote("10 Projects/Alpha.md",     "---\nai-access: true\ntitle: Alpha\nupdated: 2026-05-22\n---\nAlpha.");
  writeNote("10 Projects/Sub/Beta.md",  "---\nai-access: true\ntitle: Beta\nupdated: 2026-05-23\n---\nBeta.");
  writeNote("10 Projects/Sub/Gamma.md", "---\nai-access: true\ntitle: Gamma\nupdated: 2026-05-21\n---\nGamma.");
  writeNote("20 Reference/Ref1.md",     "---\nai-access: true\ntitle: Ref1\nupdated: 2026-05-20\n---\nRef1.");
  writeNote("20 Reference/Ref2.md",     "---\nai-access: true\ntitle: Ref2\nupdated: 2026-05-19\n---\nRef2.");
  return { root };
}

function mkConfig(root) {
  return {
    vaultRoot: root,
    vaultRootSource: "test",
    indexPath: path.join(root, ".data", "index.sqlite"),
    hardExcludedFolders: [],
    hardExcludedFoldersLower: [],
    defaultLimits: { search: 8, list: 25, readChars: 12000 },
    maxLimits: { search: 20, list: 100, readChars: 40000 },
  };
}

test("overview: returns vault snapshot with totals, top-level folders, recent notes", () => {
  const { root } = makeTempVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const ov = vi.overview();

  assert.equal(ov.vaultRoot, root, "vaultRoot echoes config");
  assert.ok(ov.indexedAt, "indexedAt is set after ingest");
  assert.equal(ov.totalNotes, 5, "5 notes indexed");

  assert.equal(ov.topLevelFolders.length, 2);
  assert.deepEqual(
    ov.topLevelFolders.map((f) => f.path),
    ["10 Projects", "20 Reference"],
    "sorted by noteCount desc — Projects (3) before Reference (2)",
  );
  assert.equal(ov.topLevelFolders[0].noteCount, 3, "10 Projects has 3 notes recursive");
  assert.equal(ov.topLevelFolders[0].subfolderCount, 1, "10 Projects has 1 immediate subfolder (Sub)");
  assert.equal(ov.topLevelFolders[1].subfolderCount, 0, "20 Reference has no subfolders");

  assert.ok(Array.isArray(ov.recentlyTouched));
  assert.ok(ov.recentlyTouched.length <= 5);
  assert.equal(ov.recentlyTouched[0].path, "10 Projects/Sub/Beta.md", "most recent first");
  assert.equal(ov.recentlyTouched[0].title, "Beta");

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("overview: empty vault returns zero totals and empty arrays", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-overview-empty-"));
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const ov = vi.overview();
  assert.equal(ov.totalNotes, 0);
  assert.deepEqual(ov.topLevelFolders, []);
  assert.deepEqual(ov.recentlyTouched, []);

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/vault-index-overview.test.js
```

Expected: FAIL with `TypeError: vi.overview is not a function`

- [ ] **Step 3: Implement `overview()` in `src/vault-index.js`**

Add immediately after the `list()` method (currently around line 806, before `readNote()`):

```javascript
  overview() {
    this.ensureIndexed();

    const folderRows = this.db.prepare(
      "SELECT folder, COUNT(*) AS noteCount FROM notes WHERE folder <> '' GROUP BY folder",
    ).all();

    const byTop = new Map();
    let totalNotes = 0;
    for (const { folder, noteCount } of folderRows) {
      totalNotes += noteCount;
      const top = folder.split("/")[0];
      let entry = byTop.get(top);
      if (!entry) {
        entry = { path: top, noteCount: 0, subfolders: new Set() };
        byTop.set(top, entry);
      }
      entry.noteCount += noteCount;
      if (folder !== top) {
        entry.subfolders.add(folder.split("/")[1]);
      }
    }

    const topLevelFolders = Array.from(byTop.values())
      .map((e) => ({ path: e.path, noteCount: e.noteCount, subfolderCount: e.subfolders.size }))
      .sort((a, b) => b.noteCount - a.noteCount || a.path.localeCompare(b.path));

    const recentRows = this.db.prepare(
      "SELECT path, title, updated FROM notes WHERE updated IS NOT NULL ORDER BY updated DESC LIMIT 5",
    ).all();

    return {
      vaultRoot: this.config.vaultRoot,
      indexedAt: this.getLastIngestedAt(),
      totalNotes,
      topLevelFolders,
      recentlyTouched: recentRows,
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/vault-index-overview.test.js
```

Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add test/vault-index-overview.test.js src/vault-index.js
git commit -m "feat(vault-index): add overview() — vault snapshot for AI discovery"
```

---

## Task 2: Add `VaultIndex.tree({ path, depth })` method (TDD)

**Files:**
- Create: `test/vault-index-tree.test.js`
- Modify: `src/vault-index.js` (add method after `overview()`)

**Output shape produced:**
```json
{
  "path": "10 Projects",
  "noteCount": 3,
  "children": [
    { "path": "10 Projects/Sub", "noteCount": 2, "children": [] }
  ]
}
```

- [ ] **Step 1: Write failing test**

Create `test/vault-index-tree.test.js`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { VaultIndex } from "../src/vault-index.js";

function makeTempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-tree-"));
  const writeNote = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  // 3-level hierarchy:
  // 10 Projects/Alpha.md
  // 10 Projects/Sub/Beta.md
  // 10 Projects/Sub/Deep/Gamma.md
  // 20 Reference/Ref1.md
  writeNote("10 Projects/Alpha.md",          "---\nai-access: true\ntitle: Alpha\n---\nA.");
  writeNote("10 Projects/Sub/Beta.md",       "---\nai-access: true\ntitle: Beta\n---\nB.");
  writeNote("10 Projects/Sub/Deep/Gamma.md", "---\nai-access: true\ntitle: Gamma\n---\nG.");
  writeNote("20 Reference/Ref1.md",          "---\nai-access: true\ntitle: Ref1\n---\nR.");
  return { root };
}

function mkConfig(root) {
  return {
    vaultRoot: root,
    vaultRootSource: "test",
    indexPath: path.join(root, ".data", "index.sqlite"),
    hardExcludedFolders: [],
    hardExcludedFoldersLower: [],
    defaultLimits: { search: 8, list: 25, readChars: 12000 },
    maxLimits: { search: 20, list: 100, readChars: 40000 },
  };
}

test("tree: default — root with two levels of children", () => {
  const { root } = makeTempVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const t = vi.tree({});

  assert.equal(t.path, "", "root path is empty string");
  assert.equal(t.noteCount, 4, "4 notes total");
  assert.equal(t.children.length, 2, "two top-level folders");
  assert.equal(t.children[0].path, "10 Projects", "sorted by noteCount desc");
  assert.equal(t.children[0].noteCount, 3);
  assert.equal(t.children[0].children.length, 1, "10 Projects has Sub as immediate child");
  assert.equal(t.children[0].children[0].path, "10 Projects/Sub");
  assert.equal(t.children[0].children[0].noteCount, 2);
  // depth=2 → root + 2 levels of children. "Deep" is at level 3 from root, so children[0].children[0].children should be empty.
  assert.deepEqual(t.children[0].children[0].children, [], "depth=2 truncates below 10 Projects/Sub");

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("tree: with path argument — subtree rooted at given folder", () => {
  const { root } = makeTempVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const t = vi.tree({ path: "10 Projects" });

  assert.equal(t.path, "10 Projects");
  assert.equal(t.noteCount, 3);
  assert.equal(t.children.length, 1);
  assert.equal(t.children[0].path, "10 Projects/Sub");

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("tree: depth=0 — root only, no children", () => {
  const { root } = makeTempVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const t = vi.tree({ depth: 0 });

  assert.equal(t.noteCount, 4);
  assert.deepEqual(t.children, []);

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("tree: depth=1 — only immediate children, their children empty", () => {
  const { root } = makeTempVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const t = vi.tree({ depth: 1 });

  assert.equal(t.children.length, 2);
  assert.deepEqual(t.children[0].children, [], "immediate child's children must be empty at depth=1");

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("tree: depth=3 — reaches the deepest level", () => {
  const { root } = makeTempVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const t = vi.tree({ depth: 3 });

  // 10 Projects → Sub → Deep → (no further)
  const deep = t.children[0].children[0].children[0];
  assert.equal(deep.path, "10 Projects/Sub/Deep");
  assert.equal(deep.noteCount, 1);
  assert.deepEqual(deep.children, []);

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("tree: unknown path — returns noteCount=0 with empty children, does not throw", () => {
  const { root } = makeTempVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const t = vi.tree({ path: "does-not-exist" });
  assert.equal(t.path, "does-not-exist");
  assert.equal(t.noteCount, 0);
  assert.deepEqual(t.children, []);

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("tree: path normalization — trailing slash treated same as no slash", () => {
  const { root } = makeTempVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const a = vi.tree({ path: "10 Projects" });
  const b = vi.tree({ path: "10 Projects/" });
  assert.deepEqual(a, b);

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/vault-index-tree.test.js
```

Expected: FAIL with `TypeError: vi.tree is not a function`

- [ ] **Step 3: Implement `tree()` in `src/vault-index.js`**

Add immediately after the `overview()` method:

```javascript
  tree({ path: rootPath, depth } = {}) {
    this.ensureIndexed();

    const normalizedRoot = typeof rootPath === "string"
      ? rootPath.replace(/^\/+/, "").replace(/\/+$/, "")
      : "";
    const maxDepth = Number.isInteger(depth) ? Math.min(Math.max(depth, 0), 6) : 2;

    let folderRows;
    if (normalizedRoot === "") {
      folderRows = this.db.prepare(
        "SELECT folder, COUNT(*) AS noteCount FROM notes WHERE folder <> '' GROUP BY folder",
      ).all();
    } else {
      folderRows = this.db.prepare(
        "SELECT folder, COUNT(*) AS noteCount FROM notes WHERE (folder = ? OR folder LIKE ?) GROUP BY folder",
      ).all(normalizedRoot, `${normalizedRoot}/%`);
    }

    // Each node holds: noteCountDirect (notes whose folder column == this path), children: Map<segment, node>.
    const makeNode = (p) => ({ path: p, noteCountDirect: 0, children: new Map() });
    const rootNode = makeNode(normalizedRoot);

    for (const { folder, noteCount } of folderRows) {
      // path of this row relative to the rootNode
      const relative = normalizedRoot === ""
        ? folder
        : folder === normalizedRoot
          ? ""
          : folder.slice(normalizedRoot.length + 1);
      const segments = relative === "" ? [] : relative.split("/");

      let cursor = rootNode;
      let accumulatedPath = normalizedRoot;
      for (const seg of segments) {
        accumulatedPath = accumulatedPath === "" ? seg : `${accumulatedPath}/${seg}`;
        if (!cursor.children.has(seg)) {
          cursor.children.set(seg, makeNode(accumulatedPath));
        }
        cursor = cursor.children.get(seg);
      }
      cursor.noteCountDirect += noteCount;
    }

    // Recursive: returns { noteCountTotal, serializedNode }. Truncates children below maxDepth.
    const serialize = (node, remainingDepth) => {
      const childEntries = Array.from(node.children.values());
      let total = node.noteCountDirect;
      const serializedChildren = [];
      for (const child of childEntries) {
        const { total: childTotal, node: childNode } = serialize(child, Math.max(remainingDepth - 1, 0));
        total += childTotal;
        if (remainingDepth > 0) serializedChildren.push(childNode);
      }
      serializedChildren.sort((a, b) =>
        b.noteCount - a.noteCount || a.path.localeCompare(b.path),
      );
      return {
        total,
        node: { path: node.path, noteCount: total, children: serializedChildren },
      };
    };

    return serialize(rootNode, maxDepth).node;
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/vault-index-tree.test.js
```

Expected: PASS — all 7 tests green.

Also run the full suite to confirm no regression:

```bash
npm test
```

Expected: all pre-existing tests still pass plus the new ones.

- [ ] **Step 5: Commit**

```bash
git add test/vault-index-tree.test.js src/vault-index.js
git commit -m "feat(vault-index): add tree() — hierarchical folder navigation"
```

---

## Task 3: Register `kb_overview` MCP tool

**Files:**
- Modify: `src/index.js` (add `registerTool` call near the other tools, around line 372 between `kb_bulk_update` and `kb_stats`)

- [ ] **Step 1: Add the tool registration in `src/index.js`**

Insert this block immediately *before* the `kb_stats` registration (which is currently the last tool registered around line 372):

```javascript
server.registerTool("kb_overview", {
  title: "Vault overview",
  description: "Entry point for vault exploration. Run this first when working in the user's Obsidian vault — returns a one-shot snapshot of total note count, top-level folder breakdown, and recently-touched notes. Use the returned folder paths with kb_tree (drill-in) or kb_list (notes within a folder). No arguments.",
}, wrapTool("kb_overview", async () => {
  const ov = vaultIndex.overview();
  return toolText(JSON.stringify(ov, null, 2));
}));

server.registerTool("kb_tree", {
  title: "Folder tree",
  description: "Return a hierarchical folder tree with note counts per folder. Use after kb_overview to drill into a specific section of the vault. Returns folder structure only — no note titles. For listing notes inside a folder, use kb_list. Defaults to vault root, depth 2.",
  inputSchema: {
    path: z.string().optional(),
    depth: z.number().int().min(0).max(6).optional(),
  },
}, wrapTool("kb_tree", async ({ path: treePath, depth }) => {
  const t = vaultIndex.tree({ path: treePath, depth });
  return toolText(JSON.stringify(t, null, 2));
}));
```

(Both tools registered in one step since they share the pattern and the rationale; commit covers both in Task 4.)

- [ ] **Step 2: Verify the registrations parse and the server boots**

```bash
node -e "import('./src/index.js').catch(e => { console.error('BOOT FAIL:', e.message); process.exit(1); })" &
SERVER_PID=$!
sleep 1
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
echo "exit=$?"
```

Expected: server starts without throwing (note: it expects a vault root via env or config — if it fails on missing vault root, that's pre-existing and fine; we're only checking syntax/import).

Quicker pure-syntax check:

```bash
node --check src/index.js
```

Expected: silent success (exit 0).

- [ ] **Step 3: Run full test suite to confirm no regression**

```bash
npm test
```

Expected: all tests still pass (new tools have no automated coverage yet — that comes in Task 6 via smoke).

- [ ] **Step 4: Commit (combined with Task 4)**

Skip — combine both new tool registrations in Task 4's commit so the MCP surface change lands atomically.

---

## Task 4: Confirm `kb_tree` registration (and commit Tasks 3+4 together)

**Files:**
- (already modified in Task 3): `src/index.js`

This task exists to make the commit boundary explicit. The registration code for both `kb_overview` and `kb_tree` was added together in Task 3; this task is the verification + commit step.

- [ ] **Step 1: Re-read `src/index.js` and confirm both `registerTool("kb_overview", ...)` and `registerTool("kb_tree", ...)` are present**

```bash
grep -n 'registerTool("kb_overview"\|registerTool("kb_tree"' src/index.js
```

Expected: two lines printed, both showing the new tool names.

- [ ] **Step 2: Confirm `z.string()` and `z.number()` are already imported**

```bash
grep -n "from \"zod\"" src/index.js
```

Expected: one line showing `import { z } from "zod";` (or similar). If missing, add: `import { z } from "zod";` at the top.

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat(mcp): register kb_overview and kb_tree tools"
```

---

## Task 5: Sharpen 5 existing tool descriptions

**Files:**
- Modify: `src/index.js` (5 in-place `description` string edits)

The 5 tools on the discovery path get a workflow hint appended. Maintenance tools (`kb_orphans`, `kb_dead_links`, `kb_bulk_update`, `kb_stats`, `kb_ingest`) are not touched.

- [ ] **Step 1: Edit `kb_search` description**

Current (around line 195 in `src/index.js`):
```javascript
  description: "Search AI-accessible Obsidian notes with SQLite FTS5 keyword search.",
```

Replace with:
```javascript
  description: "Search AI-accessible Obsidian notes with SQLite FTS5 keyword search. For browsing vault structure, prefer kb_overview + kb_tree. Use this for keyword content matches.",
```

- [ ] **Step 2: Edit `kb_read` description**

Current (around line 209):
```javascript
  description: "Read one AI-accessible note by vault-relative path.",
```

Replace with:
```javascript
  description: "Read one AI-accessible note by vault-relative path. Use after kb_search, kb_list, or kb_tree once you have a specific path.",
```

- [ ] **Step 3: Edit `kb_list` description**

Current (around line 221):
```javascript
  description: "List AI-accessible notes by folder, tag, or status.",
```

Replace with:
```javascript
  description: "List AI-accessible notes by folder, tag, or status. Use after kb_overview or kb_tree to enumerate notes within a known folder.",
```

- [ ] **Step 4: Edit `kb_semantic` description**

Current (around line 251):
```javascript
  description: "Embedding-based search via local Ollama. Returns notes ranked by cosine similarity. Requires Ollama running and embeddings populated.",
```

Replace with:
```javascript
  description: "Embedding-based search via local Ollama. Returns notes ranked by cosine similarity. Requires Ollama running and embeddings populated. For browsing vault structure, prefer kb_overview + kb_tree. Use this for meaning-based content matches.",
```

- [ ] **Step 5: Edit `kb_related` description**

Current (around line 288):
```javascript
  description: "For a given note, return top-N most similar notes regardless of link status. Uses embedding cosine similarity. Lower-friction sibling of kb_suggest_links — no link-graph filtering.",
```

Replace with:
```javascript
  description: "For a given note, return top-N most similar notes regardless of link status. Uses embedding cosine similarity. Lower-friction sibling of kb_suggest_links — no link-graph filtering. Use after you have a specific note path. For discovering vault structure, use kb_tree.",
```

- [ ] **Step 6: Run full test suite to confirm no regression**

```bash
npm test
```

Expected: all tests pass — description strings are not tested for exact content.

- [ ] **Step 7: Commit**

```bash
git add src/index.js
git commit -m "docs(mcp): sharpen tool descriptions with discovery workflow hints"
```

---

## Task 6: Extend `src/smoke.js` to exercise `kb_overview` and `kb_tree`

**Files:**
- Modify: `src/smoke.js` (add two `client.callTool` calls + include them in output JSON)

- [ ] **Step 1: Add the two new tool calls in `src/smoke.js`**

After the existing `ingestResult` line (around line 62) and before the `console.log` block, insert:

```javascript
const overviewResult = await client.callTool({
  name: "kb_overview",
  arguments: {},
});
const treeResult = await client.callTool({
  name: "kb_tree",
  arguments: { depth: 2 },
});
```

Then extend the `console.log` JSON object to include them. Current block:

```javascript
console.log(JSON.stringify({
  toolCount: tools.tools.length,
  toolNames: tools.tools.map((tool) => tool.name),
  searchPreview: extractText(searchResult),
  listPreview: extractText(listResult),
  readPreview: extractText(readResult),
  ingestPreview: extractText(ingestResult),
}, null, 2));
```

Replace with:

```javascript
console.log(JSON.stringify({
  toolCount: tools.tools.length,
  toolNames: tools.tools.map((tool) => tool.name),
  searchPreview: extractText(searchResult),
  listPreview: extractText(listResult),
  readPreview: extractText(readResult),
  ingestPreview: extractText(ingestResult),
  overviewPreview: extractText(overviewResult),
  treePreview: extractText(treeResult),
}, null, 2));
```

- [ ] **Step 2: Run smoke test against the demo fixture**

```bash
VAULT_KB_VAULT_PATH="$(pwd)/test/fixture/demo-vault" node src/smoke.js
```

Expected: JSON output printed to stdout. `toolCount` shows 13 (was 11; +`kb_overview` +`kb_tree`). `overviewPreview` shows the JSON structure with `topLevelFolders` non-empty (demo vault has `00 Inbox`, `10 Projects`, `20 Reference`, `30 Areas`). `treePreview` shows the hierarchy including `30 Areas/Cooking`.

(Env var name verified against `src/config.js` line 63: `VAULT_PATH_ENV = "VAULT_KB_VAULT_PATH"`.)

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/smoke.js
git commit -m "test(smoke): exercise kb_overview and kb_tree in MCP roundtrip"
```

---

## Task 7: CHANGELOG entry + version bump

**Files:**
- Modify: `CHANGELOG.md` (add entry at the top under a new version heading)
- Modify: `package.json` (bump version `"0.2.0"` → `"0.3.0"`)

- [ ] **Step 1: Add a new version entry at the top of `CHANGELOG.md`**

(Format verified: `## [x.y.z] — YYYY-MM-DD` with em-dash, Keep a Changelog style.) Insert this block between the `# Changelog` header (and its preamble line) and the existing `## [0.2.0] — 2026-05-16` entry:

```markdown
## [0.3.0] — 2026-05-23

### Added
- `kb_overview` — entry-point snapshot of the vault: total note count, top-level folders with recursive note counts and subfolder counts, recently touched notes. Designed as the "start here" call for AI clients so they consult the vault before reaching for other context.
- `kb_tree` — hierarchical folder tree with recursive note counts per folder. Parameters: `path` (optional, default vault root), `depth` (optional, default 2, max 6).

### Changed
- Tool descriptions for `kb_search`, `kb_read`, `kb_list`, `kb_semantic`, and `kb_related` now include workflow hints pointing to `kb_overview` / `kb_tree` for vault-structure discovery.
```

- [ ] **Step 2: Bump version in `package.json`**

Edit `package.json`: change

```json
  "version": "0.2.0",
```

to

```json
  "version": "0.3.0",
```

- [ ] **Step 3: Verify `npm test` still passes**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "chore: release v0.3.0 — kb_overview + kb_tree discovery tools"
```

- [ ] **Step 5: Final verification — run smoke once more end-to-end**

```bash
VAULT_KB_VAULT_PATH="$(pwd)/test/fixture/demo-vault" node src/smoke.js | head -40
```

Expected: JSON output with `toolCount: 13`, both new tools in `toolNames`, and `overviewPreview` containing valid JSON snippet.

---

## Acceptance Criteria (from spec)

After all tasks complete:

- ✅ `kb_overview` registered and returns the documented shape.
- ✅ `kb_tree` registered, respects `path` and `depth`, returns `noteCount: 0, children: []` for unknown paths (covered by Task 2 tests).
- ✅ Five sharpened tool descriptions in `src/index.js` (Task 5).
- ✅ All pre-existing 11 tools still pass tests (verified after Tasks 4, 5, 6).
- ✅ Smoke test includes both new tools (Task 6).
- ⏳ Manual behavior check — *"in a fresh Claude Code conversation pointed at the real vault, asking 'what's in my vault?' results in the agent calling `kb_overview` first"* — done by user after merge.

## Notes for Executor

- This plan assumes you're on branch `docs/discoverability-spec` (already contains the spec). Verify with `git branch --show-current` before starting.
- Do not run `git push` — wait for user instruction.
- If any test in the existing suite fails *before* you start changing anything, stop and report — this plan assumes a green baseline.
- The `subagent-driven-development` skill will dispatch one subagent per task with a review checkpoint between each — that fits this plan well since each task has a clear acceptance signal (test passes, smoke runs, commit lands).
