import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const configSchema = z.object({
  vaultRoot: z.string().min(1).optional(),
  indexPath: z.string().default(".data/vault-index.sqlite"),
  hardExcludedFolders: z.array(z.string()).default([
    ".obsidian",
    ".obsidian-mobile",
    ".git",
    ".stversions",
    ".trash",
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
  llmModel: z.string().min(1).default("llama3.2:3b"),
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
const VAULT_PATH_ENV = "VAULT_KB_VAULT_PATH";

export function resolveVaultRoot({ env = process.env, configVaultRoot, configPath } = {}) {
  const fromEnv = env[VAULT_PATH_ENV];
  if (fromEnv && fromEnv.trim()) {
    return { vaultRoot: fromEnv.trim(), source: "env" };
  }
  if (configVaultRoot && String(configVaultRoot).trim()) {
    return { vaultRoot: String(configVaultRoot).trim(), source: "config" };
  }
  const hint = configPath ? ` or set "vaultRoot" in ${configPath}` : "";
  throw new Error(
    `Vault path not configured. Set ${VAULT_PATH_ENV} env var${hint}.`,
  );
}

export function loadConfig(configPath = defaultConfigPath, { env = process.env } = {}) {
  const configExists = fs.existsSync(configPath);
  const rawConfig = configExists
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const parsed = configSchema.parse(rawConfig);
  const rootDir = configExists ? path.dirname(configPath) : process.cwd();

  const { vaultRoot: rawVaultRoot, source: vaultRootSource } = resolveVaultRoot({
    env,
    configVaultRoot: parsed.vaultRoot,
    configPath: configExists ? configPath : null,
  });

  const vaultRoot = path.resolve(rootDir, rawVaultRoot);
  if (!fs.existsSync(vaultRoot)) {
    throw new Error(`Vault root does not exist: ${vaultRoot} (source: ${vaultRootSource})`);
  }

  const indexPath = path.resolve(rootDir, parsed.indexPath);
  const hardExcludedFolders = parsed.hardExcludedFolders.map(normalizeFolderPrefix);

  return {
    ...parsed,
    configPath: configExists ? configPath : null,
    configExists,
    rootDir,
    vaultRoot,
    vaultRootSource,
    indexPath,
    hardExcludedFolders,
    hardExcludedFoldersLower: hardExcludedFolders.map((folder) => folder.toLowerCase()),
  };
}
