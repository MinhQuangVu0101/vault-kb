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

test("tree: LIKE special characters in folder names do not over-match siblings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-tree-like-"));
  const writeNote = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  // my_folder vs myXfolder — underscore in LIKE matches any single character
  writeNote("my_folder/A.md",       "---\nai-access: true\ntitle: A\n---\nA.");
  writeNote("my_folder/sub/B.md",   "---\nai-access: true\ntitle: B\n---\nB.");
  writeNote("myXfolder/sub/D.md",   "---\nai-access: true\ntitle: D\n---\nD.");

  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const t = vi.tree({ path: "my_folder" });
  assert.equal(t.path, "my_folder");
  assert.equal(t.noteCount, 2, "must NOT include myXfolder/sub/D.md");
  assert.equal(t.children.length, 1);
  assert.equal(t.children[0].path, "my_folder/sub");

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("tree: percent in folder name does not over-match", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-tree-percent-"));
  const writeNote = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  writeNote("100% Done/A.md",       "---\nai-access: true\ntitle: A\n---\nA.");
  writeNote("100X Done/child/B.md", "---\nai-access: true\ntitle: B\n---\nB.");

  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const t = vi.tree({ path: "100% Done" });
  assert.equal(t.noteCount, 1, "must NOT include 100X Done/child/B.md");

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("tree: root noteCount includes root-level notes (consistent with overview.totalNotes)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-tree-root-"));
  const writeNote = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  writeNote("AtRoot.md",               "---\nai-access: true\ntitle: AtRoot\n---\nRoot note.");
  writeNote("10 Projects/InFolder.md", "---\nai-access: true\ntitle: InFolder\n---\nFolder note.");

  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const t = vi.tree({});
  assert.equal(t.noteCount, 2, "root-level note is counted in tree({}).noteCount");
  assert.equal(t.children.length, 1, "but no top-level entry for root-level note");
  assert.equal(t.children[0].path, "10 Projects");

  // And cross-check that this matches overview.totalNotes
  const ov = vi.overview();
  assert.equal(t.noteCount, ov.totalNotes, "tree({}).noteCount === overview().totalNotes");

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});
