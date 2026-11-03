import type { ProviderStatus } from "../types";

/**
 * What the Settings badge points at: only things the user has to act on — never plain information (how many
 * providers are connected is not news; a badge for it reads as "something to check" and confuses).
 * Today: no provider connected at all (no chat can run). Loaded-but-empty lists don't count (still loading).
 */
export function providersNeedAttention(providers: ProviderStatus[]): boolean {
  return providers.length > 0 && !providers.some((p) => p.connected);
}

/**
 * Settings → Providers → an account's login session can't work without the user: it needs a sign-in (no / expired /
 * revoked refresh token, refused) or its renewal failed with the access token gone. Never for plain information —
 * an access token that ran out but renews on the next use, one expiring soon, a valid one.
 */
export function sessionsNeedAttention(providers: ProviderStatus[]): boolean {
  return providers.some((p) => (p.session_attention || []).some((i) => i.health === "needs_login" || i.health === "refresh_failed"));
}

/** the part of a CLI's status (api/cliTools.ts) the badge looks at */
export interface CliToolAttention {
  update_available: boolean;
  upgrade: { possible: boolean };
  auto_upgrade: boolean;
  job: { active: boolean } | null;
}

/**
 * Settings → Providers → CLI versions: a CLI has a really newer version (the server compares versions — never "a
 * check ran", "latest unknown" or a channel behind the installed copy) that the user can install here, and nothing
 * is taking care of it already (an upgrade in progress / waiting, or automatic upgrades on).
 */
export function cliUpdatesNeedAttention(tools: CliToolAttention[] | null | undefined): boolean {
  return !!tools?.some((t) => t.update_available && t.upgrade.possible && !t.auto_upgrade && !t.job?.active);
}
