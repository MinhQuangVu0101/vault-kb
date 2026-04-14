import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createWatcher } from "../src/watcher.js";
import { VaultIndex } from "../src/vault-index.js";

function tmpVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-watcher-"));
  return dir;
}

function mkConfig(vaultRoot) {
  return {
    vaultRoot,
    indexPath: path.join(vaultRoot, ".data", "index.sqlite"),
    hardExcludedFolders: [".obsidian"],
    hardExcludedFoldersLower: [".obsidian"],
    defaultLimits: { search: 8, list: 25, readChars: 12000 },
    maxLimits: { search: 20, list: 100, readChars: 40000 },
  };
}

function write(vaultRoot, rel, body) {
  const abs = path.join(vaultRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred, { tries = 40, delay = 50 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (pred()) return true;
    await wait(delay);
  }
  return false;
}

test("watcher indexes a new ai-accessible file on add", async () => {
  const vault = tmpVault();
  const config = mkConfig(vault);
  const index = new VaultIndex(config);
  const watcher = createWatcher({ config, vaultIndex: index, debounceMs: 50 });
  watcher.start();
  await wait(200);

  write(vault, "a.md", "---\nai-access: true\n---\n# Hello\nbody");
  const ok = await waitFor(() => index.db.prepare("SELECT COUNT(*) c FROM notes").get().c === 1);
  assert.ok(ok, "new note should be indexed");

  await watcher.stop();
  index.close();
});

test("watcher re-ingests on change and removes on unlink", async () => {
  const vault = tmpVault();
  const config = mkConfig(vault);
  const index = new VaultIndex(config);
  const watcher = createWatcher({ config, vaultIndex: index, debounceMs: 50 });
  watcher.start();
  await wait(200);

  const file = write(vault, "a.md", "---\nai-access: true\n---\n# One\nfirst");
  await waitFor(() => index.db.prepare("SELECT title FROM notes WHERE path='a.md'").get()?.title === "One");

  fs.writeFileSync(file, "---\nai-access: true\n---\n# Two\nsecond");
  const changed = await waitFor(() => index.db.prepare("SELECT title FROM notes WHERE path='a.md'").get()?.title === "Two");
  assert.ok(changed, "title should update after change");

  fs.unlinkSync(file);
  const removed = await waitFor(() => index.db.prepare("SELECT COUNT(*) c FROM notes WHERE path='a.md'").get().c === 0);
  assert.ok(removed, "note should be removed after unlink");

  await watcher.stop();
  index.close();
});

test("watcher skips files without ai-access and records event counts", async () => {
  const vault = tmpVault();
  const config = mkConfig(vault);
  const index = new VaultIndex(config);
  const watcher = createWatcher({ config, vaultIndex: index, debounceMs: 50 });
  watcher.start();
  await wait(200);

  write(vault, "private.md", "# no access frontmatter\nbody");
  await wait(300);
  assert.equal(index.db.prepare("SELECT COUNT(*) c FROM notes").get().c, 0);

  const snap = watcher.snapshot();
  assert.equal(snap.active, true);
  assert.ok(snap.events.add >= 1);

  await watcher.stop();
  assert.equal(watcher.snapshot().active, false);
  index.close();
});
