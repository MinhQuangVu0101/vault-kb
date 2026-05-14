import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { VaultIndex } from "../src/vault-index.js";

function makeTempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-related-"));
  const writeNote = (rel, body) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  writeNote("a.md", "---\nai-access: true\ntitle: Alpha\n---\nAlpha body about transformers and attention.");
  writeNote("b.md", "---\nai-access: true\ntitle: Beta\n---\nBeta body about transformers and attention mechanisms.");
  writeNote("c.md", "---\nai-access: true\ntitle: Gamma\n---\nGamma body about cooking pasta carbonara.");
  return { root };
}

function fakeEmbedder() {
  // Return deterministic vectors based on substring matches.
  const vecFor = (text) => {
    const t = String(text).toLowerCase();
    return Float32Array.from([
      t.includes("transformer") ? 1 : 0,
      t.includes("attention") ? 1 : 0,
      t.includes("pasta") ? 1 : 0,
    ]);
  };
  return {
    async embedNote({ title, body }) {
      return { vector: vecFor(`${title} ${body}`), model: "fake", contentHash: `h-${title}-${body.length}` };
    },
    async embedQuery(text) { return vecFor(text); },
    contentHash(title, body) { return `h-${title}-${body.length}`; },
    status() { return { url: "fake", model: "fake", reachable: true, lastError: null }; },
    async summarize() { return null; },
  };
}

test("findRelatedByPath: returns similar notes excluding source and excludePaths", async () => {
  const { root } = makeTempVault();
  const config = {
    vaultRoot: root,
    vaultRootSource: "test",
    indexPath: path.join(root, "index.sqlite"),
    hardExcludedFolders: [],
    hardExcludedFoldersLower: [],
    defaultLimits: { search: 8, list: 25, readChars: 12000 },
    maxLimits: { search: 20, list: 100, readChars: 40000 },
  };
  const vi = new VaultIndex(config, { embedder: fakeEmbedder() });
  vi.ingest();
  await vi.embedAll();

  const results = vi.findRelatedByPath("a.md", { limit: 5, excludePaths: [] });
  assert.equal(results.length, 2, "should find b and c, excluding a itself");
  assert.equal(results[0].path, "b.md", "b is more similar to a than c");
  assert.ok(results[0].score > results[1].score);

  const filtered = vi.findRelatedByPath("a.md", { limit: 5, excludePaths: ["b.md"] });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].path, "c.md");

  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("findRelatedByPath: throws when source path has no embedding", async () => {
  const { root } = makeTempVault();
  const config = {
    vaultRoot: root, vaultRootSource: "test", indexPath: path.join(root, "index.sqlite"),
    hardExcludedFolders: [], hardExcludedFoldersLower: [],
    defaultLimits: { search: 8, list: 25, readChars: 12000 },
    maxLimits: { search: 20, list: 100, readChars: 40000 },
  };
  const vi = new VaultIndex(config, { embedder: fakeEmbedder() });
  vi.ingest();
  // do NOT call embedAll — embeddings table is empty

  assert.throws(() => vi.findRelatedByPath("a.md", { limit: 5, excludePaths: [] }), /no embedding/i);
  vi.close();
  fs.rmSync(root, { recursive: true, force: true });
});
