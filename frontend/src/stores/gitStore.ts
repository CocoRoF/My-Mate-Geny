import { create } from "zustand";
import { connectGit, deleteGit, listGitAccounts, type GitAccount } from "../api/git";

interface GitState {
  accounts: GitAccount[];
  load: () => Promise<void>;
  connect: (body: { provider: string; token: string; host?: string; label?: string }) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useGitStore = create<GitState>((set, get) => ({
  accounts: [],
  load: async () => set({ accounts: await listGitAccounts() }),
  connect: async (body) => {
    await connectGit(body);
    await get().load();
  },
  remove: async (id) => {
    await deleteGit(id);
    await get().load();
  },
}));
