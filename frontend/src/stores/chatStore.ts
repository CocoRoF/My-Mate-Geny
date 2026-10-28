import { create } from "zustand";
import type { ChatMessage, ProviderEvent } from "../types";

// A rendered conversation turn: user message, or an assistant turn that
// accumulates streaming text plus the tool activity that happened within it.
export interface ToolActivity {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  tools: ToolActivity[];
  complete: boolean;
  costUsd?: number;
  model?: string;
}

interface ChatState {
  turns: Turn[];
  isStreaming: boolean;
  runningCostUsd: number;
  reset: () => void;
  loadHistory: (messages: ChatMessage[]) => void;
  pushUser: (text: string) => void;
  setStreaming: (v: boolean) => void;
  applyEvent: (ev: ProviderEvent) => void;
}

function lastAssistant(turns: Turn[]): Turn {
  const last = turns[turns.length - 1];
  if (last && last.role === "assistant" && !last.complete) return last;
  const fresh: Turn = { role: "assistant", text: "", tools: [], complete: false };
  turns.push(fresh);
  return fresh;
}

export const useChatStore = create<ChatState>((set) => ({
  turns: [],
  isStreaming: false,
  runningCostUsd: 0,
  reset: () => set({ turns: [], isStreaming: false, runningCostUsd: 0 }),
  loadHistory: (messages) =>
    set({
      turns: messages.map((m) => ({
        role: m.role,
        text: m.content,
        tools: [],
        complete: true,
      })),
      runningCostUsd: 0,
    }),
  pushUser: (text) =>
    set((s) => ({ turns: [...s.turns, { role: "user", text, tools: [], complete: true }] })),
  setStreaming: (v) => set({ isStreaming: v }),
  applyEvent: (ev) =>
    set((s) => {
      const turns = [...s.turns];
      const data = ev.data as Record<string, any>;
      switch (ev.type) {
        case "text.delta": {
          lastAssistant(turns).text += String(data.text || "");
          break;
        }
        case "thinking.delta": {
          const a = lastAssistant(turns);
          a.thinking = (a.thinking || "") + String(data.text || "");
          break;
        }
        case "tool.use": {
          lastAssistant(turns).tools.push({
            id: String(data.id || ""),
            name: String(data.name || ""),
            input: data.input,
          });
          break;
        }
        case "tool.result": {
          const a = lastAssistant(turns);
          const tool = a.tools.find((t) => t.id === String(data.id || ""));
          if (tool) {
            tool.output = String(data.output || "");
            tool.isError = Boolean(data.is_error);
          }
          break;
        }
        case "turn.complete": {
          const a = lastAssistant(turns);
          if (data.text) a.text = String(data.text);
          a.complete = true;
          a.costUsd = Number(data.cost_usd || 0);
          a.model = String(data.model || "");
          return {
            turns,
            isStreaming: false,
            runningCostUsd: s.runningCostUsd + Number(data.cost_usd || 0),
          };
        }
        case "error": {
          const a = lastAssistant(turns);
          a.text += `\n\n⚠️ [${data.code}] ${data.message}`;
          a.complete = true;
          return { turns, isStreaming: false };
        }
      }
      return { turns };
    }),
}));
