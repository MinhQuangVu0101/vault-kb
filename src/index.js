#!/usr/bin/env node
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createStats } from "./stats.js";
import { VaultIndex } from "./vault-index.js";
import { createWatcher } from "./watcher.js";
import { runBulkUpdate, runBulkRevert } from "./bulk.js";
import { createEmbedder } from "./embeddings.js";
import { createWebServer } from "./web.js";
import { suggestLinks } from "./suggest-links.js";
import { relatedNotes } from "./related.js";

function formatList(rows) {
  if (rows.length === 0) {
    return "No matching AI-accessible notes found.";
  }

  return rows.map((row, index) => {
    const tags = row.tags_text ? `tags: ${row.tags_text}` : "tags: -";
    const meta = [row.type || "-", row.area || "-", row.status || "-", row.updated || "-"].join(" | ");
    const excerpt = row.snippet || row.excerpt || "";
    const backlinks = typeof row.backlinkCount === "number" ? `backlinks: ${row.backlinkCount}` : null;

    return [
      `${index + 1}. ${row.title}`,
      `path: ${row.path}`,
      `meta: ${meta}`,
      tags,
      backlinks,
      excerpt ? `excerpt: ${excerpt}` : "excerpt: -",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function formatReadResult(note) {
  const backlinkLines = (note.backlinks ?? []).slice(0, 20).map((b) => `  - ${b.path} — ${b.title ?? ""}`);
  const outlinkLines = (note.outlinks ?? []).slice(0, 20).map((o) => {
    if (o.unresolved) return `  - [[${o.raw}]] (unresolved)`;
    return `  - ${o.path} — ${o.title ?? ""}`;
  });

  const parts = [
    `title: ${note.title}`,
    `path: ${note.path}`,
    `area: ${note.area || "-"}`,
    `type: ${note.type || "-"}`,
    `status: ${note.status || "-"}`,
    `updated: ${note.updated || "-"}`,
    `tags: ${note.tags_text || "-"}`,
    `truncated: ${note.truncated ? `yes (${note.maxChars} chars)` : "no"}`,
  ];
  if (backlinkLines.length) parts.push(`backlinks (${note.backlinks.length}):`, ...backlinkLines);
  else parts.push("backlinks: none");
  if (outlinkLines.length) parts.push(`outlinks (${note.outlinks.length}):`, ...outlinkLines);
  else parts.push("outlinks: none");
  parts.push("", note.rawContent);
  return parts.join("\n");
}

function toolText(text) {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

const args = new Set(process.argv.slice(2));
const config = loadConfig();
const logger = createLogger();
const stats = createStats();
const llmEnabled = !args.has("--no-llm-summary");
const embedder = args.has("--no-embed") ? null : createEmbedder({
  logger,
  llmModel: llmEnabled ? config.llmModel : null,
});
const vaultIndex = new VaultIndex(config, { logger, stats, embedder });
logger.info({ event: "startup", vaultRoot: config.vaultRoot, source: config.vaultRootSource });

function wrapTool(name, handler) {
  return async (args) => {
    stats.recordToolCall(name);
    logger.info({ event: "tool_call", tool: name, args });
    ensureWatcherStarted();
    const t0 = Date.now();
    try {
      const result = await handler(args);
      logger.info({ event: "tool_ok", tool: name, duration_ms: Date.now() - t0 });
      return result;
    } catch (err) {
      logger.error({ event: "tool_error", tool: name, duration_ms: Date.now() - t0, error: String(err?.message ?? err), stack: err?.stack });
      stats.pushError({ tool: name, path: args?.path, message: err?.message ?? String(err) });
      throw err;
    }
  };
}

if (args.has("--print-config")) {
  console.log(JSON.stringify({
    configPath: config.configPath,
    vaultRoot: config.vaultRoot,
    indexPath: config.indexPath,
    hardExcludedFolders: config.hardExcludedFolders,
  }, null, 2));
  process.exit(0);
}

if (args.has("--ingest-only")) {
  console.log(JSON.stringify(vaultIndex.ingest(), null, 2));
  process.exit(0);
}

const initialStats = vaultIndex.ingest();
console.error(`[vault-mcp] Indexed ${initialStats.indexedNotes} AI-accessible notes from ${initialStats.scannedMarkdownFiles} markdown files.`);

if (embedder) {
  embedder.healthCheck().then((r) => {
    if (r.ok) {
      console.error(`[vault-mcp] Ollama ready (${r.resolvedModel})`);
      logger.info({ event: "ollama_health_ok", model: r.resolvedModel });
    } else if (r.code === "MODEL_MISSING") {
      const base = r.requestedModel.split(":")[0];
      console.error(`[vault-mcp] WARN: Ollama reachable but model '${base}' not installed - run: ollama pull ${base}`);
      logger.warn({ event: "ollama_model_missing", model: base, available: r.availableModels });
    } else {
      const { url } = embedder.status();
      console.error(`[vault-mcp] WARN: Ollama unreachable at ${url} (${r.message}) - run: ollama serve`);
      logger.warn({ event: "ollama_unreachable", url, error: r.message });
    }
  }).catch((err) => {
    logger.warn({ event: "ollama_health_error", error: String(err?.message ?? err) });
  });

  vaultIndex.embedAll().then((summary) => {
    console.error(`[vault-mcp] Embeddings: ${JSON.stringify(summary)}`);
    logger.info({ event: "embed_all_done", ...summary });
  }).catch((err) => {
    logger.warn({ event: "embed_all_error", error: String(err?.message ?? err) });
  });
}

const watcher = args.has("--no-watcher") ? null : createWatcher({ config, vaultIndex, logger, stats });
let lastIngestAt = Date.now();
const CATCHUP_INGEST_MS = 60_000;

// Watching the vault costs one open fd per file on macOS (chokidar without
// fsevents falls back to kqueue), so idle MCP sessions must not hold a
// watcher. Start it on first tool use; re-ingest first if the index may have
// gone stale since startup.
function ensureWatcherStarted() {
  if (!watcher || watcher.snapshot().active) return;
  try {
    if (Date.now() - lastIngestAt > CATCHUP_INGEST_MS) {
      vaultIndex.ingest();
      lastIngestAt = Date.now();
    }
    watcher.start();
  } catch (err) {
    logger.error({ event: "watcher_lazy_start_error", error: String(err?.message ?? err) });
  }
}

let web = null;
if (args.has("--web")) {
  ensureWatcherStarted();
  web = createWebServer({
    vaultIndex,
    embedder,
    logger,
    statsSource: () => ({
      vaultRoot: config.vaultRoot,
      vaultRootSource: config.vaultRootSource,
      logPath: logger.logPath,
      watcher: watcher ? watcher.snapshot() : { active: false, events: null },
      embeddings: {
        covered: vaultIndex.embeddingsCount(),
        total: stats.snapshot().indexed,
        ...(embedder ? embedder.status() : { model: null, llmModel: null, reachable: null, lastError: null }),
      },
      ...stats.snapshot(),
      topFolders: vaultIndex.getTopFolders(),
      topTags: vaultIndex.getTopTags(),
    }),
  });
  const info = await web.start();
  const publicUrl = process.env.VAULT_KB_PUBLIC_URL;
  const local = `http://${info.host}:${info.port}`;
  console.error(
    publicUrl
      ? `[vault-mcp] Web UI: ${local} · public: ${publicUrl}`
      : `[vault-mcp] Web UI: ${local}`,
  );
}

const server = new McpServer({
  name: "quangs-vault-mcp",
  version: "0.4.0",
}, {
  capabilities: {
    tools: {},
  },
});

server.registerTool("kb_search", {
  title: "Search vault notes",
  description: "Search AI-accessible Obsidian notes with SQLite FTS5 keyword search. For browsing vault structure, prefer kb_overview + kb_tree. Use this for keyword content matches.",
  inputSchema: {
    query: z.string().min(1),
    folder: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
  },
}, wrapTool("kb_search", async ({ query, folder, tag, limit }) => {
  const rows = vaultIndex.search({ query, folder, tag, limit });
  return toolText(formatList(rows));
}));

server.registerTool("kb_read", {
  title: "Read a note",
  description: "Read one AI-accessible note by vault-relative path. Use after kb_search, kb_list, or kb_tree once you have a specific path.",
  inputSchema: {
    path: z.string().min(1),
    maxChars: z.number().int().positive().optional(),
  },
}, wrapTool("kb_read", async ({ path, maxChars }) => {
  const note = vaultIndex.readNote(path, maxChars);
  return toolText(formatReadResult(note));
}));

server.registerTool("kb_list", {
  title: "List notes",
  description: "List AI-accessible notes by folder, tag, or status. Use after kb_overview or kb_tree to enumerate notes within a known folder.",
  inputSchema: {
    folder: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
  },
}, wrapTool("kb_list", async ({ folder, tag, status, limit }) => {
  const rows = vaultIndex.list({ folder, tag, status, limit });
  return toolText(formatList(rows));
}));

server.registerTool("kb_ingest", {
  title: "Re-index the vault",
  description: "Rebuild the local SQLite FTS index from AI-accessible notes.",
}, wrapTool("kb_ingest", async () => {
  const report = vaultIndex.ingest();
  return toolText([
    "Vault index refreshed.",
    `vaultRoot: ${report.vaultRoot}`,
    `scannedMarkdownFiles: ${report.scannedMarkdownFiles}`,
    `indexedNotes: ${report.indexedNotes}`,
    `skipped: missingAccess=${report.skipped.missingAccess}, explicitFalse=${report.skipped.explicitFalse}, hardExcluded=${report.skipped.hardExcluded}, parseError=${report.skipped.parseError}`,
    `prunedEmbeddings: ${report.prunedEmbeddings ?? 0}`,
    `indexedAt: ${report.indexedAt}`,
  ].join("\n"));
}));

server.registerTool("kb_semantic", {
  title: "Semantic search",
  description: "Embedding-based search via local Ollama. Returns notes ranked by cosine similarity. Requires Ollama running and embeddings populated. For browsing vault structure, prefer kb_overview + kb_tree. Use this for meaning-based content matches.",
  inputSchema: {
    query: z.string().min(1),
    folder: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
  },
}, wrapTool("kb_semantic", async ({ query, folder, tag, limit }) => {
  const rows = await vaultIndex.semanticSearch({ query, folder, tag, limit });
  return toolText(formatList(rows.map((r) => ({ ...r, snippet: r.excerpt, score: r.score.toFixed(3) }))));
}));

server.registerTool("kb_suggest_links", {
  title: "Suggest missing links",
  description: "For a given note, return top-N similar notes that are NOT already linked (in or out), each with a one-sentence LLM-generated reason for why they might belong together. Requires embeddings populated and (optionally) an Ollama chat model for reasons.",
  inputSchema: {
    path: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
    minScore: z.number().min(0).max(1).optional(),
  },
}, wrapTool("kb_suggest_links", async ({ path, limit, minScore }) => {
  if (!embedder) {
    return toolText("Embedder disabled (--no-embed). kb_suggest_links is unavailable.");
  }
  const rows = await suggestLinks({ vaultIndex, embedder, path, limit, minScore });
  if (rows.length === 0) {
    return toolText("No link suggestions above threshold.");
  }
  const lines = rows.map((r, i) => {
    const reason = r.reason ? `\n   why: ${r.reason}` : "";
    return `${i + 1}. ${r.title}\n   path: ${r.path}\n   score: ${r.score.toFixed(3)}${reason}`;
  });
  return toolText(lines.join("\n\n"));
}));

server.registerTool("kb_related", {
  title: "Related notes",
  description: "For a given note, return top-N most similar notes regardless of link status. Uses embedding cosine similarity. Lower-friction sibling of kb_suggest_links — no link-graph filtering. Use after you have a specific note path. For discovering vault structure, use kb_tree.",
  inputSchema: {
    path: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
    minScore: z.number().min(0).max(1).optional(),
  },
}, wrapTool("kb_related", async ({ path, limit, minScore }) => {
  if (!embedder) {
    return toolText("Embedder disabled (--no-embed). kb_related is unavailable.");
  }
  const rows = await relatedNotes({ vaultIndex, path, limit, minScore });
  if (rows.length === 0) {
    return toolText("No related notes above threshold.");
  }
  const lines = rows.map((r, i) =>
    `${i + 1}. ${r.title}\n   path: ${r.path}\n   score: ${r.score.toFixed(3)}`
  );
  return toolText(lines.join("\n\n"));
}));

server.registerTool("kb_orphans", {
  title: "Find orphan notes",
  description: "List notes with no incoming and no outgoing resolved links. Vault-wide cleanup query. Sort: most recently updated first.",
  inputSchema: {
    limit: z.number().int().min(1).max(200).optional(),
  },
}, wrapTool("kb_orphans", async ({ limit }) => {
  const rows = vaultIndex.findOrphans({ limit: limit ?? 50 });
  if (rows.length === 0) {
    return toolText("No orphan notes found.");
  }
  const lines = rows.map((r, i) => {
    const tags = r.tags_text ? `tags: ${r.tags_text}` : "tags: -";
    const meta = [r.type || "-", r.area || "-", r.status || "-", r.updated || "-"].join(" | ");
    return `${i + 1}. ${r.title}\n   path: ${r.path}\n   meta: ${meta}\n   ${tags}`;
  });
  return toolText(lines.join("\n\n"));
}));

server.registerTool("kb_dead_links", {
  title: "Find dead links",
  description: "List every unresolved [[Reference]] in the vault, grouped by source note. Sort: source path ascending.",
  inputSchema: {
    limit: z.number().int().min(1).max(200).optional(),
  },
}, wrapTool("kb_dead_links", async ({ limit }) => {
  const rows = vaultIndex.findDeadLinks({ limit: limit ?? 50 });
  if (rows.length === 0) {
    return toolText("No dead links found.");
  }
  const lines = rows.map((r, i) => {
    const brokenList = r.broken.map((ref) => `[[${ref}]]`).join(", ");
    return `${i + 1}. ${r.title}\n   path: ${r.path}\n   broken: ${brokenList}`;
  });
  return toolText(lines.join("\n\n"));
}));

server.registerTool("kb_bulk_update", {
  title: "Bulk update note frontmatter",
  description: "Match notes by folder/tag/frontmatter/paths and apply frontmatter ops (addTags, removeTags, setFields, unsetFields, setAccess). Dry-run unless apply=true. Writes a revert bundle when applied.",
  inputSchema: {
    match: z.object({
      folder: z.string().optional(),
      tag: z.string().optional(),
      frontmatter: z.record(z.string(), z.any()).optional(),
      paths: z.array(z.string()).optional(),
    }).optional(),
    ops: z.object({
      addTags: z.array(z.string()).optional(),
      removeTags: z.array(z.string()).optional(),
      setFields: z.record(z.string(), z.any()).optional(),
      unsetFields: z.array(z.string()).optional(),
      setAccess: z.boolean().optional(),
    }),
    apply: z.boolean().optional(),
  },
}, wrapTool("kb_bulk_update", async ({ match, ops, apply }) => {
  const result = runBulkUpdate({ config, match, ops, apply: Boolean(apply), logger });
  if (apply && result.matched > 0) {
    for (const { path: p } of result.changes) vaultIndex.ingestOne(p);
  }
  return toolText(JSON.stringify(result, null, 2));
}));

server.registerTool("kb_bulk_revert", {
  title: "Revert a bulk frontmatter update",
  description: "Undo a kb_bulk_update by restoring frontmatter from its revert bundle. By default reverts the newest kb_bulk_update bundle for this vault; bundles written by a revert itself are never picked by default, so redoing a revert takes an explicit bundleId (the response returns it as redoBundleId). Field-level: only the keys the bulk edit changed are restored, so later edits to other keys survive. Dry-run unless apply=true. Notes whose frontmatter changed since the bulk edit are skipped and reported as drifted; force=true restores them anyway and overwrites those newer changes. On a legacy bundle (listed as legacyBundles, no drift data) force=true also replaces the whole frontmatter object instead of individual keys, dropping every key added since the edit. If anything is restored, writes a new revert bundle so the revert is itself undoable.",
  inputSchema: {
    bundleId: z.string().optional(),
    apply: z.boolean().optional(),
    force: z.boolean().optional(),
  },
}, wrapTool("kb_bulk_revert", async ({ bundleId, apply, force }) => {
  const result = runBulkRevert({ config, bundleId, apply: Boolean(apply), force: Boolean(force), logger });
  if (apply && result.restored?.length) {
    for (const p of result.restored) vaultIndex.ingestOne(p);
  }
  return toolText(JSON.stringify(result, null, 2));
}));

server.registerTool("kb_overview", {
  title: "Vault overview",
  description: "Entry point for vault exploration. Run this first when working in the user's Obsidian vault — returns a one-shot snapshot of total note count, top-level folder breakdown, and recently-touched notes. Use the returned folder paths with kb_tree (drill-in) or kb_list (notes within a folder). No arguments.",
}, wrapTool("kb_overview", async () => {
  const ov = vaultIndex.overview();
  return toolText(JSON.stringify(ov, null, 2));
}));

server.registerTool("kb_tree", {
  title: "Folder tree",
  description: "Return a hierarchical folder tree with note counts per folder. Use after kb_overview to drill into a specific section of the vault. Returns folder structure only — no note titles. For listing notes inside a folder, use kb_list. Defaults to vault root, depth 2.",
  inputSchema: {
    path: z.string().optional(),
    depth: z.number().int().min(0).max(6).optional(),
  },
}, wrapTool("kb_tree", async ({ path: treePath, depth }) => {
  const t = vaultIndex.tree({ path: treePath, depth });
  return toolText(JSON.stringify(t, null, 2));
}));

server.registerTool("kb_stats", {
  title: "Index health stats",
  description: "Report vault-kb index health: counts, skip breakdown, last ingest, recent errors.",
}, wrapTool("kb_stats", async () => {
  const snap = stats.snapshot();
  return toolText(JSON.stringify({
    vaultRoot: config.vaultRoot,
    vaultRootSource: config.vaultRootSource,
    logPath: logger.logPath,
    loggerDisabled: logger.disabled,
    watcher: watcher ? watcher.snapshot() : { active: false, events: null },
    embeddings: {
      covered: vaultIndex.embeddingsCount(),
      total: snap.indexed,
      ...(embedder ? embedder.status() : { model: null, llmModel: null, reachable: null, lastError: null }),
    },
    ...snap,
  }, null, 2));
}));

const transport = new StdioServerTransport();

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "shutdown", reason });
  // If cleanup hangs we still must die; a lingering server leaks vault fds.
  const failsafe = setTimeout(() => process.exit(0), 2_000);
  failsafe.unref();
  try {
    await watcher?.stop();
    await web?.stop();
    await server.close();
    vaultIndex.close();
  } catch (err) {
    logger.error({ event: "shutdown_error", error: String(err?.message ?? err) });
  }
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

// MCP stdio convention: when the client process dies, our stdin hits EOF.
// Without this the server survives every crashed or killed session as an
// orphan (PPID 1) holding the vault watcher's file descriptors open.
process.stdin.on("end", () => shutdown("stdin_end"));
process.stdin.on("close", () => shutdown("stdin_close"));

await server.connect(transport);
