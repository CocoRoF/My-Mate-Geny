import { create } from "zustand";
import type { Connection } from "../types";
import {
  createConnection,
  deleteConnection,
  listConnections,
  type ConnectionInput,
} from "../api/connections";

interface ConnectionState {
  connections: Connection[];
  load: () => Promise<void>;
  create: (body: ConnectionInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  load: async () => set({ connections: await listConnections() }),
  create: async (body) => {
    await createConnection(body);
    await get().load();
  },
  remove: async (id) => {
    await deleteConnection(id);
    await get().load();
  },
}));
