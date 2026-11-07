import assert from "node:assert/strict";
import { test } from "node:test";
import { isChunkError, isReloading } from "../src/lib/recover.ts";

test("a page on its way to a reload knows it", () => {
  (globalThis as any).window = {};
  assert.equal(isReloading(), false);
  (globalThis as any).window.__hrhReloading = "preload";
  assert.equal(isReloading(), true);
  delete (globalThis as any).window;
});

test("only a module that couldn't be fetched counts as a chunk failure", () => {
  assert.equal(isChunkError(new TypeError("Failed to fetch dynamically imported module: https://x/a.js")), true);
  assert.equal(isChunkError(new TypeError("Cannot read properties of undefined (reading 'default')")), false);
  assert.equal(isChunkError(null), false);
});
