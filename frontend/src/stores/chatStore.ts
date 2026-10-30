import { create } from "zustand";
import type { ChatMessage, ProviderEvent } from "../types";

// Rebuild rendered turns from the persisted event stream + messages so a
// reloaded session shows the full process timeline (not just final text).
function reconstruct(messages: ChatMessage[], events: ProviderEvent[]): Turn[] {
  const assistantTurns: Turn[] = [];
  let cur: Turn | null = null;
  for (const ev of events) {
    const data = ev.data as Record<string, any>;
    switch (ev.type) {
      case "session.start":
        cur = { role: "assistant", text: "", flow: [], tools: [], complete: false };
        assistantTurns.push(cur);
        break;
      case "text.delta":
        if (cur) appendText(cur, String(data.text || ""));
        break;
      case "thinking.delta":
        if (cur) cur.thinking = (cur.thinking || "") + String(data.text || "");
        break;
      case "tool.use":
        if (cur) {
          const id = String(data.id || `t${cur.tools.length}`);
          const at = Date.parse(ev.timestamp) || 0;
          cur.tools.push({ id, name: String(data.name || ""), input: data.input, startedAt: at, durationMs: 0 });
          cur.flow.push({ kind: "tool", toolId: id });
        }
        break;
      case "tool.result":
        if (cur) {
          const t = cur.tools.find((x) => x.id === String(data.id || ""));
          if (t) {
            t.output = String(data.output ?? "");
            t.isError = Boolean(data.is_error);
            const at = Date.parse(ev.timestamp) || 0;
            t.durationMs = at && t.startedAt ? Math.max(0, at - t.startedAt) : 0;
          }
        }
        break;
      case "turn.complete":
        if (cur) {
          if (data.text) cur.text = String(data.text);
          cur.complete = true;
          cur.costUsd = Number(data.cost_usd || 0);
          cur.model = String(data.model || "");
        }
        break;
      case "error":
        if (cur) {
          appendText(cur, `\n\n⚠️ ${data.message || ""}`);
          cur.complete = true;
        }
        break;
    }
  }
  assistantTurns.forEach((t) => (t.complete = true));

  // Interleave user messages with reconstructed assistant turns.
  const users = messages.filter((m) => m.role === "user");
  const out: Turn[] = [];
  const n = Math.max(users.length, assistantTurns.length);
  for (let i = 0; i < n; i++) {
    if (users[i])
      out.push({ role: "user", text: users[i].content, flow: [{ kind: "text", text: users[i].content }], tools: [], complete: true });
    if (assistantTurns[i]) out.push(assistantTurns[i]);
  }
  return out;
}

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
  loadHistory: (messages: ChatMessage[], events: ProviderEvent[]) => void;
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
  loadHistory: (messages, events) =>
    set({ turns: reconstruct(messages, events), runningCostUsd: 0 }),
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
