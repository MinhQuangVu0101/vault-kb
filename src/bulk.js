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
 * @param {{ vaultRoot: string, origin: string, revertDir?: string }} opts
 *   `origin` is "bulk_update" or "bulk_revert": what wrote this bundle.
 * @returns {string} absolute path to the written bundle
 */
function writeRevertBundle(entries, { vaultRoot, origin, revertDir = REVERT_DIR }) {
  fs.mkdirSync(revertDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const baseId = createdAt.replace(/[:.]/g, "-");
  let id = nextRevertId(revertDir, baseId);
  for (;;) {
    const file = path.join(revertDir, `revert-${id}.json`);
    try {
      const fd = fs.openSync(file, "wx"); // exclusive: atomic backstop against a race
      try {
        const bundle = { schema: 2, id, createdAt, origin, vaultRoot, entries };
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
 * @returns {Array<{ id: string, file: string, schema: number|null, origin: string|null, vaultRoot: string|null, createdAt: string|null, notes: number, corrupt?: boolean }>}
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
        // A bundle without `origin` predates the field, and revert did not exist then,
        // so it can only have been written by a bulk update.
        origin: typeof data.origin === "string" ? data.origin : "bulk_update",
        vaultRoot: typeof data.vaultRoot === "string" ? data.vaultRoot : null,
        createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
        notes: Array.isArray(data.entries) ? data.entries.length : 0,
      });
    } catch {
      bundles.push({ id: stem, file, schema: null, origin: null, vaultRoot: null, createdAt: null, notes: 0, corrupt: true });
    }
  }
  bundles.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return bundles;
}

const BUNDLE_ID_RE = /^[0-9TZ-]+$/;

// Every response embeds these lists, and nothing prunes the bundle cache (the author's
// holds 1000+), so they are capped rather than returned whole.
const BUNDLE_LIST_CAP = 10;

/**
 * Newest-first, capped summary of an ascending-by-id bundle list.
 * @param {Array<any>} bundles
 * @param {(b: any) => any} shape
 * @returns {Array<any>}
 */
function summarizeBundles(bundles, shape) {
  return bundles.slice(-BUNDLE_LIST_CAP).reverse().map(shape);
}

/**
 * @param {number} n
 * @param {string} word
 * @returns {string}
 */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Message for the case where no bundle is selectable by default. It must say what else
 * is on disk, so a user whose only bundles are legacy or revert-origin ones is not told
 * there is nothing to revert.
 * @param {number} legacyCount
 * @param {number} redoCount
 * @returns {string}
 */
function noSelectableBundleMessage(legacyCount, redoCount) {
  if (legacyCount === 0 && redoCount === 0) return "No revert bundles for this vault.";
  const parts = ["No kb_bulk_update bundle to revert for this vault."];
  if (legacyCount > 0) {
    parts.push(
      `Found ${plural(legacyCount, "legacy bundle")} in the older format (see legacyBundles). A legacy bundle records`
      + " no vault, so it may belong to a different one; applying it needs an explicit bundleId plus force: true, and"
      + " it replaces the whole frontmatter object instead of individual keys.",
    );
  }
  if (redoCount > 0) {
    parts.push(
      `Found ${plural(redoCount, "bundle")} written by kb_bulk_revert itself. A revert-written bundle is never picked`
      + " by default; pass redoBundleId as bundleId to redo the edit the last revert undid.",
    );
  }
  return parts.join(" ");
}

/**
 * @param {{
 *   config?: any,
 *   bundleId?: string,
 *   apply?: boolean,
 *   force?: boolean,
 *   revertDir?: string,
 *   logger?: any,
 * }} [opts]
 * @returns {{
 *   applied: boolean,
 *   bundleId: string|null,
 *   vaultMatch: boolean|null,
 *   driftCheck: string,
 *   willRestore: any[],
 *   drifted: any[],
 *   missing: string[],
 *   unreadable: any[],
 *   availableBundles: any[],
 *   availableBundlesTotal: number,
 *   legacyBundles: any[],
 *   legacyBundlesTotal: number,
 *   redoBundleId: string|null,
 *   message?: string,
 *   revertFile?: string|null,
 *   restored?: string[],
 * }}
 */
export function runBulkRevert({ config, bundleId, apply = false, force = false, revertDir = undefined, logger = null } = {}) {
  const vaultRoot = config.vaultRoot;
  const dir = revertDir ?? REVERT_DIR;
  const all = listBundles(dir);
  const forVault = all.filter((b) => b.schema === 2 && b.vaultRoot === vaultRoot && !b.corrupt);
  // Default selection ignores bundles a revert wrote: applying one redoes the original
  // bulk edit, so a client retrying a default call would silently flip the vault back and
  // forth. Redo stays one explicit call away via redoBundleId.
  const selectable = forVault.filter((b) => b.origin === "bulk_update");
  const redoable = forVault.filter((b) => b.origin === "bulk_revert");
  // v1 bundles record no vaultRoot, so they cannot be attributed to this vault at all.
  const legacy = all.filter((b) => b.schema === 1 && !b.corrupt);
  const listing = {
    availableBundles: summarizeBundles(selectable, (b) => ({ id: b.id, createdAt: b.createdAt, notes: b.notes })),
    availableBundlesTotal: selectable.length,
    legacyBundles: summarizeBundles(legacy, (b) => ({ id: b.id, notes: b.notes })),
    legacyBundlesTotal: legacy.length,
    redoBundleId: redoable.length ? redoable[redoable.length - 1].id : null,
  };

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
    if (selectable.length === 0) {
      return {
        applied: false, bundleId: null, vaultMatch: true, driftCheck: "available",
        willRestore: [], drifted: [], missing: [], unreadable: [],
        ...listing,
        message: noSelectableBundleMessage(legacy.length, redoable.length),
      };
    }
    chosen = selectable[selectable.length - 1]; // newest by ascending id sort
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

  // Another vault's bundle: its relative paths would resolve against THIS vault and diff
  // this vault's notes (`Inbox.md` exists in both), previewing a restore that apply always
  // refuses. Report the mismatch instead of a plan. Apply falls through to the guard below,
  // which throws, so that path is unchanged.
  if (!apply && bundleVaultRoot !== null && bundleVaultRoot !== vaultRoot) {
    return {
      applied: false, bundleId: chosen.id, vaultMatch: false, driftCheck,
      willRestore: [], drifted: [], missing: [], unreadable: [],
      ...listing,
      message: `Bundle ${chosen.id} belongs to a different vault (${bundleVaultRoot}); nothing in this vault can be restored from it.`,
    };
  }

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
    willRestore, drifted, missing, unreadable, ...listing,
  };
  if (!apply) return view;

  // Apply-time guards.
  if (bundleVaultRoot !== null && bundleVaultRoot !== vaultRoot) {
    throw new Error(`Bundle ${chosen.id} belongs to a different vault (${bundleVaultRoot}); refusing to apply.`);
  }
  if (bundleVaultRoot === null && !force) {
    throw new Error(`Bundle ${chosen.id} has no vault identity; re-run with force:true to apply it here.`);
  }
  if (driftCheck === "unavailable" && !force) {
    throw new Error(`Bundle ${chosen.id} predates drift tracking; re-run with force:true for a blind restore.`);
  }

  // Write the pre-revert (redo) bundle FIRST so the revert is itself undoable.
  const redoEntries = restorePlans.map(({ rel, current, nextData }) => ({
    path: rel, frontmatter: current, after: nextData,
  }));
  const revertFile = redoEntries.length
    ? writeRevertBundle(redoEntries, { vaultRoot, origin: "bulk_revert", revertDir: dir })
    : null;

  let written = 0;
  for (const { abs, nextData, content } of restorePlans) {
    fs.writeFileSync(abs, matter.stringify(content, nextData), "utf8");
    written += 1;
  }

  logger?.info({ event: "bulk_revert", bundleId: chosen.id, restored: written, revertFile });

  return { ...view, applied: true, revertFile, restored: willRestore.map((w) => w.path) };
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
    ? writeRevertBundle(revertEntries, { vaultRoot: config.vaultRoot, origin: "bulk_update", revertDir })
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
