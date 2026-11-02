import type { ProviderStatus } from "../types";

/**
 * What the Settings badge points at: only things the user has to act on — never plain information (how many
 * providers are connected is not news; a badge for it reads as "something to check" and confuses).
 * Today: no provider connected at all (no chat can run). Loaded-but-empty lists don't count (still loading).
 */
export function providersNeedAttention(providers: ProviderStatus[]): boolean {
  return providers.length > 0 && !providers.some((p) => p.connected);
}
