import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { VaultIndex } from "../src/vault-index.js";

function makeTempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-orphans-"));
  const writeNote = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  // Alpha → Beta. Gamma is isolated. Delta has no outgoing but is linked from Beta.
  // File basenames must match link targets so buildResolver can resolve them.
  writeNote("Alpha.md", "---\nai-access: true\ntitle: Alpha\n---\nAlpha links to [[Beta]].");
  writeNote("Beta.md", "---\nai-access: true\ntitle: Beta\n---\nBeta links to [[Delta]].");
  writeNote("Gamma.md", "---\nai-access: true\ntitle: Gamma\n---\nGamma is isolated.");
  writeNote("Delta.md", "---\nai-access: true\ntitle: Delta\n---\nDelta has no outlinks.");
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

test("findOrphans: returns notes with no incoming and no outgoing resolved links", () => {
  const { root } = makeTempVault();
  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const orphans = vi.findOrphans();
  assert.equal(orphans.length, 1, "only Gamma.md is fully isolated");
  assert.equal(orphans[0].path, "Gamma.md");
  assert.equal(orphans[0].title, "Gamma");

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("findOrphans: respects limit param", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-orphans-"));
  const write = (rel, body) => fs.writeFileSync(path.join(root, rel), body);
  write("o1.md", "---\nai-access: true\ntitle: O1\n---\nIsolated one.");
  write("o2.md", "---\nai-access: true\ntitle: O2\n---\nIsolated two.");
  write("o3.md", "---\nai-access: true\ntitle: O3\n---\nIsolated three.");

  const vi = new VaultIndex(mkConfig(root));
  vi.ingest();

  const limited = vi.findOrphans({ limit: 2 });
  assert.equal(limited.length, 2);

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});
