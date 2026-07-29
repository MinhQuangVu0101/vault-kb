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
 * Enumerate revert bundles by basename. Never throws on a corrupt sibling.
 * @param {string} [revertDir]
 * @returns {Array<{ id: string, file: string, schema: number|null, vaultRoot: string|null, createdAt: string|null, notes: number, corrupt?: boolean }>}
 */
export function listBundles(revertDir = REVERT_DIR) {
  let files;
  try {
    files = fs.readdirSync(revertDir).filter((f) => /^revert-.*\.json$/.test(f));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const bundles = [];
  for (const f of files) {
    const stem = f.replace(/^revert-/, "").replace(/\.json$/, "");
    const file = path.join(revertDir, f);
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      bundles.push({
        id: typeof data.id === "string" ? data.id : stem,
        file,
        schema: typeof data.schema === "number" ? data.schema : 1,
        vaultRoot: typeof data.vaultRoot === "string" ? data.vaultRoot : null,
        createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
        notes: Array.isArray(data.entries) ? data.entries.length : 0,
      });
    } catch {
      bundles.push({ id: stem, file, schema: null, vaultRoot: null, createdAt: null, notes: 0, corrupt: true });
    }
  }
  bundles.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return bundles;
}

const BUNDLE_ID_RE = /^[0-9TZ-]+$/;

/**
 * @param {{
 *   config?: any,
 *   bundleId?: string,
 *   apply?: boolean,
 *   force?: boolean,
 *   revertDir?: string,
 *   logger?: any,
 * }} [opts]
 */
export function runBulkRevert({ config, bundleId, apply = false, force = false, revertDir = undefined, logger = null } = {}) {
  const vaultRoot = config.vaultRoot;
  const dir = revertDir ?? REVERT_DIR;
  const all = listBundles(dir);
  const forVault = all.filter((b) => b.schema === 2 && b.vaultRoot === vaultRoot && !b.corrupt);
  const availableBundles = forVault.map((b) => ({ id: b.id, createdAt: b.createdAt, notes: b.notes }));

  if (bundleId !== undefined && bundleId !== null) {
    if (!BUNDLE_ID_RE.test(String(bundleId))) {
      throw new Error(`Invalid bundleId: ${bundleId}`);
    }
  }

  // Select the bundle: search enumerated basenames, never build a path from input.
  let chosen;
  if (bundleId) {
    chosen = all.find((b) => b.id === String(bundleId));
    if (!chosen) throw new Error(`No revert bundle with id ${bundleId}`);
  } else {
    if (forVault.length === 0) {
      return {
        applied: false, bundleId: null, vaultMatch: true, driftCheck: "available",
        willRestore: [], drifted: [], missing: [], unreadable: [],
        availableBundles, message: "No revert bundles for this vault.",
      };
    }
    chosen = forVault[forVault.length - 1]; // newest by ascending id sort
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(chosen.file, "utf8"));
  } catch (err) {
    throw new Error(`Revert bundle ${chosen.id} is unreadable: ${String(err?.message ?? err)}`);
  }
  if (!Array.isArray(data.entries)) throw new Error(`Revert bundle ${chosen.id} has no entries`);

  const driftCheck = data.entries.every((e) => e && typeof e === "object" && "after" in e)
    ? "available" : "unavailable";
  const bundleVaultRoot = typeof data.vaultRoot === "string" ? data.vaultRoot : null;
  const vaultMatch = bundleVaultRoot === null ? null : bundleVaultRoot === vaultRoot;

  const willRestore = [];
  const drifted = [];
  const missing = [];
  const unreadable = [];
  const restorePlans = []; // { abs, rel, current, nextData, content }

  for (const entry of data.entries) {
    const rawRel = entry && entry.path;
    let safeRel;
    try {
      safeRel = normalizeRelativeVaultPath(rawRel);
    } catch {
      unreadable.push({ path: String(rawRel), error: "path escapes vault root" });
      continue;
    }
    const abs = path.resolve(vaultRoot, ...safeRel.split("/"));
    const rootResolved = path.resolve(vaultRoot);
    if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
      unreadable.push({ path: safeRel, error: "path escapes vault root" });
      continue;
    }
    if (!fs.existsSync(abs)) { missing.push(safeRel); continue; }

    let parsed;
    try {
      parsed = matter(fs.readFileSync(abs, "utf8"));
    } catch (err) {
      unreadable.push({ path: safeRel, error: String(err?.message ?? err) });
      continue;
    }
    const current = parsed.data ?? {};
    const before = entry.frontmatter ?? {};
    const hasAfter = "after" in entry;
    const after = hasAfter ? (entry.after ?? {}) : null;

    let K;
    let next;
    let driftedKeys = [];
    if (hasAfter) {
      K = changedKeys(before, after);
      driftedKeys = K.filter((k) => stableStringify(current[k]) !== stableStringify(after[k]));
      next = { ...current };
      for (const k of K) {
        if (k in before) next[k] = before[k];
        else delete next[k];
      }
    } else {
      // v1 blind restore: replace the whole frontmatter with the recorded before.
      next = { ...before };
      K = changedKeys(current, next);
    }

    if (driftedKeys.length > 0) {
      drifted.push({ path: safeRel, keys: driftedKeys });
      if (!force) continue;
    }

    const diff = {};
    for (const k of K) {
      const a = current[k];
      const b = k in next ? next[k] : undefined;
      if (stableStringify(a) !== stableStringify(b)) {
        diff[k] = { before: a ?? null, after: b ?? null };
      }
    }
    if (Object.keys(diff).length === 0) continue;
    willRestore.push({ path: safeRel, diff });
    restorePlans.push({ abs, rel: safeRel, current, nextData: next, content: parsed.content });
  }

  const view = {
    applied: false, bundleId: chosen.id, vaultMatch, driftCheck,
    willRestore, drifted, missing, unreadable, availableBundles,
  };
  return view;
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
