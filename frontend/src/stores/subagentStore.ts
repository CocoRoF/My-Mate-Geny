import { create } from "zustand";

// Which subagent detail views are open (by Agent/Task tool call id). A
// subagent's own subagents open on top; back closes the topmost.
interface SubagentUi {
  stack: string[];
  listOpen: boolean;
  open: (toolId: string) => void;
  back: () => void;
  setList: (open: boolean) => void;
  closeAll: () => void;
}

export const useSubagentUi = create<SubagentUi>((set) => ({
  stack: [],
  listOpen: false,
  open: (id) => set((s) => (s.stack[s.stack.length - 1] === id ? {} : { stack: [...s.stack, id] })),
  back: () => set((s) => ({ stack: s.stack.slice(0, -1) })),
  setList: (open) => set({ listOpen: open }),
  closeAll: () => set({ stack: [], listOpen: false }),
}));
