import assert from "node:assert/strict";
import { test } from "node:test";
import { providersNeedAttention } from "../src/lib/attention.ts";

const p = (connected: boolean) => ({ provider: "x", connected, auth_mode: "", detail: "" });

test("the Settings badge only asks for action: none connected", () => {
  assert.equal(providersNeedAttention([p(true), p(true)]), false); // the old "2": plain information
  assert.equal(providersNeedAttention([p(true), p(false)]), false);
  assert.equal(providersNeedAttention([p(false), p(false)]), true);
  assert.equal(providersNeedAttention([]), false); // still loading
});
