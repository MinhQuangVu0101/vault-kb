import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import matter from "gray-matter";

import { normalizeRelativeVaultPath } from "./config.js";

/**
 * Canonical JSON: object keys sorted recursively, array order preserved.
 * @param {any} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Keys whose values differ between two frontmatter objects (by stableStringify).
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @returns {string[]}
 */
export function changedKeys(before, after) {
  const b = before ?? {};
  const a = after ?? {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out = [];
  for (const k of keys) {
    if (stableStringify(b[k]) !== stableStringify(a[k])) out.push(k);
  }
  return out;
}

const REVERT_DIR = path.join(os.homedir(), ".cache", "vault-kb", "reverts");

function normalizeTag(t) {
  return String(t ?? "").trim().replace(/^#/, "").toLowerCase();
}

function getTags(data) {
  const raw = data.tags;
  if (Array.isArray(raw)) return raw.map(normalizeTag).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map(normalizeTag).filter(Boolean);
  return [];
}

function setTags(data, tags) {
  if (tags.length === 0) {
    if ("tags" in data) delete data.tags;
  } else {
    data.tags = tags;
  }
}

function matchesPath(relPath, match) {
  if (match.paths?.length) {
    const set = new Set(match.paths.map((p) => normalizeRelativeVaultPath(p)));
    if (!set.has(relPath)) return false;
  }
  if (match.folder) {
    const folder = normalizeRelativeVaultPath(match.folder);
    if (relPath !== folder && !relPath.startsWith(`${folder}/`)) return false;
  }
  return true;
}

function matchesContent(data, match) {
  if (match.tag) {
    const want = normalizeTag(match.tag);
    if (!getTags(data).includes(want)) return false;
  }
  if (match.frontmatter) {
    for (const [k, v] of Object.entries(match.frontmatter)) {
      if (data[k] !== v) return false;
    }
  }
  return true;
}

function applyOps(data, ops) {
  const next = { ...data };
  if (ops.addTags?.length) {
    const current = new Set(getTags(next));
    for (const t of ops.addTags) current.add(normalizeTag(t));
    setTags(next, [...current].filter(Boolean));
  }
  if (ops.removeTags?.length) {
    const rm = new Set(ops.removeTags.map(normalizeTag));
    setTags(next, getTags(next).filter((t) => !rm.has(t)));
  }
  if (ops.setFields) {
    for (const [k, v] of Object.entries(ops.setFields)) {
      next[k] = v;
    }
  }
  if (ops.unsetFields?.length) {
    for (const k of ops.unsetFields) delete next[k];
  }
  if (typeof ops.setAccess === "boolean") {
    next["ai-access"] = ops.setAccess;
  }
  return next;
}

function frontmatterDiff(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff = {};
  for (const k of keys) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diff[k] = { before: a ?? null, after: b ?? null };
    }
  }
  return diff;
}

/**
 * First `revert-<id>.json` name not already present, suffixing `-1`, `-2`, ...
 * Pure so the collision path is deterministically testable.
 * @param {string} revertDir
 * @param {string} baseId
 * @param {(file: string) => boolean} [existsFn]
 * @returns {string}
 */
export function nextRevertId(revertDir, baseId, existsFn = (f) => fs.existsSync(f)) {
  let id = baseId;
  let counter = 0;
  while (existsFn(path.join(revertDir, `revert-${id}.json`))) {
    counter += 1;
    id = `${baseId}-${counter}`;
  }
  return id;
}

/**
 * @param {Array<{ path: string, frontmatter: object, after: object }>} entries
 * @param {{ vaultRoot: string, revertDir?: string }} opts
 * @returns {string} absolute path to the written bundle
 */
function writeRevertBundle(entries, { vaultRoot, revertDir = REVERT_DIR }) {
  fs.mkdirSync(revertDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const baseId = createdAt.replace(/[:.]/g, "-");
  let id = nextRevertId(revertDir, baseId);
  for (;;) {
    const file = path.join(revertDir, `revert-${id}.json`);
    try {
      const fd = fs.openSync(file, "wx"); // exclusive: atomic backstop against a race
      try {
        const bundle = { schema: 2, id, createdAt, vaultRoot, entries };
        fs.writeFileSync(fd, JSON.stringify(bundle, null, 2));
      } finally {
        fs.closeSync(fd);
      }
      return file;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        id = nextRevertId(revertDir, baseId);
        continue;
      }
      throw err;
    }
  }
}

/**
 * @param {{
 *   config?: any,
 *   match?: { paths?: string[], folder?: string, tag?: string, frontmatter?: Record<string, any> },
 *   ops?: { addTags?: string[], removeTags?: string[], setFields?: Record<string, any>, unsetFields?: string[], setAccess?: boolean },
 *   apply?: boolean,
 *   logger?: any,
 *   revertDir?: string,
 * }} [opts]
 */
export function runBulkUpdate({ config, match = {}, ops = {}, apply = false, logger = null, revertDir = undefined } = {}) {
  const hasOp = Boolean(
    ops.addTags?.length
      || ops.removeTags?.length
      || (ops.setFields && Object.keys(ops.setFields).length)
      || ops.unsetFields?.length
      || typeof ops.setAccess === "boolean",
  );
  if (!hasOp) throw new Error("No operations specified.");

  const vaultRoot = config.vaultRoot;
  const walked = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(vaultRoot, abs).split(path.sep).join("/");
      if (entry.isDirectory()) {
        const lower = rel.toLowerCase();
        if (config.hardExcludedFoldersLower.some((f) => lower === f || lower.startsWith(`${f}/`))) continue;
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        walked.push(rel);
      }
    }
  };
  walk(vaultRoot);

  const changes = [];
  for (const rel of walked) {
    if (!matchesPath(rel, match)) continue;

    const abs = path.resolve(vaultRoot, ...rel.split("/"));
    let raw;
    try {
      raw = fs.readFileSync(abs, "utf8");
    } catch (err) {
      logger?.warn({ tool: "kb_bulk_update", path: rel, error: String(err?.message ?? err) });
      continue;
    }

    const parsed = matter(raw);
    const data = parsed.data ?? {};
    if (!matchesContent(data, match)) continue;

    const nextData = applyOps(data, ops);
    const diff = frontmatterDiff(data, nextData);
    if (Object.keys(diff).length === 0) continue;

    changes.push({ path: rel, abs, before: data, after: nextData, content: parsed.content, diff });
  }

  if (!apply) {
    return {
      applied: false,
      matched: changes.length,
      changes: changes.map(({ path: p, diff }) => ({ path: p, diff })),
    };
  }

  const revertEntries = changes.map(({ path: p, before, after }) => ({ path: p, frontmatter: before, after }));
  const revertFile = revertEntries.length
    ? writeRevertBundle(revertEntries, { vaultRoot: config.vaultRoot, revertDir })
    : null;

  for (const { abs, after, content } of changes) {
    const nextRaw = matter.stringify(content, after);
    fs.writeFileSync(abs, nextRaw, "utf8");
  }

  logger?.info({ event: "bulk_update", matched: changes.length, revertFile });

  return {
    applied: true,
    matched: changes.length,
    revertFile,
    changes: changes.map(({ path: p, diff }) => ({ path: p, diff })),
  };
}
