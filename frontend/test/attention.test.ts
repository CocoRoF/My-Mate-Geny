import assert from "node:assert/strict";
import { test } from "node:test";
import { cliUpdatesNeedAttention, providersNeedAttention, sessionsNeedAttention } from "../src/lib/attention.ts";

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

const ps = (...health: string[]) => ({
  ...p(true),
  session_attention: health.map((h, i) => ({ account_id: `a${i}`, label: `a${i}`, health: h, detail: "" })),
});

test("login sessions raise the badge only when the user has to act", () => {
  assert.equal(sessionsNeedAttention([ps("needs_login")]), true);
  assert.equal(sessionsNeedAttention([ps(), ps("refresh_failed")]), true);
  // information only: an access token that renews on the next use, one expiring soon, a valid one
  assert.equal(sessionsNeedAttention([ps("expired", "expiring", "valid")]), false);
  assert.equal(sessionsNeedAttention([p(true)]), false); // an older backend without the field
  assert.equal(sessionsNeedAttention([]), false);
});
