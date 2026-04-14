import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createStats } from "./stats.js";
import { VaultIndex } from "./vault-index.js";

function formatList(rows) {
  if (rows.length === 0) {
    return "No matching AI-accessible notes found.";
  }

  return rows.map((row, index) => {
    const tags = row.tags_text ? `tags: ${row.tags_text}` : "tags: -";
    const meta = [row.type || "-", row.area || "-", row.status || "-", row.updated || "-"].join(" | ");
    const excerpt = row.snippet || row.excerpt || "";

    return [
      `${index + 1}. ${row.title}`,
      `path: ${row.path}`,
      `meta: ${meta}`,
      tags,
      excerpt ? `excerpt: ${excerpt}` : "excerpt: -",
    ].join("\n");
  }).join("\n\n");
}

function formatReadResult(note) {
  return [
    `title: ${note.title}`,
    `path: ${note.path}`,
    `area: ${note.area || "-"}`,
    `type: ${note.type || "-"}`,
    `status: ${note.status || "-"}`,
    `updated: ${note.updated || "-"}`,
    `tags: ${note.tags_text || "-"}`,
    `truncated: ${note.truncated ? `yes (${note.maxChars} chars)` : "no"}`,
    "",
    note.rawContent,
  ].join("\n");
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
const vaultIndex = new VaultIndex(config, { logger, stats });
logger.info({ event: "startup", vaultRoot: config.vaultRoot, source: config.vaultRootSource });

function wrapTool(name, handler) {
  return async (args) => {
    stats.recordToolCall(name);
    logger.info({ event: "tool_call", tool: name, args });
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

const server = new McpServer({
  name: "quangs-vault-mcp",
  version: "0.1.0",
}, {
  capabilities: {
    tools: {},
  },
});

server.registerTool("kb_search", {
  title: "Search vault notes",
  description: "Search AI-accessible Obsidian notes with SQLite FTS5 keyword search.",
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
  description: "Read one AI-accessible note by vault-relative path.",
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
  description: "List AI-accessible notes by folder, tag, or status.",
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
    `indexedAt: ${report.indexedAt}`,
  ].join("\n"));
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
    ...snap,
  }, null, 2));
}));

const transport = new StdioServerTransport();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await server.close();
    vaultIndex.close();
    process.exit(0);
  });
}

await server.connect(transport);
