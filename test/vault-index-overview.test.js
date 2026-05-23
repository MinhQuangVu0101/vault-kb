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
