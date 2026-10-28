import { create } from "zustand";
import type { ProviderStatus } from "../types";
import { connectProvider, disconnectProvider, listProviders } from "../api/providers";

interface ProviderState {
  providers: ProviderStatus[];
  load: () => Promise<void>;
  connect: (provider: string, mode: string, apiKey?: string) => Promise<void>;
  disconnect: (provider: string) => Promise<void>;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providers: [],
  load: async () => set({ providers: await listProviders() }),
  connect: async (provider, mode, apiKey = "") => {
    await connectProvider(provider, mode, apiKey);
    await get().load();
  },
  disconnect: async (provider) => {
    await disconnectProvider(provider);
    await get().load();
  },
}));
