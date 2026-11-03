// An account card's login-session row and plan-freshness note (src/lib/loginSession.ts). Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { detailKey, HEALTH_KEY, HEALTH_TONE, planStale, renewResultKey, sessionActions } from "../src/lib/loginSession.ts";

const sess = (o: Record<string, unknown> = {}) =>
  ({
    method: "oauth",
    email: "",
    organization: "",
    plan: "",
    rate_limit_tier: "",
    expires_at: null,
    expires_in_s: null,
    has_refresh_token: true,
    refresh_expires_at: null,
    updated_at: null,
    scopes: [],
    health: "valid",
    detail: "",
    actionable: false,
    renewable: true,
    checked_at: null,
    ...o,
  }) as any;

test("buttons: renew while it can be renewed; sign in again first only when that's the way out", () => {
  assert.deepEqual(sessionActions(sess()), { renew: true, relogin: true, reloginFirst: false });
  assert.deepEqual(sessionActions(sess({ health: "expired", detail: "renews_on_use" })), { renew: true, relogin: true, reloginFirst: false });
  assert.deepEqual(sessionActions(sess({ health: "refresh_failed", actionable: true })), { renew: true, relogin: true, reloginFirst: true });
  assert.deepEqual(sessionActions(sess({ health: "needs_login", renewable: false, actionable: true })), {
    renew: false,
    relogin: true,
    reloginFirst: true,
  });
  // an API key / long-lived token: nothing to renew or sign in to here
  assert.deepEqual(sessionActions(sess({ method: "api_key", renewable: false })), { renew: false, relogin: false, reloginFirst: false });
  assert.deepEqual(sessionActions(null), { renew: false, relogin: false, reloginFirst: false });
});

test("an expired access token that renews on use reads as information, not an error", () => {
  assert.equal(detailKey({ health: "expired", detail: "renews_on_use" }), "providers.sessDetailRenewsOnUse");
  assert.equal(detailKey({ health: "expiring", detail: "renews_on_use" }), "providers.sessDetailRenewsSoon");
  assert.equal(HEALTH_TONE.expired.includes("danger"), false);
  assert.equal(HEALTH_TONE.needs_login.includes("danger"), true);
  assert.equal(detailKey({ health: "needs_login", detail: "invalid_grant" }), "providers.sessDetailRevoked");
  assert.equal(detailKey({ health: "refresh_failed", detail: "network" }), "providers.sessDetailRenewFailed");
  assert.equal(detailKey({ health: "valid", detail: "" }), null);
  for (const h of Object.keys(HEALTH_TONE)) assert.ok(HEALTH_KEY[h as keyof typeof HEALTH_KEY]);
});

test("plan numbers: why they're old and when the server asks again", () => {
  assert.equal(planStale({ plan_stale_reason: null, plan_error: null, plan_retry_at: null, plan_fetched_at: "2026-11-03T02:00:00Z" }), null);
  const n = planStale({
    plan_stale_reason: "rate_limited",
    plan_error: "usage request failed (429)",
    plan_retry_at: "2026-11-03T03:00:00Z",
    plan_fetched_at: "2026-11-03T02:00:00Z",
  })!;
  assert.equal(n.key, "providers.planStaleRateLimited");
  assert.equal(n.retryAt, Date.parse("2026-11-03T03:00:00Z"));
  assert.equal(n.fetchedAt, Date.parse("2026-11-03T02:00:00Z"));
  assert.equal(planStale({ plan_stale_reason: "token_expired", plan_error: "x", plan_retry_at: null, plan_fetched_at: null })!.key, "providers.planStaleTokenExpired");
  assert.equal(planStale({ plan_stale_reason: null, plan_error: "boom", plan_retry_at: null, plan_fetched_at: null })!.key, "providers.planStaleError");
  assert.equal(planStale({ plan_stale_reason: "auth", plan_error: "x", plan_retry_at: null, plan_fetched_at: null })!.key, "providers.planStaleNeedsLogin");
});

test("renewal outcomes", () => {
  assert.equal(renewResultKey(true, "cli", ""), "providers.renewOkCli");
  assert.equal(renewResultKey(true, "direct", ""), "providers.renewOkDirect");
  assert.equal(renewResultKey(true, "already", ""), "providers.renewAlready");
  assert.equal(renewResultKey(true, "cli", "not_needed"), "providers.renewNotNeeded");
  assert.equal(renewResultKey(false, "direct", "invalid_grant"), "providers.renewDead");
  assert.equal(renewResultKey(false, null, "lock_busy"), "providers.renewBusy");
  assert.equal(renewResultKey(false, "direct", "network"), "providers.renewFailed");
});
