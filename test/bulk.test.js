import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import matter from "gray-matter";

import { runBulkUpdate } from "../src/bulk.js";

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-bulk-"));
}

function tmpReverts() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-reverts-"));
}

function mkConfig(vaultRoot) {
  return {
    vaultRoot,
    hardExcludedFolders: [".obsidian"],
    hardExcludedFoldersLower: [".obsidian"],
  };
}

function write(vaultRoot, rel, fm, body = "body") {
  const abs = path.join(vaultRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, matter.stringify(body, fm));
}

function read(vaultRoot, rel) {
  return matter(fs.readFileSync(path.join(vaultRoot, rel), "utf8")).data;
}

test("dry-run reports changes without writing", () => {
  const v = tmpVault();
  write(v, "a.md", { "ai-access": true, status: "draft" });
  const result = runBulkUpdate({
    config: mkConfig(v),
    match: { folder: "" },
    ops: { setFields: { status: "active" } },
  });
  assert.equal(result.applied, false);
  assert.equal(result.matched, 1);
  assert.equal(read(v, "a.md").status, "draft");
});

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

test("folder filter scopes the write", () => {
  const v = tmpVault();
  const reverts = tmpReverts();
  write(v, "Study/a.md", { status: "draft" });
  write(v, "Other/b.md", { status: "draft" });
  const result = runBulkUpdate({
    config: mkConfig(v),
    match: { folder: "Study" },
    ops: { setFields: { status: "done" } },
    apply: true,
    revertDir: reverts,
  });
  assert.equal(result.matched, 1);
  assert.equal(read(v, "Study/a.md").status, "done");
  assert.equal(read(v, "Other/b.md").status, "draft");
});

test("tag filter matches notes with tag", () => {
  const v = tmpVault();
  const reverts = tmpReverts();
  write(v, "a.md", { tags: ["study"] });
  write(v, "b.md", { tags: ["health"] });
  const result = runBulkUpdate({
    config: mkConfig(v),
    match: { tag: "study" },
    ops: { addTags: ["flagged"] },
    apply: true,
    revertDir: reverts,
  });
  assert.equal(result.matched, 1);
  assert.deepEqual(read(v, "a.md").tags, ["study", "flagged"]);
  assert.deepEqual(read(v, "b.md").tags, ["health"]);
});

test("addTags / removeTags dedupe and preserve casing-insensitive equality", () => {
  const v = tmpVault();
  const reverts = tmpReverts();
  write(v, "a.md", { tags: ["Study", "old"] });
  runBulkUpdate({
    config: mkConfig(v),
    match: {},
    ops: { addTags: ["study", "new"], removeTags: ["OLD"] },
    apply: true,
    revertDir: reverts,
  });
  const tags = read(v, "a.md").tags;
  assert.ok(tags.includes("study"));
  assert.ok(tags.includes("new"));
  assert.ok(!tags.includes("old"));
  assert.ok(!tags.includes("OLD"));
});

test("setAccess shortcut writes ai-access", () => {
  const v = tmpVault();
  const reverts = tmpReverts();
  write(v, "a.md", { tags: [] });
  runBulkUpdate({
    config: mkConfig(v),
    match: {},
    ops: { setAccess: true },
    apply: true,
    revertDir: reverts,
  });
  assert.equal(read(v, "a.md")["ai-access"], true);
});

test("unsetFields removes fields", () => {
  const v = tmpVault();
  const reverts = tmpReverts();
  write(v, "a.md", { status: "draft", obsolete: "yes" });
  runBulkUpdate({
    config: mkConfig(v),
    match: {},
    ops: { unsetFields: ["obsolete"] },
    apply: true,
    revertDir: reverts,
  });
  const fm = read(v, "a.md");
  assert.equal(fm.status, "draft");
  assert.equal("obsolete" in fm, false);
});

test("no-op (already-satisfied ops) produces zero changes", () => {
  const v = tmpVault();
  write(v, "a.md", { status: "archived" });
  const result = runBulkUpdate({
    config: mkConfig(v),
    match: {},
    ops: { setFields: { status: "archived" } },
    apply: true,
  });
  assert.equal(result.matched, 0);
  assert.equal(result.revertFile, null);
});

test("hard-excluded folders are not touched", () => {
  const v = tmpVault();
  const reverts = tmpReverts();
  write(v, ".obsidian/workspace.md", { status: "draft" });
  write(v, "a.md", { status: "draft" });
  const result = runBulkUpdate({
    config: mkConfig(v),
    match: {},
    ops: { setFields: { status: "done" } },
    apply: true,
    revertDir: reverts,
  });
  assert.equal(result.matched, 1);
  assert.equal(read(v, ".obsidian/workspace.md").status, "draft");
});

test("throws when no operations specified", () => {
  const v = tmpVault();
  write(v, "a.md", {});
  assert.throws(() => runBulkUpdate({ config: mkConfig(v), match: {}, ops: {} }), /No operations/);
});

test("frontmatter filter matches field equality", () => {
  const v = tmpVault();
  const reverts = tmpReverts();
  write(v, "a.md", { status: "draft" });
  write(v, "b.md", { status: "active" });
  const result = runBulkUpdate({
    config: mkConfig(v),
    match: { frontmatter: { status: "draft" } },
    ops: { setFields: { status: "archived" } },
    apply: true,
    revertDir: reverts,
  });
  assert.equal(result.matched, 1);
  assert.equal(read(v, "a.md").status, "archived");
  assert.equal(read(v, "b.md").status, "active");
});
