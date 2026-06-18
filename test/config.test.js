import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, resolveVaultRoot, normalizeRelativeVaultPath } from "../src/config.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-config-"));
}

test("resolveVaultRoot prefers env over config", () => {
  const { vaultRoot, source } = resolveVaultRoot({
    env: { VAULT_KB_VAULT_PATH: "/from/env" },
    configVaultRoot: "/from/config",
  });
  assert.equal(vaultRoot, "/from/env");
  assert.equal(source, "env");
});

test("resolveVaultRoot falls back to config when env missing", () => {
  const { vaultRoot, source } = resolveVaultRoot({
    env: {},
    configVaultRoot: "/from/config",
  });
  assert.equal(vaultRoot, "/from/config");
  assert.equal(source, "config");
});

test("resolveVaultRoot throws when neither set", () => {
  assert.throws(() => resolveVaultRoot({ env: {}, configVaultRoot: undefined }), /VAULT_KB_VAULT_PATH/);
});

test("loadConfig works without a config file if env set", () => {
  const dir = tmpdir();
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault);
  const cfg = loadConfig(path.join(dir, "no-such-config.json"), {
    env: { VAULT_KB_VAULT_PATH: vault },
  });
  assert.equal(cfg.vaultRoot, vault);
  assert.equal(cfg.vaultRootSource, "env");
  assert.equal(cfg.configExists, false);
});

test("loadConfig env overrides config file vaultRoot", () => {
  const dir = tmpdir();
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault);
  const configPath = path.join(dir, "vault-ai.config.json");
  fs.writeFileSync(configPath, JSON.stringify({ vaultRoot: "/ignored/path" }));
  const cfg = loadConfig(configPath, { env: { VAULT_KB_VAULT_PATH: vault } });
  assert.equal(cfg.vaultRoot, vault);
  assert.equal(cfg.vaultRootSource, "env");
});

test("loadConfig errors clearly when neither env nor config provides vaultRoot", () => {
  const dir = tmpdir();
  const configPath = path.join(dir, "empty.json");
  fs.writeFileSync(configPath, "{}");
  assert.throws(
    () => loadConfig(configPath, { env: {} }),
    /Vault path not configured/,
  );
});

test("loadConfig errors when vault path does not exist", () => {
  assert.throws(
    () => loadConfig("/nonexistent/config.json", {
      env: { VAULT_KB_VAULT_PATH: "/nope/definitely/missing" },
    }),
    /Vault root does not exist/,
  );
});

test("normalizeRelativeVaultPath canonicalizes folder forms identically", () => {
  // The canonical form every path-based tool (list/search/semantic/tree) must agree on.
  assert.equal(normalizeRelativeVaultPath("10 Projects/Sub"), "10 Projects/Sub");
  assert.equal(normalizeRelativeVaultPath("10 Projects/Sub/"), "10 Projects/Sub", "trailing slash stripped");
  assert.equal(normalizeRelativeVaultPath("10 Projects\\Sub"), "10 Projects/Sub", "backslashes -> /");
  assert.equal(normalizeRelativeVaultPath("./10 Projects/Sub"), "10 Projects/Sub", "leading ./ removed");
  assert.equal(normalizeRelativeVaultPath("10 Projects//Sub"), "10 Projects/Sub", "duplicate separators collapsed");
  assert.equal(normalizeRelativeVaultPath("  10 Projects/Sub  "), "10 Projects/Sub", "whitespace trimmed");
  assert.equal(normalizeRelativeVaultPath("/10 Projects/"), "10 Projects", "leading and trailing slashes");
  assert.equal(normalizeRelativeVaultPath(""), "", "empty -> root");
  assert.equal(normalizeRelativeVaultPath(undefined), "", "undefined -> root");
});

test("normalizeRelativeVaultPath rejects parent traversal", () => {
  assert.throws(() => normalizeRelativeVaultPath("../escape"), /escapes vault root/i);
  assert.throws(() => normalizeRelativeVaultPath(".."), /escapes vault root/i);
});

test("loadConfig default hardExcludedFolders include Syncthing versioning", () => {
  const dir = tmpdir();
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault);
  const cfg = loadConfig(path.join(dir, "no-such-config.json"), {
    env: { VAULT_KB_VAULT_PATH: vault },
  });
  assert.deepEqual(cfg.hardExcludedFolders, [
    ".obsidian",
    ".obsidian-mobile",
    ".git",
    ".stversions",
    ".trash",
  ]);
  assert.ok(cfg.hardExcludedFoldersLower.includes(".stversions"));
});
