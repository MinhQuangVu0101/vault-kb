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

test("logger never throws when directory cannot be created", () => {
  // Use a path whose parent is a regular file, not a directory.
  // mkdirSync under a file fails on every platform with ENOTDIR/EEXIST,
  // which the logger catches and sets disabled = true.
  const blockerDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-log-blocker-"));
  const blockerFile = path.join(blockerDir, "not-a-dir");
  fs.writeFileSync(blockerFile, "this is a file, not a directory");
  const logPath = path.join(blockerFile, "subdir", "vault-kb.log");

  const log = createLogger({ logPath });
  assert.doesNotThrow(() => log.info({ event: "unreachable" }));
  assert.doesNotThrow(() => log.error({ event: "still-fine" }));
  assert.equal(log.disabled, true);
});
