import { create } from "zustand";
import type { ChatMessage, ProviderEvent } from "../types";

export interface ToolActivity {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  startedAt: number;
  durationMs?: number;
}

// Ordered stream of what the assistant did, dex-style: narration text and tool
// calls interleaved in the order they happened.
export type FlowItem = { kind: "text"; text: string } | { kind: "tool"; toolId: string };

export interface Turn {
  role: "user" | "assistant";
  text: string; // full concatenated assistant text (fallback / no-tool render)
  thinking?: string;
  flow: FlowItem[];
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
  const fresh: Turn = { role: "assistant", text: "", flow: [], tools: [], complete: false };
  turns.push(fresh);
  return fresh;
}

function appendText(turn: Turn, text: string) {
  turn.text += text;
  const last = turn.flow[turn.flow.length - 1];
  if (last && last.kind === "text") last.text += text;
  else turn.flow.push({ kind: "text", text });
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
        flow: [{ kind: "text", text: m.content }],
        tools: [],
        complete: true,
      })),
      runningCostUsd: 0,
    }),
  pushUser: (text) =>
    set((s) => ({
      turns: [...s.turns, { role: "user", text, flow: [{ kind: "text", text }], tools: [], complete: true }],
    })),
  setStreaming: (v) => set({ isStreaming: v }),
  applyEvent: (ev) =>
    set((s) => {
      const turns = [...s.turns];
      const data = ev.data as Record<string, any>;
      const now = Date.now();
      switch (ev.type) {
        case "text.delta":
          appendText(lastAssistant(turns), String(data.text || ""));
          break;
        case "thinking.delta": {
          const a = lastAssistant(turns);
          a.thinking = (a.thinking || "") + String(data.text || "");
          break;
        }
        case "tool.use": {
          const a = lastAssistant(turns);
          const id = String(data.id || `t${a.tools.length}`);
          a.tools.push({ id, name: String(data.name || ""), input: data.input, startedAt: now });
          a.flow.push({ kind: "tool", toolId: id });
          break;
        }
        case "tool.result": {
          const a = lastAssistant(turns);
          const tool = a.tools.find((t) => t.id === String(data.id || ""));
          if (tool) {
            tool.output = String(data.output ?? "");
            tool.isError = Boolean(data.is_error);
            tool.durationMs = now - tool.startedAt;
          }
          break;
        }
        case "turn.complete": {
          const a = lastAssistant(turns);
          if (data.text) {
            // Ensure the final answer text is present in the flow.
            if (!a.text) appendText(a, String(data.text));
            else a.text = String(data.text);
          }
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
          appendText(a, `\n\n⚠️ [${data.code}] ${data.message}`);
          a.complete = true;
          return { turns, isStreaming: false };
        }
      }
      return { turns };
    }),
}));
