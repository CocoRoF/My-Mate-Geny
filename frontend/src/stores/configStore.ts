import { create } from "zustand";
import type { ProviderCatalog } from "../types";
import { getConfig } from "../api/config";

interface ConfigState {
  catalog: ProviderCatalog;
  version: string;
  load: () => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set) => ({
  catalog: {},
  version: "",
  load: async () => {
    const c = await getConfig();
    set({ catalog: c.catalog, version: c.version });
  },
}));
