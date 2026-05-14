import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import fg from "fast-glob";
import matter from "gray-matter";

import { normalizeRelativeVaultPath } from "./config.js";
import { blobToFloats, cosineSimilarity, floatsToBlob } from "./embeddings.js";
import { buildResolver, parseLinks } from "./links.js";

function asString(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value).trim();
}

function asBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }

  return false;
}

function normalizeTags(tagsValue) {
  if (Array.isArray(tagsValue)) {
    return tagsValue
      .map((tag) => asString(tag).replace(/^#/, "").toLowerCase())
      .filter(Boolean);
  }

  if (typeof tagsValue === "string") {
    return tagsValue
      .split(",")
      .map((tag) => tag.trim().replace(/^#/, "").toLowerCase())
      .filter(Boolean);
  }

  return [];
}

function extractHeading(markdownBody) {
  const match = markdownBody.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function buildExcerpt(markdownBody, maxLength = 220) {
  const cleaned = markdownBody
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^#.*$/gm, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_>`~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "";
  }

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, maxLength - 1).trim()}...`;
}

function sanitizeSearchQuery(query) {
  const normalized = String(query ?? "")
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .trim();

  const terms = normalized.split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    throw new Error("Search query is empty after sanitizing.");
  }

  return terms.map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(" AND ");
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export class VaultIndex {
  constructor(config, { logger = null, stats = null, embedder = null } = {}) {
    this.config = config;
    this.logger = logger;
    this.stats = stats;
    this.embedder = embedder;
    ensureDirForFile(config.indexPath);
    this.db = new Database(config.indexPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.createSchema();
    this.prepareStatements();
  }

  close() {
    this.db.close();
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        path TEXT PRIMARY KEY,
        folder TEXT NOT NULL,
        title TEXT NOT NULL,
        area TEXT,
        type TEXT,
        status TEXT,
        updated TEXT,
        tags_text TEXT NOT NULL,
        tags_filter TEXT NOT NULL,
        excerpt TEXT,
        body TEXT NOT NULL,
        frontmatter_json TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        path UNINDEXED,
        title,
        tags_text,
        body,
        tokenize = 'porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        path TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        vector BLOB NOT NULL,
        embedded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS links (
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        target_raw TEXT NOT NULL,
        unresolved INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_links_source ON links (source);
      CREATE INDEX IF NOT EXISTS idx_links_target ON links (target);
    `);
  }

  prepareStatements() {
    this.clearNotesStmt = this.db.prepare("DELETE FROM notes");
    this.clearFtsStmt = this.db.prepare("DELETE FROM notes_fts");
    this.insertNoteStmt = this.db.prepare(`
      INSERT INTO notes (
        path,
        folder,
        title,
        area,
        type,
        status,
        updated,
        tags_text,
        tags_filter,
        excerpt,
        body,
        frontmatter_json,
        size_bytes,
        mtime_ms
      ) VALUES (
        @path,
        @folder,
        @title,
        @area,
        @type,
        @status,
        @updated,
        @tags_text,
        @tags_filter,
        @excerpt,
        @body,
        @frontmatter_json,
        @size_bytes,
        @mtime_ms
      )
    `);
    this.insertFtsStmt = this.db.prepare(`
      INSERT INTO notes_fts (
        path,
        title,
        tags_text,
        body
      ) VALUES (
        @path,
        @title,
        @tags_text,
        @body
      )
    `);
    this.setMetaStmt = this.db.prepare(`
      INSERT INTO meta (key, value)
      VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.getMetaStmt = this.db.prepare("SELECT value FROM meta WHERE key = ?");
    this.deleteOneNoteStmt = this.db.prepare("DELETE FROM notes WHERE path = ?");
    this.deleteOneFtsStmt = this.db.prepare("DELETE FROM notes_fts WHERE path = ?");
    this.getEmbeddingStmt = this.db.prepare("SELECT model, content_hash, vector FROM embeddings WHERE path = ?");
    this.upsertEmbeddingStmt = this.db.prepare(`
      INSERT INTO embeddings (path, model, content_hash, vector, embedded_at)
      VALUES (@path, @model, @content_hash, @vector, @embedded_at)
      ON CONFLICT(path) DO UPDATE SET
        model = excluded.model,
        content_hash = excluded.content_hash,
        vector = excluded.vector,
        embedded_at = excluded.embedded_at
    `);
    this.deleteEmbeddingStmt = this.db.prepare("DELETE FROM embeddings WHERE path = ?");
    this.countEmbeddingsStmt = this.db.prepare("SELECT COUNT(*) AS c FROM embeddings");
    this.listEmbeddingsStmt = this.db.prepare("SELECT path, vector FROM embeddings");
    this.findRelatedRowsStmt = this.db.prepare(`
      SELECT notes.path, notes.title, notes.folder, notes.tags_text, notes.excerpt,
             notes.area, notes.type, notes.status, notes.updated,
             embeddings.vector
      FROM embeddings JOIN notes ON notes.path = embeddings.path
    `);
    this.deleteLinksForSourceStmt = this.db.prepare("DELETE FROM links WHERE source = ?");
    this.insertLinkStmt = this.db.prepare(
      "INSERT INTO links (source, target, target_raw, unresolved) VALUES (?, ?, ?, ?)",
    );
    this.backlinksStmt = this.db.prepare(`
      SELECT DISTINCT links.source AS path, notes.title
      FROM links JOIN notes ON notes.path = links.source
      WHERE links.target = ? AND links.unresolved = 0
      ORDER BY notes.title COLLATE NOCASE
    `);
    this.outlinksStmt = this.db.prepare(`
      SELECT links.target AS path, links.target_raw AS raw, links.unresolved, notes.title
      FROM links LEFT JOIN notes ON notes.path = links.target
      WHERE links.source = ?
      ORDER BY links.target_raw COLLATE NOCASE
    `);
    this.backlinkCountStmt = this.db.prepare(
      "SELECT target AS path, COUNT(*) AS c FROM links WHERE unresolved = 0 GROUP BY target",
    );
    this.searchBaseSql = `
      SELECT
        notes.path,
        notes.folder,
        notes.title,
        notes.area,
        notes.type,
        notes.status,
        notes.updated,
        notes.tags_text,
        notes.excerpt,
        snippet(notes_fts, 3, '<<', '>>', ' ... ', 18) AS snippet,
        bm25(notes_fts, 1.0, 4.0, 2.0, 1.0) AS score
      FROM notes_fts
      JOIN notes ON notes.path = notes_fts.path
      WHERE notes_fts MATCH ?
    `;
  }

  ingest() {
    const files = fg.sync("**/*.md", {
      cwd: this.config.vaultRoot,
      onlyFiles: true,
      dot: true,
      unique: true,
    });

    const skipped = {
      missingAccess: 0,
      explicitFalse: 0,
      hardExcluded: 0,
      parseError: 0,
    };
    let indexedCount = 0;

    const notes = [];

    for (const file of files) {
      const relativePath = normalizeRelativeVaultPath(file);
      if (this.isHardExcluded(relativePath)) {
        skipped.hardExcluded += 1;
        continue;
      }

      const absolutePath = path.resolve(this.config.vaultRoot, ...relativePath.split("/"));
      let note;
      try {
        const stat = fs.statSync(absolutePath);
        const rawContent = fs.readFileSync(absolutePath, "utf8");
        note = this.parseNote(relativePath, rawContent, stat);
      } catch (err) {
        skipped.parseError += 1;
        this.logger?.warn({ tool: "kb_ingest", path: relativePath, error: String(err?.message ?? err) });
        this.stats?.pushError({ tool: "kb_ingest", path: relativePath, message: err?.message ?? String(err), code: "parseError" });
        continue;
      }

      if (!note.aiAccessible) {
        if (note.accessReason === "explicitFalse") skipped.explicitFalse += 1;
        else skipped.missingAccess += 1;
        continue;
      }

      notes.push(note);
      indexedCount += 1;
    }

    const writeAll = this.db.transaction((items) => {
      this.clearFtsStmt.run();
      this.clearNotesStmt.run();

      for (const item of items) {
        this.insertNoteStmt.run(item);
        this.insertFtsStmt.run(item);
      }

      this.setMetaStmt.run({
        key: "last_ingest_at",
        value: new Date().toISOString(),
      });
      this.setMetaStmt.run({
        key: "last_indexed_count",
        value: String(items.length),
      });
    });

    writeAll(notes);

    const report = {
      vaultRoot: this.config.vaultRoot,
      scannedMarkdownFiles: files.length,
      indexedNotes: indexedCount,
      skipped,
      skippedWithoutAccess: skipped.missingAccess + skipped.explicitFalse,
      hardExcludedFolders: this.config.hardExcludedFolders,
      indexedAt: this.getLastIngestedAt(),
    };
    this.rebuildAllLinks();
    this.stats?.recordIngest(report);
    return report;
  }

  ingestOne(requestedPath) {
    const relativePath = normalizeRelativeVaultPath(requestedPath);
    if (this.isHardExcluded(relativePath)) {
      return { path: relativePath, action: "skipped", reason: "hardExcluded" };
    }

    const absolutePath = path.resolve(this.config.vaultRoot, ...relativePath.split("/"));
    if (!fs.existsSync(absolutePath)) {
      return this.removeOne(relativePath);
    }

    let note;
    try {
      const stat = fs.statSync(absolutePath);
      const rawContent = fs.readFileSync(absolutePath, "utf8");
      note = this.parseNote(relativePath, rawContent, stat);
    } catch (err) {
      this.logger?.warn({ tool: "watcher", path: relativePath, error: String(err?.message ?? err) });
      this.stats?.pushError({ tool: "watcher", path: relativePath, message: err?.message ?? String(err), code: "parseError" });
      return { path: relativePath, action: "skipped", reason: "parseError" };
    }

    if (!note.aiAccessible) {
      this.removeOne(relativePath);
      return { path: relativePath, action: "skipped", reason: note.accessReason };
    }

    const tx = this.db.transaction((item) => {
      this.deleteOneNoteStmt.run(item.path);
      this.deleteOneFtsStmt.run(item.path);
      this.insertNoteStmt.run(item);
      this.insertFtsStmt.run(item);
    });
    tx(note);
    this.rebuildLinksForSource(relativePath, note.body);

    return { path: relativePath, action: "upserted" };
  }

  removeOne(requestedPath) {
    const relativePath = normalizeRelativeVaultPath(requestedPath);
    const tx = this.db.transaction((p) => {
      this.deleteOneNoteStmt.run(p);
      this.deleteOneFtsStmt.run(p);
      this.deleteEmbeddingStmt.run(p);
      this.deleteLinksForSourceStmt.run(p);
    });
    tx(relativePath);
    return { path: relativePath, action: "removed" };
  }

  replaceLinksForSource(sourcePath, rawLinks, resolver) {
    const tx = this.db.transaction(() => {
      this.deleteLinksForSourceStmt.run(sourcePath);
      for (const raw of rawLinks) {
        const resolved = resolver(raw);
        this.insertLinkStmt.run(
          sourcePath,
          resolved ?? "",
          raw,
          resolved ? 0 : 1,
        );
      }
    });
    tx();
  }

  rebuildAllLinks() {
    const rows = this.db.prepare("SELECT path, body FROM notes").all();
    const resolver = buildResolver(rows.map((r) => r.path));
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM links").run();
      for (const row of rows) {
        const raws = parseLinks(row.body);
        for (const raw of raws) {
          const resolved = resolver(raw);
          this.insertLinkStmt.run(row.path, resolved ?? "", raw, resolved ? 0 : 1);
        }
      }
    });
    tx();
  }

  rebuildLinksForSource(sourcePath, body) {
    const rows = this.db.prepare("SELECT path FROM notes").all();
    const resolver = buildResolver(rows.map((r) => r.path));
    this.replaceLinksForSource(sourcePath, parseLinks(body), resolver);
  }

  getBacklinks(targetPath) {
    return this.backlinksStmt.all(targetPath);
  }

  getOutlinks(sourcePath) {
    return this.outlinksStmt.all(sourcePath).map((row) => ({
      path: row.path || null,
      raw: row.raw,
      title: row.title ?? null,
      unresolved: Boolean(row.unresolved),
    }));
  }

  backlinkCounts() {
    const map = new Map();
    for (const { path: p, c } of this.backlinkCountStmt.all()) map.set(p, c);
    return map;
  }

  async embedIfStale(relativePath, { title, body }) {
    if (!this.embedder) return { path: relativePath, action: "skipped", reason: "noEmbedder" };
    const hash = this.embedder.contentHash(title, body);
    const existing = this.getEmbeddingStmt.get(relativePath);
    if (existing && existing.content_hash === hash) {
      return { path: relativePath, action: "cached" };
    }
    const result = await this.embedder.embedNote({ title, body });
    if (!result) return { path: relativePath, action: "failed" };
    this.upsertEmbeddingStmt.run({
      path: relativePath,
      model: result.model,
      content_hash: result.contentHash,
      vector: floatsToBlob(result.vector),
      embedded_at: new Date().toISOString(),
    });
    return { path: relativePath, action: "embedded" };
  }

  async embedAll({ concurrency = 4 } = {}) {
    if (!this.embedder) return { embedded: 0, cached: 0, failed: 0, skipped: 0 };
    const rows = this.db.prepare("SELECT path, title, body FROM notes").all();
    const summary = { embedded: 0, cached: 0, failed: 0, skipped: 0 };
    const queue = rows.slice();
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const row = queue.shift();
        if (!row) return;
        try {
          const r = await this.embedIfStale(row.path, { title: row.title, body: row.body });
          summary[r.action] = (summary[r.action] ?? 0) + 1;
        } catch (err) {
          summary.failed += 1;
          this.logger?.warn({ event: "embed_error", path: row.path, error: String(err?.message ?? err) });
        }
      }
    });
    await Promise.all(workers);
    return summary;
  }

  embeddingsCount() {
    return this.countEmbeddingsStmt.get()?.c ?? 0;
  }

  async semanticSearch({ query, folder, tag, limit = 8 }) {
    if (!this.embedder) throw new Error("Embedder not configured.");
    if (!query || !String(query).trim()) throw new Error("Query is empty.");
    if (this.embeddingsCount() === 0) {
      throw new Error("No embeddings yet. Run kb_ingest after Ollama is reachable.");
    }

    const qVector = await this.embedder.embedQuery(String(query).trim());

    const filterSql = [];
    const params = [];
    if (folder) {
      const f = normalizeRelativeVaultPath(folder);
      filterSql.push("AND (folder = ? OR folder LIKE ?)");
      params.push(f, `${f}/%`);
    }
    if (tag) {
      const t = String(tag).replace(/^#/, "").toLowerCase();
      filterSql.push("AND tags_filter LIKE ?");
      params.push(`%|${t}|%`);
    }

    const sql = `
      SELECT notes.path, notes.title, notes.folder, notes.tags_text, notes.excerpt,
             notes.area, notes.type, notes.status, notes.updated,
             embeddings.vector
      FROM embeddings JOIN notes ON notes.path = embeddings.path
      WHERE 1=1 ${filterSql.join(" ")}
    `;
    const rows = this.db.prepare(sql).all(...params);

    const scored = rows.map((row) => {
      const vec = blobToFloats(row.vector);
      return { ...row, score: cosineSimilarity(qVector, vec) };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit).map(({ vector, ...rest }) => rest);
    return this.#annotateBacklinkCounts(top);
  }

  findRelatedByPath(sourcePath, { limit = 5, excludePaths = [] } = {}) {
    const source = this.getEmbeddingStmt.get(sourcePath);
    if (!source) {
      throw new Error(`No embedding for path: ${sourcePath}`);
    }
    const sourceVec = blobToFloats(source.vector);
    const exclude = new Set([sourcePath, ...excludePaths]);

    const rows = this.findRelatedRowsStmt.all();

    const scored = [];
    for (const row of rows) {
      if (exclude.has(row.path)) continue;
      const vec = blobToFloats(row.vector);
      scored.push({ ...row, score: cosineSimilarity(sourceVec, vec) });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit).map(({ vector, ...rest }) => rest);
    return this.#annotateBacklinkCounts(top);
  }

  findOrphans({ limit = 50 } = {}) {
    const allPaths = this.db.prepare("SELECT path FROM notes").all().map((r) => r.path);
    if (allPaths.length === 0) return [];
    const resolve = buildResolver(allPaths);

    const linkedTo = new Set();
    const linkedFrom = new Set();
    const rows = this.db.prepare("SELECT path, body FROM notes").all();
    for (const note of rows) {
      const refs = parseLinks(note.body);
      let any = false;
      for (const raw of refs) {
        const resolved = resolve(raw);
        if (resolved) {
          linkedTo.add(resolved);
          any = true;
        }
      }
      if (any) linkedFrom.add(note.path);
    }

    const orphanPaths = allPaths.filter((p) => !linkedTo.has(p) && !linkedFrom.has(p));
    if (orphanPaths.length === 0) return [];

    const placeholders = orphanPaths.map(() => "?").join(",");
    const orphanRows = this.db.prepare(`
      SELECT path, title, folder, tags_text, excerpt, area, type, status, updated
      FROM notes
      WHERE path IN (${placeholders})
      ORDER BY updated DESC
      LIMIT ?
    `).all(...orphanPaths, limit);
    return orphanRows;
  }

  findDeadLinks({ limit = 50 } = {}) {
    const allPaths = this.db.prepare("SELECT path FROM notes").all().map((r) => r.path);
    if (allPaths.length === 0) return [];
    const resolve = buildResolver(allPaths);

    const grouped = new Map();
    const rows = this.db.prepare("SELECT path, title, body FROM notes").all();
    for (const note of rows) {
      const refs = parseLinks(note.body);
      const broken = [];
      for (const raw of refs) {
        if (!resolve(raw)) broken.push(raw);
      }
      if (broken.length > 0) {
        grouped.set(note.path, { path: note.path, title: note.title, broken });
      }
    }

    return Array.from(grouped.values())
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, limit);
  }

  ensureIndexed() {
    if (!this.getLastIngestedAt()) {
      return this.ingest();
    }
    return null;
  }

  getLastIngestedAt() {
    const row = this.getMetaStmt.get("last_ingest_at");
    return row?.value ?? null;
  }

  search({ query, folder, tag, limit }) {
    this.ensureIndexed();

    const normalizedLimit = this.clampLimit(limit, "search");
    const sqlParts = [this.searchBaseSql];
    const params = [sanitizeSearchQuery(query)];

    if (folder) {
      const normalizedFolder = normalizeRelativeVaultPath(folder);
      sqlParts.push("AND (notes.folder = ? OR notes.folder LIKE ?)");
      params.push(normalizedFolder, `${normalizedFolder}/%`);
    }

    if (tag) {
      const normalizedTag = asString(tag).replace(/^#/, "").toLowerCase();
      sqlParts.push("AND notes.tags_filter LIKE ?");
      params.push(`%|${normalizedTag}|%`);
    }

    sqlParts.push("ORDER BY score ASC, notes.updated DESC LIMIT ?");
    params.push(normalizedLimit);

    const rows = this.db.prepare(sqlParts.join(" ")).all(...params);
    return this.#annotateBacklinkCounts(rows);
  }

  #annotateBacklinkCounts(rows) {
    if (!rows.length) return rows;
    const counts = this.backlinkCounts();
    return rows.map((row) => ({ ...row, backlinkCount: counts.get(row.path) ?? 0 }));
  }

  list({ folder, tag, status, limit }) {
    this.ensureIndexed();

    const normalizedLimit = this.clampLimit(limit, "list");
    const sqlParts = [`
      SELECT
        path,
        folder,
        title,
        area,
        type,
        status,
        updated,
        tags_text,
        excerpt
      FROM notes
      WHERE 1 = 1
    `];
    const params = [];

    if (folder) {
      const normalizedFolder = normalizeRelativeVaultPath(folder);
      sqlParts.push("AND (folder = ? OR folder LIKE ?)");
      params.push(normalizedFolder, `${normalizedFolder}/%`);
    }

    if (tag) {
      const normalizedTag = asString(tag).replace(/^#/, "").toLowerCase();
      sqlParts.push("AND tags_filter LIKE ?");
      params.push(`%|${normalizedTag}|%`);
    }

    if (status) {
      sqlParts.push("AND status = ?");
      params.push(asString(status));
    }

    sqlParts.push("ORDER BY updated DESC, title COLLATE NOCASE ASC LIMIT ?");
    params.push(normalizedLimit);

    const rows = this.db.prepare(sqlParts.join(" ")).all(...params);
    return this.#annotateBacklinkCounts(rows);
  }

  readNote(requestedPath, maxChars) {
    const relativePath = normalizeRelativeVaultPath(requestedPath);
    if (this.isHardExcluded(relativePath)) {
      throw new Error("This note is inside a private excluded area.");
    }

    const absolutePath = this.resolveVaultPath(relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Note not found: ${relativePath}`);
    }

    const stat = fs.statSync(absolutePath);
    const rawContent = fs.readFileSync(absolutePath, "utf8");
    const parsedNote = this.parseNote(relativePath, rawContent, stat);

    if (!parsedNote.aiAccessible) {
      throw new Error("This note is not AI-accessible. Add ai-access: true first.");
    }

    const resolvedMaxChars = Math.min(
      Math.max(Number(maxChars) || this.config.defaultLimits.readChars, 500),
      this.config.maxLimits.readChars,
    );
    const truncated = rawContent.length > resolvedMaxChars;
    const content = truncated ? `${rawContent.slice(0, resolvedMaxChars)}\n\n[truncated]` : rawContent;

    return {
      ...parsedNote,
      rawContent: content,
      truncated,
      maxChars: resolvedMaxChars,
      absolutePath,
      backlinks: this.getBacklinks(relativePath),
      outlinks: this.getOutlinks(relativePath),
    };
  }

  parseNote(relativePath, rawContent, stat) {
    const parsed = matter(rawContent);
    const data = parsed.data ?? {};
    const title = asString(data.title) || extractHeading(parsed.content) || path.posix.basename(relativePath, ".md");
    const tags = normalizeTags(data.tags);
    const folder = path.posix.dirname(relativePath) === "." ? "" : path.posix.dirname(relativePath);
    const accessRaw = data["ai-access"] ?? data.ai_access ?? data.aiAccess;
    const aiAccessible = asBoolean(accessRaw);
    const accessReason = aiAccessible
      ? "accessible"
      : accessRaw === undefined || accessRaw === null || accessRaw === ""
        ? "missingAccess"
        : "explicitFalse";

    return {
      aiAccessible,
      accessReason,
      path: relativePath,
      folder,
      title,
      area: asString(data.area),
      type: asString(data.type),
      status: asString(data.status),
      updated: asString(data.updated) || new Date(stat.mtimeMs).toISOString(),
      tags_text: tags.join(", "),
      tags_filter: tags.length ? `|${tags.join("|")}|` : "",
      excerpt: buildExcerpt(parsed.content),
      body: parsed.content.trim(),
      frontmatter_json: JSON.stringify(data),
      size_bytes: Buffer.byteLength(rawContent, "utf8"),
      mtime_ms: stat.mtimeMs,
    };
  }

  resolveVaultPath(relativePath) {
    const absolutePath = path.resolve(this.config.vaultRoot, ...relativePath.split("/"));
    const normalizedRoot = `${path.resolve(this.config.vaultRoot).toLowerCase()}${path.sep}`;
    const normalizedAbsolutePath = absolutePath.toLowerCase();

    if (normalizedAbsolutePath !== path.resolve(this.config.vaultRoot).toLowerCase() && !normalizedAbsolutePath.startsWith(normalizedRoot)) {
      throw new Error("Resolved path escaped the vault root.");
    }

    return absolutePath;
  }

  isHardExcluded(relativePath) {
    const normalized = normalizeRelativeVaultPath(relativePath).toLowerCase();
    return this.config.hardExcludedFoldersLower.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`));
  }

  clampLimit(limit, kind) {
    const fallback = this.config.defaultLimits[kind];
    const cap = this.config.maxLimits[kind];
    const numeric = Number(limit);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return fallback;
    }
    return Math.min(Math.floor(numeric), cap);
  }
}
