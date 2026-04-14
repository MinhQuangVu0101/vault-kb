import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOG_PATH = path.join(os.homedir(), ".cache", "vault-kb", "vault-kb.log");
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export function createLogger({
  logPath = DEFAULT_LOG_PATH,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  let disabled = false;

  function ensureDir() {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  }

  function rotateIfNeeded() {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size >= maxBytes) {
        const rotated = `${logPath}.1`;
        fs.rmSync(rotated, { force: true });
        fs.renameSync(logPath, rotated);
      }
    } catch (err) {
      if (err?.code !== "ENOENT") {
        throw err;
      }
    }
  }

  function write(level, payload) {
    if (disabled) return;
    try {
      ensureDir();
      rotateIfNeeded();
      const entry = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        ...payload,
      });
      fs.appendFileSync(logPath, `${entry}\n`, "utf8");
    } catch {
      disabled = true;
    }
  }

  return {
    logPath,
    info: (payload) => write("info", payload),
    warn: (payload) => write("warn", payload),
    error: (payload) => write("error", payload),
    get disabled() { return disabled; },
  };
}
