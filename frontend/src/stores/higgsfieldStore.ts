// Higgsfield's state as the console shows it (Settings → Providers → Higgsfield, the chat's session panel, Usage).
import { create } from "zustand";
import { getHiggsfield, type HiggsfieldAccount, type HiggsfieldStatus } from "../api/higgsfield";

interface HiggsfieldState {
  status: HiggsfieldStatus | null;
  loading: boolean;
  error: string | null;
  load: (recheck?: boolean) => Promise<void>;
  /** the account the chats use (null: none connected) */
  account: () => HiggsfieldAccount | null;
  /** an account changed (refresh, sign-in, workspace): put it in place without a refetch */
  put: (acc: HiggsfieldAccount) => void;
}

export const useHiggsfieldStore = create<HiggsfieldState>((set, get) => ({
  status: null,
  loading: false,
  error: null,
  load: async (recheck = false) => {
    set({ loading: true });
    try {
      set({ status: await getHiggsfield(recheck), error: null });
    } catch (e) {
      set({ error: String((e as Error)?.message || e) });
    } finally {
      set({ loading: false });
    }
  },
  account: () => {
    const s = get().status;
    return s?.accounts.find((a) => a.id === s.default_id) ?? s?.accounts[0] ?? null;
  },
  put: (acc) => {
    const s = get().status;
    if (!s) return;
    const known = s.accounts.some((a) => a.id === acc.id);
    set({ status: { ...s, accounts: known ? s.accounts.map((a) => (a.id === acc.id ? acc : a)) : [...s.accounts, acc] } });
  },
}));
