import { create } from "zustand";
import type { History } from "../api/sessions";
import type { Attachment, ChatMessage, CliInfo, ProviderEvent } from "../types";

export interface ToolActivity {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  startedAt: number;
  durationMs?: number; // undefined while running
}

// Ordered stream of what the assistant did, in the order it happened: prose,
// reasoning, tool calls and inline notices.
export type FlowItem =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; startedAt: number; endedAt?: number }
  | { kind: "tool"; toolId: string }
  | { kind: "notice"; level: "info" | "warning"; message: string; code?: string }
  // Instructions the user added while the agent was working (pending until
  // the runtime confirms delivery into the running turn).
  | { kind: "steer"; text: string; attachments: Attachment[]; clientMsgId?: string; pending: boolean };

export interface Bounced {
  clientMsgId: string;
  text: string;
  attachments: Attachment[];
  reason: string;
}

export type TurnStatus = "running" | "done" | "error" | "interrupted";

export interface Turn {
  key: string;
  role: "user" | "assistant" | "system";
  text: string; // user text / full assistant prose (copy) / system note
  flow: FlowItem[];
  tools: ToolActivity[];
  complete: boolean;
  status?: TurnStatus;
  error?: { code: string; message: string };
  costUsd?: number;
  model?: string;
  usage?: Record<string, any>;
  startedAt?: number;
  endedAt?: number;
  attachments?: Attachment[];
  level?: "info" | "warning"; // system turns
}

interface ChatState {
  turns: Turn[];
  isStreaming: boolean; // a turn is running server-side (any tab)
  runningCostUsd: number;
  lastEid: number;
  info: CliInfo | null;
  connection: "connecting" | "open" | "reconnecting";
  bounced: Bounced[]; // steers the turn could no longer take -> composer queues them
  reset: () => void;
  loadHistory: (h: History) => void;
  pushUser: (text: string, attachments: Attachment[], clientMsgId: string) => void;
  pushSteer: (text: string, attachments: Attachment[], clientMsgId: string) => void;
  takeBounced: () => Bounced[];
  setStreaming: (v: boolean) => void;
  setConnection: (c: ChatState["connection"]) => void;
  applyEvent: (ev: ProviderEvent) => void;
}

// ---- reducer (shared by history replay and live events) ---------------------

let keySeq = 0;
const newKey = (p: string) => `${p}${++keySeq}`;

// client_msg_ids of messages this tab sent — their echo (user.message) is skipped.
const ownMessages = new Set<string>();

const ts = (ev: ProviderEvent) => Date.parse(ev.timestamp) || Date.now();

/** Copy-on-write access to the in-progress assistant turn (creating one if
 * needed). Components memoize on flow/tools identity, so never mutate in place. */
function liveTurn(turns: Turn[], at: number): Turn {
  const i = turns.length - 1;
  const last = turns[i];
  if (last && last.role === "assistant" && !last.complete) {
    const copy: Turn = {
      ...last,
      flow: last.flow.map((f) => ({ ...f })),
      tools: last.tools.map((t) => ({ ...t })),
    };
    turns[i] = copy;
    return copy;
  }
  const fresh: Turn = {
    key: newKey("a"),
    role: "assistant",
    text: "",
    flow: [],
    tools: [],
    complete: false,
    status: "running",
    startedAt: at,
  };
  turns.push(fresh);
  return fresh;
}

const hasLiveTurn = (turns: Turn[]) => {
  const last = turns[turns.length - 1];
  return !!last && last.role === "assistant" && !last.complete;
};

function closeThinking(turn: Turn, at: number) {
  const last = turn.flow[turn.flow.length - 1];
  if (last && last.kind === "thinking" && !last.endedAt) last.endedAt = at;
}

function appendText(turn: Turn, text: string, at: number) {
  closeThinking(turn, at);
  turn.text += text;
  const last = turn.flow[turn.flow.length - 1];
  if (last && last.kind === "text") last.text += text;
  else turn.flow.push({ kind: "text", text });
}

function systemTurn(turns: Turn[], message: string, level: "info" | "warning") {
  turns.push({ key: newKey("s"), role: "system", text: message, flow: [], tools: [], complete: true, level });
}

function finish(turn: Turn, at: number) {
  closeThinking(turn, at);
  turn.complete = true;
  turn.endedAt = at;
  for (const t of turn.tools) if (t.durationMs === undefined) t.durationMs = Math.max(0, at - t.startedAt);
}

/** Apply one event to `turns` (a fresh array the caller owns). Returns extra
 * state changes for the store. */
function reduce(turns: Turn[], ev: ProviderEvent): Partial<ChatState> {
  const data = ev.data as Record<string, any>;
  const at = ts(ev);
  switch (ev.type) {
    case "session.start": {
      const last = turns[turns.length - 1];
      if (last && last.role === "assistant" && !last.complete && !last.flow.length) {
        turns[turns.length - 1] = { ...last, startedAt: at };
      } else {
        if (hasLiveTurn(turns)) finish(liveTurn(turns, at), at);
        liveTurn(turns, at); // opens a fresh running turn
      }
      break;
    }
    case "text.delta":
      appendText(liveTurn(turns, at), String(data.text || ""), at);
      break;
    case "thinking.delta": {
      const t = liveTurn(turns, at);
      const last = t.flow[t.flow.length - 1];
      if (last && last.kind === "thinking" && !last.endedAt) last.text += String(data.text || "");
      else t.flow.push({ kind: "thinking", text: String(data.text || ""), startedAt: at });
      break;
    }
    case "tool.use": {
      const t = liveTurn(turns, at);
      closeThinking(t, at);
      const id = String(data.id || `t${t.tools.length}`);
      t.tools.push({ id, name: String(data.name || ""), input: data.input, startedAt: at });
      t.flow.push({ kind: "tool", toolId: id });
      break;
    }
    case "tool.result": {
      if (!hasLiveTurn(turns)) break;
      const t = liveTurn(turns, at);
      const tool = t.tools.find((x) => x.id === String(data.id || ""));
      if (tool) {
        tool.output = String(data.output ?? "");
        tool.isError = Boolean(data.is_error);
        tool.durationMs = Math.max(0, at - tool.startedAt);
      }
      break;
    }
    case "notice": {
      const level = data.level === "warning" ? "warning" : "info";
      const message = String(data.message || "");
      if (data.code === "context.reset" || !hasLiveTurn(turns)) systemTurn(turns, message, level);
      else liveTurn(turns, at).flow.push({ kind: "notice", level, message, code: data.code });
      break;
    }
    case "turn.complete": {
      const t = liveTurn(turns, at);
      if (data.text && !t.text.trim()) appendText(t, String(data.text), at);
      finish(t, at);
      t.status = "done";
      t.costUsd = Number(data.cost_usd || 0);
      t.model = String(data.model || "");
      t.usage = data.usage || undefined;
      return { isStreaming: false };
    }
    case "error": {
      const code = String(data.code || "error");
      const message = String(data.message || "");
      if (code === "turn.busy") break; // the composer queues instead
      if (code === "attachment.invalid" || code === "session.not_found") {
        systemTurn(turns, message, "warning");
        break;
      }
      const t = liveTurn(turns, at);
      finish(t, at);
      t.status = code === "turn.interrupted" ? "interrupted" : "error";
      t.error = { code, message };
      break;
    }
    case "session.info":
      return { info: data as CliInfo };
    case "run.state": {
      const running = Boolean(data.running);
      if (!running && hasLiveTurn(turns)) {
        // Run ended without a terminal event (runtime restarted mid-turn).
        const t = liveTurn(turns, Date.now());
        finish(t, t.endedAt || Date.now());
        t.status = "interrupted";
        t.error = t.error || { code: "turn.lost", message: "The run ended unexpectedly" };
      }
      return { isStreaming: running };
    }
    case "user.steer": {
      const cid = data.client_msg_id ? String(data.client_msg_id) : "";
      const item = {
        kind: "steer" as const,
        text: String(data.text || ""),
        attachments: (data.attachments as Attachment[]) || [],
        clientMsgId: cid || undefined,
        pending: false,
      };
      if (!hasLiveTurn(turns)) {
        // Nothing running here (e.g. delivered just as the turn closed): plain user bubble.
        turns.push({ key: newKey("u"), role: "user", text: item.text, flow: [], tools: [], complete: true, attachments: item.attachments });
        break;
      }
      const t = liveTurn(turns, at);
      const mine = cid ? t.flow.find((f) => f.kind === "steer" && f.clientMsgId === cid) : undefined;
      if (mine && mine.kind === "steer") mine.pending = false;
      else {
        closeThinking(t, at);
        t.flow.push(item);
      }
      break;
    }
    case "steer.rejected": {
      const cid = String(data.client_msg_id || "");
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        const idx = t.flow.findIndex((f) => f.kind === "steer" && f.clientMsgId === cid && f.pending);
        if (idx >= 0) {
          const item = t.flow[idx] as Extract<FlowItem, { kind: "steer" }>;
          turns[i] = { ...t, flow: t.flow.filter((_, k) => k !== idx) };
          return {
            bounced: [{ clientMsgId: cid, text: item.text, attachments: item.attachments, reason: String(data.reason || "") }],
          };
        }
      }
      break;
    }
    case "user.message": {
      const cid = data.client_msg_id ? String(data.client_msg_id) : "";
      if (cid && ownMessages.has(cid)) {
        ownMessages.delete(cid);
        break;
      }
      if (hasLiveTurn(turns)) finish(liveTurn(turns, at), at);
      turns.push({
        key: newKey("u"),
        role: "user",
        text: String(data.text || ""),
        flow: [],
        tools: [],
        complete: true,
        attachments: (data.attachments as Attachment[]) || [],
      });
      break;
    }
  }
  return {};
}

/** Rebuild turns from persisted history: user messages and events merged on
 * one timeline (not paired by index, which drifts on errors/notices). */
function reconstruct(messages: ChatMessage[], events: ProviderEvent[]): Turn[] {
  type Item = { at: string; order: number; eid: number; user?: ChatMessage; ev?: ProviderEvent };
  const items: Item[] = [
    ...messages
      .filter((m) => m.role === "user")
      .map((m) => ({ at: m.created_at || "", order: 0, eid: 0, user: m })),
    ...events.map((e) => ({ at: e.timestamp, order: 1, eid: e.eid || 0, ev: e })),
  ];
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.eid - b.eid));
  const turns: Turn[] = [];
  for (const it of items) {
    if (it.user) {
      if (hasLiveTurn(turns)) {
        const t = liveTurn(turns, Date.parse(it.at));
        finish(t, t.startedAt || Date.parse(it.at));
        t.status = t.status === "running" ? "done" : t.status;
      }
      turns.push({
        key: newKey("u"),
        role: "user",
        text: it.user.content,
        flow: [],
        tools: [],
        complete: true,
        attachments: it.user.attachments || [],
      });
    } else if (it.ev) {
      reduce(turns, it.ev);
    }
  }
  return turns;
}

const totalCost = (turns: Turn[]) => turns.reduce((n, t) => n + (t.costUsd || 0), 0);

export const useChatStore = create<ChatState>((set, get) => ({
  turns: [],
  isStreaming: false,
  runningCostUsd: 0,
  lastEid: 0,
  info: null,
  connection: "connecting",
  bounced: [],

  reset: () => set({ turns: [], isStreaming: false, runningCostUsd: 0, lastEid: 0, info: null, bounced: [] }),

  loadHistory: (h) => {
    const turns = reconstruct(h.messages, h.events);
    if (!h.running && hasLiveTurn(turns)) {
      const t = liveTurn(turns, Date.now());
      finish(t, t.endedAt || t.startedAt || Date.now());
      t.status = "interrupted";
      t.error = { code: "turn.lost", message: "The run ended unexpectedly" };
    }
    const lastEid = h.events.reduce((m, e) => Math.max(m, e.eid || 0), 0);
    set({
      turns,
      lastEid,
      isStreaming: h.running,
      runningCostUsd: totalCost(turns),
      info: (h.session?.cli_info as CliInfo) || null,
    });
  },

  pushUser: (text, attachments, clientMsgId) => {
    ownMessages.add(clientMsgId);
    set((s) => ({
      turns: [
        ...s.turns,
        { key: newKey("u"), role: "user", text, flow: [], tools: [], complete: true, attachments },
      ],
    }));
  },

  pushSteer: (text, attachments, clientMsgId) =>
    set((s) => {
      const turns = [...s.turns];
      if (!hasLiveTurn(turns)) return {};
      const t = liveTurn(turns, Date.now());
      closeThinking(t, Date.now());
      t.flow.push({ kind: "steer", text, attachments, clientMsgId, pending: true });
      return { turns };
    }),

  takeBounced: () => {
    const b = get().bounced;
    if (b.length) set({ bounced: [] });
    return b;
  },

  setStreaming: (v) => set({ isStreaming: v }),
  setConnection: (c) => set({ connection: c }),

  applyEvent: (ev) =>
    set((s) => {
      if (ev.eid && ev.eid <= s.lastEid) return {}; // already applied (replay overlap)
      const turns = [...s.turns];
      const extra = reduce(turns, ev);
      if (extra.bounced) extra.bounced = [...s.bounced, ...extra.bounced];
      if (hasLiveTurn(turns) && ev.type !== "run.state") extra.isStreaming = true;
      return {
        turns,
        ...extra,
        lastEid: ev.eid ? Math.max(s.lastEid, ev.eid) : s.lastEid,
        runningCostUsd: ev.type === "turn.complete" ? totalCost(turns) : s.runningCostUsd,
      };
    }),
}));
