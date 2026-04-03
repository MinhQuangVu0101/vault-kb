import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import fg from "fast-glob";
import matter from "gray-matter";

import { normalizeRelativeVaultPath } from "./config.js";

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
  constructor(config) {
    this.config = config;
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
      ignore: this.config.hardExcludedFolders.flatMap((folder) => [
        folder,
        `${folder}/**`,
      ]),
    });

    let skippedWithoutAccess = 0;
    let indexedCount = 0;

    const notes = [];

    for (const file of files) {
      const relativePath = normalizeRelativeVaultPath(file);
      if (this.isHardExcluded(relativePath)) {
        continue;
      }

      const absolutePath = path.resolve(this.config.vaultRoot, ...relativePath.split("/"));
      const stat = fs.statSync(absolutePath);
      const rawContent = fs.readFileSync(absolutePath, "utf8");
      const note = this.parseNote(relativePath, rawContent, stat);

      if (!note.aiAccessible) {
        skippedWithoutAccess += 1;
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

    return {
      vaultRoot: this.config.vaultRoot,
      scannedMarkdownFiles: files.length,
      indexedNotes: indexedCount,
      skippedWithoutAccess,
      hardExcludedFolders: this.config.hardExcludedFolders,
      indexedAt: this.getLastIngestedAt(),
    };
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

    return this.db.prepare(sqlParts.join(" ")).all(...params);
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

    return this.db.prepare(sqlParts.join(" ")).all(...params);
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
    };
  }

  parseNote(relativePath, rawContent, stat) {
    const parsed = matter(rawContent);
    const data = parsed.data ?? {};
    const title = asString(data.title) || extractHeading(parsed.content) || path.posix.basename(relativePath, ".md");
    const tags = normalizeTags(data.tags);
    const folder = path.posix.dirname(relativePath) === "." ? "" : path.posix.dirname(relativePath);

    return {
      aiAccessible: asBoolean(data["ai-access"] ?? data.ai_access ?? data.aiAccess),
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
