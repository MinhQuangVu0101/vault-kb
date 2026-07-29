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

test("buildResolver: NFC link resolves NFD-encoded path", () => {
  // macOS stores filenames NFD-decomposed ("o" + combining diaeresis) while
  // wikilinks are typed NFC (precomposed "\u00f6"). Escapes keep forms explicit.
  const nfdPath = "10 Personal/Plans/Perso\u0308nliche Todos.md";
  const resolve = buildResolver([nfdPath]);
  assert.equal(resolve("Pers\u00f6nliche Todos"), nfdPath);
  assert.equal(resolve("10 Personal/Plans/Pers\u00f6nliche Todos"), nfdPath);
});

test("buildResolver: NFD link resolves NFC-encoded path", () => {
  const nfcPath = "60 Projects/\u00dcbersicht.md";
  const resolve = buildResolver([nfcPath]);
  assert.equal(resolve("U\u0308bersicht"), nfcPath);
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

test("ingestOne: NFC and NFD path variants address the same note row", () => {
  const v = tmpVault();
  // File created NFD-decomposed, as macOS filesystems report names.
  write(v, "Perso\u0308nliche Todos.md", { "ai-access": true }, "todo body");

  const index = new VaultIndex(mkConfig(v));
  index.ingest();
  const count = () => index.db.prepare("SELECT COUNT(*) AS c FROM notes").get().c;
  assert.equal(count(), 1);

  // Re-ingest via the NFC form (as a tool caller would type it): must upsert
  // the existing row, not create a duplicate under a second key.
  const result = index.ingestOne("Pers\u00f6nliche Todos.md");
  assert.equal(result.action, "upserted");
  assert.equal(count(), 1);

  index.close();
});

test("readNote: NFC path reads an NFD-named file", () => {
  const v = tmpVault();
  write(v, "Perso\u0308nliche Todos.md", { "ai-access": true }, "todo body");

  const index = new VaultIndex(mkConfig(v));
  index.ingest();

  // Guards the NFD fallback on byte-strict filesystems (Linux CI); on macOS
  // APFS the primary lookup already succeeds.
  const note = index.readNote("Pers\u00f6nliche Todos.md");
  assert.ok(note.rawContent.includes("todo body"));

  index.close();
});
