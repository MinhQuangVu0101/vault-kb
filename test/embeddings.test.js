import test from "node:test";
import assert from "node:assert/strict";

import { blobToFloats, cosineSimilarity, createEmbedder, floatsToBlob } from "../src/embeddings.js";

test("cosineSimilarity: identical vectors = 1", () => {
  const v = Float32Array.from([1, 2, 3]);
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-6);
});

test("cosineSimilarity: orthogonal vectors = 0", () => {
  const a = Float32Array.from([1, 0]);
  const b = Float32Array.from([0, 1]);
  assert.equal(cosineSimilarity(a, b), 0);
});

test("cosineSimilarity: opposite vectors = -1", () => {
  const a = Float32Array.from([1, 1]);
  const b = Float32Array.from([-1, -1]);
  assert.ok(Math.abs(cosineSimilarity(a, b) - -1) < 1e-6);
});

test("cosineSimilarity: mismatched lengths return 0", () => {
  const a = Float32Array.from([1, 2, 3]);
  const b = Float32Array.from([1, 2]);
  assert.equal(cosineSimilarity(a, b), 0);
});

test("floatsToBlob / blobToFloats round-trips", () => {
  const v = Float32Array.from([0.1, -0.2, 3.14, -1e5]);
  const round = blobToFloats(floatsToBlob(v));
  assert.equal(round.length, v.length);
  for (let i = 0; i < v.length; i += 1) {
    assert.ok(Math.abs(round[i] - v[i]) < 1e-6);
  }
});

test("contentHash is stable and input-dependent", () => {
  const e = createEmbedder({ fetchFn: async () => { throw new Error("no"); } });
  const h1 = e.contentHash("t", "body");
  const h2 = e.contentHash("t", "body");
  const h3 = e.contentHash("t", "body!");
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test("embedNote gracefully returns null when fetch fails and marks unreachable", async () => {
  const e = createEmbedder({
    fetchFn: async () => { throw new Error("ECONNREFUSED"); },
  });
  const result = await e.embedNote({ title: "t", body: "b" });
  assert.equal(result, null);
  assert.equal(e.status().reachable, false);
  assert.match(e.status().lastError.message, /ECONNREFUSED/);
});

test("embedNote retries with halved input on context-length error", async () => {
  const long = "x".repeat(4000);
  const calls = [];
  const e = createEmbedder({
    fetchFn: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.prompt.length);
      if (calls.length === 1) {
        return { ok: false, status: 500, text: async () => '{"error":"input length exceeds the context length"}' };
      }
      return { ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) };
    },
  });
  const result = await e.embedNote({ title: "t", body: long });
  assert.ok(result);
  assert.ok(calls[1] < calls[0], "second attempt should use shorter input");
});

test("embedNote succeeds on a well-formed mock response", async () => {
  const e = createEmbedder({
    fetchFn: async () => ({ ok: true, json: async () => ({ embedding: [1, 2, 3] }) }),
  });
  const r = await e.embedNote({ title: "t", body: "b" });
  assert.deepEqual(Array.from(r.vector), [1, 2, 3]);
  assert.equal(e.status().reachable, true);
  assert.equal(e.status().lastError, null);
});
