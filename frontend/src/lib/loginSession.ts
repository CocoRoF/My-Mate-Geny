// An account's login session and its plan numbers' freshness, as the Providers cards show them: which words, which
// tone, which buttons. Pure (no React, no catalog) — the component turns the keys into text (docs/providers.md).

import type { Account, LoginSession, SessionHealth } from "../api/accounts";
import type { MsgKey } from "../i18n";

const toMs = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
};

export const HEALTH_KEY: Record<SessionHealth, MsgKey> = {
  valid: "providers.sessValid",
  expiring: "providers.sessExpiring",
  expired: "providers.sessExpired",
  refresh_failed: "providers.sessRefreshFailed",
  needs_login: "providers.sessNeedsLogin",
  no_credentials: "providers.sessNoCredentials",
};

export const HEALTH_TONE: Record<SessionHealth, string> = {
  valid: "bg-success/15 text-success",
  expiring: "bg-warning/15 text-warning",
  // the access token ran out but the CLI renews it on the next use: information, not a problem
  expired: "bg-surface-3 text-content-dim",
  refresh_failed: "bg-danger/15 text-danger",
  needs_login: "bg-danger/15 text-danger",
  no_credentials: "bg-surface-3 text-content-faint",
};

export const METHOD_KEY: Record<LoginSession["method"], MsgKey> = {
  oauth: "providers.methodOauth",
  setup_token: "providers.methodSetupToken",
  api_key: "providers.methodApiKey",
  chatgpt: "providers.methodChatgpt",
  none: "providers.methodNone",
};

/** what the health means, one line (the detail code from the backend) */
export function detailKey(s: Pick<LoginSession, "health" | "detail">): MsgKey | null {
  switch (s.detail) {
    case "renews_on_use":
      return s.health === "expired" ? "providers.sessDetailRenewsOnUse" : "providers.sessDetailRenewsSoon";
    case "no_refresh_token":
      return "providers.sessDetailNoRefresh";
    case "refresh_token_expired":
      return "providers.sessDetailRefreshExpired";
    case "refresh_token_expiring":
      return "providers.sessDetailRefreshExpiring";
    case "invalid_grant":
    case "revoked":
      return "providers.sessDetailRevoked";
    case "rejected":
      return "providers.sessDetailRejected";
    case "not_signed_in":
      return "providers.sessDetailNotSignedIn";
    case "":
    case "api_key":
    case "setup_token":
      return null;
    default:
      return s.health === "refresh_failed" ? "providers.sessDetailRenewFailed" : null;
  }
}

/** which buttons the session row offers */
export function sessionActions(s: LoginSession | null | undefined): { renew: boolean; relogin: boolean; reloginFirst: boolean } {
  if (!s) return { renew: false, relogin: false, reloginFirst: false };
  const subscription = s.method === "oauth" || s.method === "chatgpt" || s.method === "none";
  const stuck = s.health === "needs_login" || s.health === "refresh_failed";
  return {
    renew: s.renewable && s.health !== "needs_login",
    // a subscription login can always be signed in again (the details expander); first when it's the way out
    relogin: subscription,
    reloginFirst: stuck,
  };
}

export type StaleNote = { key: MsgKey; retryAt: number | null; fetchedAt: number | null; error: string };

/** Why an account's plan numbers aren't fresh, or null when they are (or there are none to have). */
export function planStale(a: Pick<Account, "plan_stale_reason" | "plan_retry_at" | "plan_fetched_at" | "plan_error">): StaleNote | null {
  const reason = a.plan_stale_reason || (a.plan_error ? "error" : null);
  if (!reason) return null;
  const key: MsgKey =
    reason === "rate_limited"
      ? "providers.planStaleRateLimited"
      : reason === "token_expired"
        ? "providers.planStaleTokenExpired"
        : reason === "needs_login" || reason === "auth"
          ? "providers.planStaleNeedsLogin"
          : reason === "no_credentials"
            ? "providers.planStaleNoCredentials"
            : "providers.planStaleError";
  return { key, retryAt: toMs(a.plan_retry_at), fetchedAt: toMs(a.plan_fetched_at), error: a.plan_error || reason };
}

/** a renewal's outcome as one line */
export function renewResultKey(ok: boolean, method: string | null | undefined, code: string): MsgKey {
  if (ok) {
    if (code === "not_needed") return "providers.renewNotNeeded";
    if (method === "already") return "providers.renewAlready";
    if (method === "cli") return "providers.renewOkCli";
    return "providers.renewOkDirect";
  }
  if (code === "invalid_grant" || code === "no_refresh_token" || code === "no_credentials") return "providers.renewDead";
  if (code === "lock_busy" || code === "busy") return "providers.renewBusy";
  if (code === "rate_limited") return "providers.renewRateLimited";
  return "providers.renewFailed";
}
