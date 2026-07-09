import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const SERVER_PATH = fileURLToPath(new URL("../src/index.js", import.meta.url));

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeVault() {
  const vault = tmpDir("vault-kb-lifecycle-vault-");
  fs.writeFileSync(
    path.join(vault, "note.md"),
    "---\nai-access: true\ntitle: Lifecycle Note\n---\n\nlifecycle test note\n",
  );
  return vault;
}

function startServer(t) {
  const child = spawn(process.execPath, [SERVER_PATH, "--no-embed", "--no-llm-summary"], {
    cwd: tmpDir("vault-kb-lifecycle-runtime-"),
    env: { ...process.env, VAULT_KB_VAULT_PATH: makeVault() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderrText = "";
  child.stderr.on("data", (chunk) => {
    child.stderrText += chunk;
  });
  child.stdin.on("error", () => {});
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return child;
}

function waitForStartup(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (child.stderrText.includes("Indexed")) {
        clearTimeout(timer);
        child.stderr.off("data", check);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      child.stderr.off("data", check);
      reject(new Error(`server did not finish startup; stderr:\n${child.stderrText}`));
    }, timeoutMs);
    child.stderr.on("data", check);
    check();
  });
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function readResponse(child, id, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === id) {
          cleanup();
          resolve(message);
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for response id=${id}; stderr:\n${child.stderrText}`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onData);
    }
    child.stdout.on("data", onData);
  });
}

function exitWithin(child, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server still running ${ms}ms after stdin closed`)),
      ms,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function initialize(child) {
  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lifecycle-test", version: "0.0.0" },
    },
  });
  await readResponse(child, 1);
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
}

test("server exits when stdin closes before any MCP handshake", async (t) => {
  const child = startServer(t);
  await waitForStartup(child);

  child.stdin.end();
  const { code } = await exitWithin(child, 3_000);
  assert.equal(code, 0);
});

test("server starts watcher lazily on first tool call and exits on stdin EOF", async (t) => {
  const child = startServer(t);
  await waitForStartup(child);
  await initialize(child);

  send(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "kb_stats", arguments: {} },
  });
  const response = await readResponse(child, 2);
  const stats = JSON.parse(response.result.content[0].text);
  assert.equal(stats.watcher.active, true, "first tool call should start the watcher");
  assert.equal(stats.indexed, 1);

  child.stdin.end();
  const { code } = await exitWithin(child, 3_000);
  assert.equal(code, 0);
});
