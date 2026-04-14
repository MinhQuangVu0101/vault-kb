import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import matter from "gray-matter";

import { buildResolver, parseLinks } from "../src/links.js";
import { VaultIndex } from "../src/vault-index.js";

test("parseLinks finds bare wiki links", () => {
  assert.deepEqual(parseLinks("see [[Foo]] and [[bar/baz]]"), ["Foo", "bar/baz"]);
});

test("parseLinks strips aliases, headings and blocks", () => {
  assert.deepEqual(
    parseLinks("[[Foo|alias]] [[Foo#Heading]] [[Foo^blockid]] [[Foo#Heading|label]]"),
    ["Foo"],
  );
});

test("parseLinks ignores links inside fenced or inline code", () => {
  const body = "outside [[A]]\n```\n[[B]]\n```\n`code [[C]]` and [[D]]";
  const links = parseLinks(body);
  assert.ok(links.includes("A"));
  assert.ok(links.includes("D"));
  assert.ok(!links.includes("B"));
  assert.ok(!links.includes("C"));
});

test("parseLinks dedupes", () => {
  assert.deepEqual(parseLinks("[[A]] [[A]] [[A|x]]"), ["A"]);
});

test("buildResolver: exact full-path match wins", () => {
  const resolve = buildResolver(["20 Notes/Foo.md", "Other/Foo.md"]);
  assert.equal(resolve("20 Notes/Foo"), "20 Notes/Foo.md");
});

test("buildResolver: basename match when path unique", () => {
  const resolve = buildResolver(["20 Notes/Foo.md"]);
  assert.equal(resolve("Foo"), "20 Notes/Foo.md");
});

test("buildResolver: returns null when no match", () => {
  const resolve = buildResolver(["a.md"]);
  assert.equal(resolve("Nope"), null);
});

test("buildResolver: case insensitive", () => {
  const resolve = buildResolver(["Docs/Foo.md"]);
  assert.equal(resolve("docs/foo"), "Docs/Foo.md");
  assert.equal(resolve("FOO"), "Docs/Foo.md");
});

// Integration: through VaultIndex

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-links-"));
}

function mkConfig(vaultRoot) {
  return {
    vaultRoot,
    indexPath: path.join(vaultRoot, ".data", "index.sqlite"),
    hardExcludedFolders: [],
    hardExcludedFoldersLower: [],
    defaultLimits: { search: 8, list: 25, readChars: 12000 },
    maxLimits: { search: 20, list: 100, readChars: 40000 },
  };
}

function write(v, rel, fm, body) {
  const abs = path.join(v, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, matter.stringify(body, fm));
}

test("ingest builds links and getBacklinks/getOutlinks work", () => {
  const v = tmpVault();
  write(v, "a.md", { "ai-access": true }, "links to [[B]]");
  write(v, "b.md", { "ai-access": true }, "referenced");
  write(v, "c.md", { "ai-access": true }, "also points to [[B]] and [[Nope]]");

  const index = new VaultIndex(mkConfig(v));
  index.ingest();

  const bBacklinks = index.getBacklinks("b.md").map((r) => r.path).sort();
  assert.deepEqual(bBacklinks, ["a.md", "c.md"]);

  const cOutlinks = index.getOutlinks("c.md");
  assert.equal(cOutlinks.length, 2);
  const resolved = cOutlinks.find((l) => !l.unresolved);
  const unresolved = cOutlinks.find((l) => l.unresolved);
  assert.equal(resolved.path, "b.md");
  assert.equal(unresolved.raw, "Nope");

  index.close();
});

test("ingestOne refreshes links for just that source", () => {
  const v = tmpVault();
  write(v, "a.md", { "ai-access": true }, "links to [[B]]");
  write(v, "b.md", { "ai-access": true }, "body");
  write(v, "c.md", { "ai-access": true }, "body");

  const index = new VaultIndex(mkConfig(v));
  index.ingest();
  assert.equal(index.getBacklinks("b.md").length, 1);

  // rewrite a.md to link to c instead of b
  write(v, "a.md", { "ai-access": true }, "now links to [[C]]");
  index.ingestOne("a.md");

  assert.equal(index.getBacklinks("b.md").length, 0);
  assert.equal(index.getBacklinks("c.md").length, 1);

  index.close();
});

test("removeOne cleans up outgoing links", () => {
  const v = tmpVault();
  write(v, "a.md", { "ai-access": true }, "links to [[B]]");
  write(v, "b.md", { "ai-access": true }, "body");

  const index = new VaultIndex(mkConfig(v));
  index.ingest();
  assert.equal(index.getBacklinks("b.md").length, 1);

  index.removeOne("a.md");
  assert.equal(index.getBacklinks("b.md").length, 0);

  index.close();
});

test("search rows include backlinkCount", () => {
  const v = tmpVault();
  write(v, "a.md", { "ai-access": true }, "links to [[Target]] searchable-term");
  write(v, "target.md", { "ai-access": true }, "target body searchable-term");

  const index = new VaultIndex(mkConfig(v));
  index.ingest();
  const rows = index.search({ query: "searchable-term" });
  const target = rows.find((r) => r.path === "target.md");
  const a = rows.find((r) => r.path === "a.md");
  assert.equal(target.backlinkCount, 1);
  assert.equal(a.backlinkCount, 0);

  index.close();
});
