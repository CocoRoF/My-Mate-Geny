import assert from "node:assert/strict";
import { test } from "node:test";
import { cliUpdatesNeedAttention, providersNeedAttention } from "../src/lib/attention.ts";

const p = (connected: boolean) => ({ provider: "x", connected, auth_mode: "", detail: "" });

test("the Settings badge only asks for action: none connected", () => {
  assert.equal(providersNeedAttention([p(true), p(true)]), false); // the old "2": plain information
  assert.equal(providersNeedAttention([p(true), p(false)]), false);
  assert.equal(providersNeedAttention([p(false), p(false)]), true);
  assert.equal(providersNeedAttention([]), false); // still loading
});

const cli = (o: Partial<{ update_available: boolean; possible: boolean; auto_upgrade: boolean; active: boolean | null }> = {}) => ({
  update_available: o.update_available ?? true,
  upgrade: { possible: o.possible ?? true },
  auto_upgrade: o.auto_upgrade ?? false,
  job: o.active == null ? null : { active: o.active },
});

test("CLI versions raise the badge only for a really newer version the user can install", () => {
  assert.equal(cliUpdatesNeedAttention([cli()]), true);
  assert.equal(cliUpdatesNeedAttention([cli({ update_available: false }), cli()]), true);
  assert.equal(cliUpdatesNeedAttention([cli({ update_available: false })]), false); // up to date / channel behind / unknown
  assert.equal(cliUpdatesNeedAttention([cli({ possible: false })]), false); // nothing to click here
  assert.equal(cliUpdatesNeedAttention([cli({ auto_upgrade: true })]), false); // the app takes care of it
  assert.equal(cliUpdatesNeedAttention([cli({ active: true })]), false); // already upgrading / waiting for idle
  assert.equal(cliUpdatesNeedAttention([cli({ active: false })]), true); // the last one finished (or failed)
  assert.equal(cliUpdatesNeedAttention(null), false); // still loading
  assert.equal(cliUpdatesNeedAttention([]), false);
});
