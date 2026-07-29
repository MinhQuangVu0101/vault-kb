import test from "node:test";
import assert from "node:assert/strict";

import { stableStringify, changedKeys } from "../src/bulk.js";

test("stableStringify is order-insensitive for object keys", () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});

test("stableStringify is order-sensitive for arrays", () => {
  assert.notEqual(stableStringify(["a", "b"]), stableStringify(["b", "a"]));
});

test("stableStringify handles nested objects without false diff", () => {
  assert.equal(
    stableStringify({ x: { p: 1, q: 2 } }),
    stableStringify({ x: { q: 2, p: 1 } }),
  );
});

test("changedKeys reports only differing keys", () => {
  const before = { status: "draft", area: "health" };
  const after = { status: "active", area: "health" };
  assert.deepEqual(changedKeys(before, after), ["status"]);
});

test("changedKeys reports added and removed keys", () => {
  assert.deepEqual(changedKeys({}, { tags: ["x"] }).sort(), ["tags"]);
  assert.deepEqual(changedKeys({ old: 1 }, {}).sort(), ["old"]);
});

test("stableStringify distinguishes different Date values", () => {
  const d1 = new Date("2024-01-15");
  const d2 = new Date("2024-02-20");
  assert.notEqual(stableStringify(d1), stableStringify(d2));
});

test("changedKeys detects changes to date-valued fields", () => {
  const d1 = new Date("2024-01-15");
  const d2 = new Date("2024-02-20");
  const before = { created: d1 };
  const after = { created: d2 };
  assert.deepEqual(changedKeys(before, after), ["created"]);
});

test("stableStringify serializes Date identically to its ISO string", () => {
  const d = new Date("2024-01-15T00:00:00.000Z");
  const isoString = d.toISOString();
  assert.equal(stableStringify(d), stableStringify(isoString));
});
