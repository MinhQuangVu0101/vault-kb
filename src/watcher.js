import path from "node:path";

import chokidar from "chokidar";

const DEBOUNCE_MS = 300;

/** @param {{ config?: any, vaultIndex?: any, logger?: any, stats?: any, debounceMs?: number }} [opts] */
export function createWatcher({ config, vaultIndex, logger, stats, debounceMs = DEBOUNCE_MS } = {}) {
  const events = { add: 0, change: 0, unlink: 0, error: 0 };
  const pending = new Map();
  let watcher = null;
  let active = false;

  function toRelative(absPath) {
    return path.relative(config.vaultRoot, absPath).split(path.sep).join("/");
  }

  function isHardExcluded(relPath) {
    const lower = relPath.toLowerCase();
    return config.hardExcludedFoldersLower.some(
      (folder) => lower === folder || lower.startsWith(`${folder}/`),
    );
  }

  async function handle(kind, relPath) {
    try {
      if (kind === "unlink") {
        vaultIndex.removeOne(relPath);
        return;
      }
      const result = vaultIndex.ingestOne(relPath);
      if (result.action === "upserted") {
        const row = vaultIndex.db.prepare("SELECT title, body FROM notes WHERE path = ?").get(relPath);
        if (row) await vaultIndex.embedIfStale(relPath, { title: row.title, body: row.body }).catch(() => {});
      }
    } catch (err) {
      events.error += 1;
      logger?.error({ event: "watcher_handle_error", kind, path: relPath, error: String(err?.message ?? err) });
      stats?.pushError({ tool: "watcher", path: relPath, message: err?.message ?? String(err) });
    }
  }

  function schedule(kind, relPath) {
    const existing = pending.get(relPath);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      pending.delete(relPath);
      handle(kind, relPath);
    }, debounceMs);
    pending.set(relPath, { kind, timer });
  }

  function onEvent(kind, absPath) {
    if (!absPath.endsWith(".md")) return;
    const relPath = toRelative(absPath);
    if (!relPath || relPath.startsWith("..")) return;
    if (isHardExcluded(relPath)) return;
    events[kind] += 1;
    logger?.info({ event: "watcher_event", kind, path: relPath });
    schedule(kind, relPath);
  }

  function start() {
    if (active) return;
    watcher = chokidar.watch(config.vaultRoot, {
      ignored: (p) => {
        if (p === config.vaultRoot) return false;
        const rel = path.relative(config.vaultRoot, p).split(path.sep).join("/");
        if (!rel) return false;
        return isHardExcluded(rel);
      },
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    watcher.on("add", (p) => onEvent("add", p));
    watcher.on("change", (p) => onEvent("change", p));
    watcher.on("unlink", (p) => onEvent("unlink", p));
    watcher.on("error", (err) => {
      events.error += 1;
      logger?.error({ event: "watcher_error", error: String(err?.message ?? err) });
    });
    active = true;
    logger?.info({ event: "watcher_started", vaultRoot: config.vaultRoot });
  }

  async function stop() {
    if (!active) return;
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
    await watcher?.close();
    watcher = null;
    active = false;
    logger?.info({ event: "watcher_stopped" });
  }

  function snapshot() {
    return { active, events: { ...events }, pending: pending.size };
  }

  return { start, stop, snapshot };
}
