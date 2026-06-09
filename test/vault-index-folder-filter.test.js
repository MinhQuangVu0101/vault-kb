import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { VaultIndex } from "../src/vault-index.js";

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

function makeUnderscoreVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-folder-filter-under-"));
  const writeNote = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  writeNote("my_folder/A.md",     "---\nai-access: true\ntitle: A\n---\nsearchable-term here.");
  writeNote("my_folder/sub/B.md", "---\nai-access: true\ntitle: B\n---\nsearchable-term here.");
  writeNote("myXfolder/sub/D.md", "---\nai-access: true\ntitle: D\n---\nsearchable-term here.");
  return { root };
}

function makePercentVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-folder-filter-pct-"));
  const writeNote = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  writeNote("100% Done/A.md",       "---\nai-access: true\ntitle: A\n---\nsearchable-term here.");
  writeNote("100X Done/child/B.md", "---\nai-access: true\ntitle: B\n---\nsearchable-term here.");
  return { root };
}

test("list: underscore in folder name does not over-match siblings", () => {
  const { root } = makeUnderscoreVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const rows = vi.list({ folder: "my_folder" });
  const paths = rows.map((r) => r.path).sort();
  assert.deepEqual(
    paths,
    ["my_folder/A.md", "my_folder/sub/B.md"],
    "must NOT include myXfolder/sub/D.md",
  );

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("list: percent in folder name does not over-match siblings", () => {
  const { root } = makePercentVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const rows = vi.list({ folder: "100% Done" });
  const paths = rows.map((r) => r.path).sort();
  assert.deepEqual(
    paths,
    ["100% Done/A.md"],
    "must NOT include 100X Done/child/B.md",
  );

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("search: underscore in folder name does not over-match siblings", () => {
  const { root } = makeUnderscoreVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const rows = vi.search({ query: "searchable-term", folder: "my_folder" });
  const paths = rows.map((r) => r.path).sort();
  assert.deepEqual(
    paths,
    ["my_folder/A.md", "my_folder/sub/B.md"],
    "must NOT include myXfolder/sub/D.md",
  );

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("search: percent in folder name does not over-match siblings", () => {
  const { root } = makePercentVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const rows = vi.search({ query: "searchable-term", folder: "100% Done" });
  const paths = rows.map((r) => r.path).sort();
  assert.deepEqual(
    paths,
    ["100% Done/A.md"],
    "must NOT include 100X Done/child/B.md",
  );

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});
