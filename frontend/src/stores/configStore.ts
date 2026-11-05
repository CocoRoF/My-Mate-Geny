import { create } from "zustand";
import type { ProviderCatalog } from "../types";
import { getConfig } from "../api/config";

interface ConfigState {
  catalog: ProviderCatalog;
  version: string;
  executionMode: "server"|"local";
  load: () => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set) => ({
  catalog: {},
  version: "",
  executionMode: typeof window!=="undefined"&&window.hrhNative?.executionMode==="local"?"local":"server",
  load: async () => {
    const c = await getConfig();
    set({ catalog: c.catalog, version: c.version, executionMode:c.execution_mode||"server" });
  },
}));
