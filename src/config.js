import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const configSchema = z.object({
  vaultRoot: z.string().min(1),
  indexPath: z.string().default(".data/vault-index.sqlite"),
  hardExcludedFolders: z.array(z.string()).default([
    "20 Notes/Personal/Journal",
    "20 Notes/Personal/Therapy",
    ".obsidian",
    ".obsidian-mobile",
    ".git",
  ]),
  defaultLimits: z.object({
    search: z.number().int().positive().default(8),
    list: z.number().int().positive().default(25),
    readChars: z.number().int().positive().default(12000),
  }).default({
    search: 8,
    list: 25,
    readChars: 12000,
  }),
  maxLimits: z.object({
    search: z.number().int().positive().default(20),
    list: z.number().int().positive().default(100),
    readChars: z.number().int().positive().default(40000),
  }).default({
    search: 20,
    list: 100,
    readChars: 40000,
  }),
});

function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}

export function normalizeRelativeVaultPath(value) {
  const normalized = path.posix.normalize(toPosixPath(String(value ?? "")).trim().replace(/^\/+/, ""));
  if (!normalized || normalized === ".") {
    return "";
  }

  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path escapes vault root: ${value}`);
  }

  return normalized;
}

function normalizeFolderPrefix(value) {
  const normalized = normalizeRelativeVaultPath(value);
  if (!normalized) {
    throw new Error("Excluded folder prefixes cannot be empty.");
  }
  return normalized;
}

const defaultConfigPath = fileURLToPath(new URL("../vault-ai.config.json", import.meta.url));

export function loadConfig(configPath = defaultConfigPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}`);
  }

  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const parsed = configSchema.parse(rawConfig);
  const rootDir = path.dirname(configPath);
  const vaultRoot = path.resolve(rootDir, parsed.vaultRoot);
  const indexPath = path.resolve(rootDir, parsed.indexPath);
  const hardExcludedFolders = parsed.hardExcludedFolders.map(normalizeFolderPrefix);

  return {
    ...parsed,
    configPath,
    rootDir,
    vaultRoot,
    indexPath,
    hardExcludedFolders,
    hardExcludedFoldersLower: hardExcludedFolders.map((folder) => folder.toLowerCase()),
  };
}
