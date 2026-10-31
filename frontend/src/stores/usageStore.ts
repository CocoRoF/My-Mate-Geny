import { create } from "zustand";
import { getPool, type Account, type PoolConfig } from "../api/accounts";
import type { AccountRef, PlanUsage } from "../types";

// Plan usage, per chat: the account each chat's engine runs on and the live
// usage that engine reported (never another chat's), plus each provider's
// account list (5h / 7d windows) for the composer's account popover.

interface AccountList {
  list: Account[];
  pool?: PoolConfig["pool"]; // load balancing on/off + strategy
  at: number; // fetched (epoch ms)
  error?: string;
}

interface UsageState {
  live: Record<string, PlanUsage>; // by session id
  account: Record<string, AccountRef | null>; // by session id
  accounts: Record<string, AccountList>; // by provider
  setLive: (sid: string, u: PlanUsage | null | undefined) => void;
  setAccount: (sid: string, a: AccountRef | null | undefined) => void;
  /** Refresh a provider's accounts unless the copy is younger than `maxAgeMs`
   * (the server caches plan usage ~60s anyway). */
  loadAccounts: (provider: string, maxAgeMs?: number) => Promise<void>;
}

const inflight = new Map<string, Promise<void>>();

export const useUsageStore = create<UsageState>((set, get) => ({
  live: {},
  account: {},
  accounts: {},

  setLive: (sid, u) =>
    set((s) => {
      const live = { ...s.live };
      if (u) live[sid] = u;
      else delete live[sid];
      // A live report names the engine's account: that's the chat's account now.
      const account =
        u?.account ? { ...s.account, [sid]: { account: u.account, account_id: u.account_id ?? null, provider: u.provider, live: true } } : s.account;
      return { live, account };
    }),

  setAccount: (sid, a) =>
    set((s) => {
      const cur = s.account[sid];
      if (!a?.account) return cur === undefined ? { account: { ...s.account, [sid]: null } } : {};
      if (cur && cur.account === a.account && cur.account_id === a.account_id && cur.live === a.live) return {};
      // A different account than the one the live numbers belong to: drop them.
      const live = { ...s.live };
      if (live[sid] && live[sid].account_id !== a.account_id) delete live[sid];
      return { account: { ...s.account, [sid]: a }, live };
    }),

  loadAccounts: (provider, maxAgeMs = 60_000) => {
    const have = get().accounts[provider];
    if (have && Date.now() - have.at < maxAgeMs) return Promise.resolve();
    const running = inflight.get(provider);
    if (running) return running;
    const p = getPool(provider)
      .then((d) =>
        set((s) => ({ accounts: { ...s.accounts, [provider]: { list: d.accounts, pool: d.pool, at: Date.now() } } })),
      )
      .catch((e) =>
        set((s) => ({
          accounts: {
            ...s.accounts,
            [provider]: { ...s.accounts[provider], list: s.accounts[provider]?.list || [], at: Date.now(), error: String(e?.message || e) },
          },
        })),
      )
      .finally(() => inflight.delete(provider));
    inflight.set(provider, p);
    return p;
  },
}));
