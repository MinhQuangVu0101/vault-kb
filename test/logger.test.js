import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createLogger } from "../src/logger.js";

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-log-"));
  return path.join(dir, "nested", "vault-kb.log");
}

test("logger creates parent dir and writes JSON lines", () => {
  const logPath = tmpLog();
  const log = createLogger({ logPath });
  log.info({ event: "hello", n: 1 });
  log.error({ event: "boom", err: "x" });
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.level, "info");
  assert.equal(first.event, "hello");
  assert.equal(first.n, 1);
  assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("logger rotates at maxBytes threshold", () => {
  const logPath = tmpLog();
  const log = createLogger({ logPath, maxBytes: 200 });
  for (let i = 0; i < 10; i += 1) {
    log.info({ event: "pad", i, junk: "x".repeat(50) });
  }
  assert.ok(fs.existsSync(`${logPath}.1`), "rotated file should exist");
  assert.ok(fs.existsSync(logPath), "current log should exist");
});

test("logger never throws when directory is read-only", () => {
  const log = createLogger({ logPath: "/proc/readonly/vault-kb.log" });
  assert.doesNotThrow(() => log.info({ event: "unreachable" }));
  assert.doesNotThrow(() => log.error({ event: "still-fine" }));
  assert.equal(log.disabled, true);
});
