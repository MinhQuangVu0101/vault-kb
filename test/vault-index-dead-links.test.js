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

test("findDeadLinks: returns unresolved [[refs]] grouped by source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-dead-"));
  const write = (rel, body) => fs.writeFileSync(path.join(root, rel), body);
  // File basenames must match link targets so buildResolver can resolve them.
  // Alpha.md links to [[Beta]] (resolves) and [[Ghost]] (dead).
  // Beta.md links to [[NotHere]] (dead). No file named "Ghost" or "NotHere" exists.
  write("Alpha.md", "---\nai-access: true\ntitle: Alpha\n---\nLinks to [[Beta]] and [[Ghost]].");
  write("Beta.md", "---\nai-access: true\ntitle: Beta\n---\nLinks to [[NotHere]].");

  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const dead = vi.findDeadLinks();
  assert.equal(dead.length, 2, "two source notes have broken refs");
  // Sort by source path ascending per spec
  assert.equal(dead[0].path, "Alpha.md");
  assert.equal(dead[0].title, "Alpha");
  assert.deepEqual(dead[0].broken, ["Ghost"]);
  assert.equal(dead[1].path, "Beta.md");
  assert.deepEqual(dead[1].broken, ["NotHere"]);

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("findDeadLinks: empty result when all links resolve", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-dead-"));
  const write = (rel, body) => fs.writeFileSync(path.join(root, rel), body);
  // Alpha.md links to [[Beta]] which resolves to Beta.md.
  write("Alpha.md", "---\nai-access: true\ntitle: Alpha\n---\nLinks to [[Beta]].");
  write("Beta.md", "---\nai-access: true\ntitle: Beta\n---\nNo outlinks.");

  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  assert.deepEqual(vi.findDeadLinks(), []);

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});
