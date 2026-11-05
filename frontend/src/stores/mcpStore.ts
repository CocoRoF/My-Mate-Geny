import { create } from "zustand";
import { getMcp, type McpCatalog } from "../api/mcp";

let inflight: Promise<void> | null = null,
  again = false;
export const useMcpStore = create<{
  catalog: McpCatalog | null;
  error: string;
  load: () => Promise<void>;
}>((set) => ({
  catalog: null,
  error: "",
  load: () => {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        do {
          again = false;
          set({ catalog: await getMcp(), error: "" });
        } while (again);
      } catch (e) {
        set({ error: (e as Error).message });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
}));
