import { create } from "zustand";
import { getOlderPage, type History, type HistoryBefore, type HistoryPage, type OlderPage } from "../api/sessions";
import type { Attachment, ChatMessage, CliInfo, Compaction, ContextInfo, ProviderEvent, TaskInfo, TurnChanges } from "../types";

export interface ToolActivity {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  startedAt: number;
  durationMs?: number; // undefined while running
  parent?: string; // a subagent's call: nested under that Task/Agent row
  images?: Attachment[]; // images the tool returned (e.g. a screenshot it read)
  task?: TaskInfo; // when the CLI ran it as a (background) task
  // Agent/Task calls: what the subagent did, in order, and its report.
  sub?: SubItem[];
  lastAt?: number; // the subagent's latest step
  agent?: AgentReport;
}

/** One step of a subagent's work (its tool calls live in `Turn.tools`). */
export type SubItem =
  | { kind: "text"; text: string; at: number }
  | { kind: "thinking"; text: string; at: number }
  | { kind: "tool"; toolId: string };

/** The CLI's summary of a finished (or launched, for background) subagent. */
export interface AgentReport {
  agent_id?: string;
  status?: string; // completed | async_launched | …
  agent_type?: string;
  model?: string;
  duration_ms?: number;
  total_tokens?: number;
  tool_uses?: number;
  is_async?: boolean;
  result?: string; // its final report, without the hand-back framing
}

// Ordered stream of what the assistant did, in the order it happened: prose,
// reasoning, tool calls and inline notices.
export type FlowItem =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; startedAt: number; endedAt?: number }
  | { kind: "tool"; toolId: string }
  | { kind: "notice"; level: "info" | "warning"; message: string; code?: string; data?: Record<string, any> }
  // Instructions the user added while the agent was working (pending until
  // the runtime confirms delivery into the running turn).
  | { kind: "steer"; text: string; attachments: Attachment[]; clientMsgId?: string; pending: boolean; meta?: MessageMeta };

/** What the backend says about a message beyond its text (docs/mate.md §3):
 * who sent it (`via` a mate) and internal messages (a mate's greeting,
 * delegation results). */
export interface MessageMeta {
  via?: { kind: string; mate_id?: string; name?: string };
  internal?: boolean;
  kind?: string; // greeting | delegation_result
  delegations?: { session_id: string; title: string; status: string }[];
  [k: string]: unknown;
}

const META_KEYS = ["via", "internal", "kind", "delegations"] as const;

/** The meta keys a live user.message / user.steer event carries in `data`. */
function metaOf(data: Record<string, any>): MessageMeta | undefined {
  let out: MessageMeta | undefined;
  for (const k of META_KEYS) if (data[k] !== undefined && data[k] !== null) (out ??= {})[k] = data[k];
  return out;
}

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
  code?: string; // system turns: the notice code (e.g. context.compacted)
  data?: Record<string, any>; // system turns: the notice's data
  trigger?: string; // "background": Claude started this turn itself
  changes?: TurnChanges; // files the turn changed (git snapshots)
  meta?: MessageMeta; // user turns: via a mate, internal messages
}

/** Paged history (backend services/history_page.py): the newest turns are
 * loaded first, older ones as the reader scrolls up. */
export interface Paging {
  paged: boolean; // false: the whole chat came at once (nothing older to load)
  cursor: string | null; // start of the loaded range (null = the beginning)
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  baseEid: number; // highest eid the last (re)load covered; newer ones came live
}

/** Turns of the first page; each older page. */
export const FIRST_TURNS = 5;
export const OLDER_TURNS = 10;

interface ChatState {
  sid: string | null; // the session this store shows
  turns: Turn[];
  isStreaming: boolean; // a turn is running server-side (any tab)
  runningCostUsd: number;
  lastEid: number;
  info: CliInfo | null;
  context: ContextInfo | null; // main-conversation context size (Claude)
  lastCompaction: Compaction | null;
  connection: "connecting" | "open" | "reconnecting";
  bounced: Bounced[]; // steers the turn could no longer take -> composer queues them
  paging: Paging;
  older: HistoryBefore | null; // the not-yet-loaded part of the chat: cost, files, todos
  // Events that belong to a turn not loaded yet (a background subagent of an
  // old turn reporting): kept until that turn is loaded. `detached` shows
  // them meanwhile, under the launching calls of still-running background
  // work (`pinnedTools`, sent with the first page).
  orphans: ProviderEvent[];
  detached: Turn | null;
  pinnedTools: ReadonlySet<string>;
  openSeq: number; // bumps when a chat is opened (lists jump to its end)
  opened: boolean;
  gen: number; // bumps on every (re)load: stale older pages are dropped
  reset: (sid?: string | null) => void;
  loadHistory: (h: History | HistoryPage) => void;
  /** Prepend the previous page. `beforeApply` runs right before the turns
   * change (lists measure their scroll height there). */
  loadOlder: (beforeApply?: () => void) => Promise<void>;
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

function systemTurn(turns: Turn[], message: string, level: "info" | "warning", code?: string, data?: Record<string, any>) {
  turns.push({ key: newKey("s"), role: "system", text: message, flow: [], tools: [], complete: true, level, code, data });
}

/** A context report on top of the previous one: per-call reports may lack
 * the window/threshold the engine reported earlier. */
function mergeContext(prev: ContextInfo | null, next: ContextInfo): ContextInfo {
  if (!prev) return next;
  const out: ContextInfo = { ...next };
  for (const k of ["window", "model_window", "threshold", "window_source"] as const) {
    if (out[k] === undefined || out[k] === null) (out as any)[k] = prev[k];
  }
  if (out.auto_compact === undefined) out.auto_compact = prev.auto_compact;
  return out;
}

const compactionOf = (d: Record<string, any>, at: string): Compaction => ({
  trigger: d.trigger,
  pre_tokens: d.pre_tokens,
  post_tokens: d.post_tokens,
  at,
});

/** Context state after a list of (history) events. */
function contextOf(events: ProviderEvent[]): { context: ContextInfo | null; lastCompaction: Compaction | null } {
  let context: ContextInfo | null = null;
  let lastCompaction: Compaction | null = null;
  for (const e of events) {
    const d = e.data as Record<string, any>;
    if (e.type === "context.update") context = mergeContext(context, d as unknown as ContextInfo);
    else if (e.type === "notice" && d.code === "context.reset") {
      context = null;
      lastCompaction = null;
    } else if (e.type === "notice" && d.code === "context.compacted") lastCompaction = compactionOf(d, e.timestamp);
  }
  return { context, lastCompaction };
}

const isBackgroundAgent = (t: ToolActivity) =>
  !!((t.input as any)?.run_in_background || t.task?.is_backgrounded || t.agent?.is_async);

/** A call made inside a background subagent (at any depth): it outlives the turn. */
function underBackground(turn: Turn, tool: ToolActivity): boolean {
  let p = tool.parent;
  for (let hops = 0; p && hops < 20; hops++) {
    const a = turn.tools.find((x) => x.id === p);
    if (!a) return false;
    if (isBackgroundAgent(a)) return true;
    p = a.parent;
  }
  return false;
}

function finish(turn: Turn, at: number) {
  closeThinking(turn, at);
  turn.complete = true;
  turn.endedAt = at;
  for (const t of turn.tools) {
    if (t.durationMs === undefined && !underBackground(turn, t)) t.durationMs = Math.max(0, at - t.startedAt);
  }
}

/** Index of the (latest) turn holding tool `id`, or -1. */
function turnOf(turns: Turn[], id: string): number {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].tools.some((t) => t.id === id)) return i;
  return -1;
}

/** Copy-on-write access to the turn holding tool `id` — the running turn or
 * an earlier one (a background subagent keeps reporting after its turn). */
function turnWith(turns: Turn[], id: string, at: number): Turn | null {
  const i = turnOf(turns, id);
  if (i < 0) return null;
  if (i === turns.length - 1 && !turns[i].complete) return liveTurn(turns, at);
  const copy: Turn = { ...turns[i], tools: turns[i].tools.map((t) => ({ ...t })) };
  turns[i] = copy;
  return copy;
}

/** Record a subagent step under its Agent/Task call. */
function pushSub(turn: Turn, parent: string, item: SubItem, at: number) {
  const p = turn.tools.find((t) => t.id === parent);
  if (!p) return;
  p.sub = [...(p.sub || []), item];
  p.lastAt = at;
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
        turns[turns.length - 1] = { ...last, startedAt: at, trigger: data.trigger || last.trigger };
      } else {
        if (hasLiveTurn(turns)) finish(liveTurn(turns, at), at);
        const t = liveTurn(turns, at); // opens a fresh running turn
        if (data.trigger) t.trigger = String(data.trigger);
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
      const parent = data.parent ? String(data.parent) : undefined;
      if (parent) {
        // A subagent's call: nests under its Agent/Task call, wherever that is.
        const t = turnWith(turns, parent, at) || (hasLiveTurn(turns) ? liveTurn(turns, at) : null);
        if (!t) break;
        const id = String(data.id || `t${t.tools.length}`);
        t.tools.push({ id, name: String(data.name || ""), input: data.input, startedAt: at, parent });
        pushSub(t, parent, { kind: "tool", toolId: id }, at);
        break;
      }
      const t = liveTurn(turns, at);
      closeThinking(t, at);
      const id = String(data.id || `t${t.tools.length}`);
      t.tools.push({ id, name: String(data.name || ""), input: data.input, startedAt: at });
      t.flow.push({ kind: "tool", toolId: id });
      break;
    }
    case "tool.result": {
      const id = String(data.id || "");
      const t = id ? turnWith(turns, id, at) : null;
      const tool = t?.tools.find((x) => x.id === id);
      if (t && tool) {
        tool.output = String(data.output ?? "");
        tool.isError = Boolean(data.is_error);
        tool.durationMs = Math.max(0, at - tool.startedAt);
        if (Array.isArray(data.images) && data.images.length) tool.images = data.images as Attachment[];
        if (data.agent && typeof data.agent === "object") tool.agent = data.agent as AgentReport;
        if (tool.parent) {
          const p = t.tools.find((x) => x.id === tool.parent);
          if (p) p.lastAt = at;
        }
      }
      break;
    }
    case "subagent.text":
    case "subagent.thinking": {
      // A subagent's prose / reasoning: shown in its card, never in the answer.
      const parent = String(data.parent || "");
      const t = parent ? turnWith(turns, parent, at) : null;
      if (t) pushSub(t, parent, { kind: ev.type === "subagent.text" ? "text" : "thinking", text: String(data.text || ""), at }, at);
      break;
    }
    case "task.update": {
      // Live state of a tool call the CLI runs as a task (background or long).
      const tid = String(data.tool_use_id || "");
      for (let i = turns.length - 1; i >= 0 && tid; i--) {
        const idx = turns[i].tools.findIndex((x) => x.id === tid);
        if (idx >= 0) {
          const t = { ...turns[i], tools: turns[i].tools.map((x) => ({ ...x })) };
          t.tools[idx].task = { ...(t.tools[idx].task || {}), ...(data as unknown as TaskInfo) };
          turns[i] = t;
          break;
        }
      }
      break;
    }
    case "turn.changes": {
      const t = liveTurn(turns, at);
      t.changes = { ...(data as unknown as TurnChanges), eid: ev.eid };
      break;
    }
    case "notice": {
      const level = data.level === "warning" ? "warning" : "info";
      const message = String(data.message || "");
      if (data.code === "context.reset" || !hasLiveTurn(turns)) systemTurn(turns, message, level, data.code, data);
      else liveTurn(turns, at).flow.push({ kind: "notice", level, message, code: data.code, data });
      if (data.code === "context.reset") return { context: null, lastCompaction: null };
      if (data.code === "context.compacted") return { lastCompaction: compactionOf(data, ev.timestamp) };
      break;
    }
    case "context.update":
      return { context: data as unknown as ContextInfo };
    case "turn.complete": {
      const t = liveTurn(turns, at);
      if (data.text && !t.text.trim()) appendText(t, String(data.text), at);
      finish(t, at);
      t.status = "done";
      t.costUsd = turnCost(data);
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
      if (data.cost_kind === "turn") {
        // A stopped / failed turn that still ran: its tokens count too.
        t.costUsd = turnCost(data);
        t.usage = data.usage || t.usage;
      }
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
        meta: metaOf(data),
      };
      if (!hasLiveTurn(turns)) {
        // Nothing running here (e.g. delivered just as the turn closed): plain user bubble.
        turns.push({ key: newKey("u"), role: "user", text: item.text, flow: [], tools: [], complete: true, attachments: item.attachments, meta: item.meta });
        break;
      }
      const t = liveTurn(turns, at);
      const mine = cid ? t.flow.find((f) => f.kind === "steer" && f.clientMsgId === cid) : undefined;
      if (mine && mine.kind === "steer") {
        mine.pending = false;
        if (item.meta) mine.meta = item.meta;
      }
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
        meta: metaOf(data),
      });
      break;
    }
  }
  return {};
}

/** Rebuild turns from persisted history: user messages and events merged on
 * one timeline (not paired by index, which drifts on errors/notices). */
function reconstruct(
  messages: ChatMessage[],
  events: ProviderEvent[],
  park?: (turns: Turn[], ev: ProviderEvent) => boolean,
): Turn[] {
  type Item = { at: string; order: number; eid: number; user?: ChatMessage; ev?: ProviderEvent };
  const items: Item[] = [
    ...messages
      // (+ a mate's greeting: an assistant message with no turn behind it)
      .filter((m) => m.role === "user" || (m.role === "assistant" && m.meta?.kind === "greeting"))
      .map((m) => ({ at: m.created_at || "", order: 0, eid: 0, user: m })),
    ...events.map((e) => ({ at: e.timestamp, order: 1, eid: e.eid || 0, ev: e })),
  ];
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.eid - b.eid));
  const turns: Turn[] = [];
  for (const it of items) {
    if (it.user && it.user.role === "assistant") {
      turns.push({
        key: newKey("g"),
        role: "assistant",
        text: it.user.content,
        flow: [{ kind: "text", text: it.user.content }],
        tools: [],
        complete: true,
        status: "done",
        meta: it.user.meta || undefined,
      });
    } else if (it.user) {
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
        meta: it.user.meta || undefined,
      });
    } else if (it.ev) {
      if (park && park(turns, it.ev)) continue;
      reduce(turns, it.ev);
    }
  }
  return turns;
}

// ---- paging: events of turns that aren't loaded ------------------------------

/** The tool call an event reports into (it can't be applied without it). */
function anchorOf(ev: ProviderEvent): string | null {
  const d = ev.data as Record<string, any>;
  switch (ev.type) {
    case "tool.use":
    case "subagent.text":
    case "subagent.thinking":
      return d.parent ? String(d.parent) : null;
    case "tool.result":
      return d.id ? String(d.id) : null;
    case "task.update":
      return d.tool_use_id ? String(d.tool_use_id) : null;
  }
  return null;
}

const isOrphan = (turns: Turn[], ev: ProviderEvent) => {
  const a = anchorOf(ev);
  return !!a && turnOf(turns, a) < 0;
};

/** Apply a parked event to the detached holder when it belongs there (a
 * pinned launch, or a step under one). */
function intoHolder(holder: Turn | null, ev: ProviderEvent): Turn | null {
  const launch = ev.type === "tool.use" && !(ev.data as Record<string, any>).parent;
  const a = anchorOf(ev);
  if (!launch && (!holder || !a || !holder.tools.some((t) => t.id === a))) return holder;
  const ts: Turn[] = holder ? [{ ...holder, complete: false }] : [];
  reduce(ts, ev);
  const t = ts[ts.length - 1];
  return t ? { ...t, key: "detached", complete: true, status: "done" } : holder;
}

const byEid = (a: ProviderEvent, b: ProviderEvent) => (a.eid || 0) - (b.eid || 0);

function mergeOrphans(...lists: ProviderEvent[][]): ProviderEvent[] {
  const seen = new Set<number>();
  const out: ProviderEvent[] = [];
  for (const l of lists)
    for (const e of l) {
      if (e.eid) {
        if (seen.has(e.eid)) continue;
        seen.add(e.eid);
      }
      out.push(e);
    }
  return out.sort(byEid);
}

/** The loaded turns plus the detached holder (subagent lists, the panel). */
export const withDetached = (turns: Turn[], detached: Turn | null) => (detached ? [...turns, detached] : turns);

/** An older page's last turn still open: close it the way the full replay
 * would when the next turn (`next`, the first loaded one) begins. */
function closeTrailing(turns: Turn[], next: Turn | undefined) {
  if (!hasLiveTurn(turns)) return;
  const t = liveTurn(turns, Date.now());
  if (next?.role === "assistant" && next.trigger === "background") {
    finish(t, next.startedAt || t.startedAt || Date.now()); // (session.start)
  } else {
    finish(t, t.startedAt || Date.now()); // (a user message)
    t.status = t.status === "running" ? "done" : t.status;
  }
}

/** A terminal event's API-equivalent cost for this turn (the backend serves
 * per-turn values, legacy ones normalized); undefined when the engine reports
 * no cost (Codex). */
function turnCost(data: Record<string, any>): number | undefined {
  if (data.cost_kind === "none" || data.cost_usd === undefined || data.cost_usd === null) return undefined;
  return Number(data.cost_usd) || 0;
}

/** API-equivalent cost of the whole chat (turns that reported one). */
const totalCost = (turns: Turn[]) => turns.reduce((n, t) => n + (t.costUsd || 0), 0);

/** A conversation store: the Chat view's (useChatStore) and, separately, the
 * Mate's (so both can be live at once). Same reducer, same turn model. */
const NO_PAGING: Paging = { paged: false, cursor: null, hasMore: false, loading: false, error: null, baseEid: 0 };
const NO_PINS: ReadonlySet<string> = new Set();

/** A page's reconstruct parks events whose tool call is in an older page. */
function parker(on: boolean, parked: ProviderEvent[]) {
  if (!on) return undefined;
  return (turns: Turn[], ev: ProviderEvent) => {
    if (!isOrphan(turns, ev)) return false;
    parked.push(ev);
    return true;
  };
}

export function createChatStore() {
  return create<ChatState>((set, get) => ({
  sid: null,
  turns: [],
  isStreaming: false,
  runningCostUsd: 0,
  lastEid: 0,
  info: null,
  context: null,
  lastCompaction: null,
  connection: "connecting",
  bounced: [],
  paging: NO_PAGING,
  older: null,
  orphans: [],
  detached: null,
  pinnedTools: NO_PINS,
  openSeq: 0,
  opened: false,
  gen: 0,

  reset: (sid = null) =>
    set((s) => ({
      sid,
      turns: [],
      isStreaming: false,
      runningCostUsd: 0,
      lastEid: 0,
      info: null,
      bounced: [],
      context: null,
      lastCompaction: null,
      paging: NO_PAGING,
      older: null,
      orphans: [],
      detached: null,
      pinnedTools: NO_PINS,
      opened: false,
      gen: s.gen + 1,
    })),

  loadHistory: (h) => {
    // A paged response (?turns= / ?since=) or the whole chat (the old one).
    const page = "page" in h && h.page ? (h as HistoryPage) : null;
    const more = !!page?.page.has_more;
    const parked: ProviderEvent[] = [];
    const turns = reconstruct(h.messages, h.events, parker(more, parked));
    if (!h.running && hasLiveTurn(turns)) {
      const t = liveTurn(turns, Date.now());
      finish(t, t.endedAt || t.startedAt || Date.now());
      t.status = "interrupted";
      t.error = { code: "turn.lost", message: "The run ended unexpectedly" };
    }
    const lastEid = Math.max(h.events.reduce((m, e) => Math.max(m, e.eid || 0), 0), page?.page.last_eid || 0);
    const pinned = page?.summary?.pinned || [];
    const orphans = more ? mergeOrphans(pinned, parked) : [];
    const older = page ? page.before : null;
    set((s) => ({
      turns,
      lastEid,
      isStreaming: h.running,
      runningCostUsd: (older?.cost_usd || 0) + totalCost(turns),
      info: (h.session?.cli_info as CliInfo) || null,
      ...(page
        ? { context: page.summary?.context ?? null, lastCompaction: page.summary?.last_compaction ?? null }
        : contextOf(h.events)),
      older,
      orphans,
      detached: orphans.reduce(intoHolder, null as Turn | null),
      pinnedTools: new Set(pinned.filter((e) => e.type === "tool.use").map((e) => String(e.data.id))),
      paging: { paged: !!page, cursor: page?.page.cursor ?? null, hasMore: more, loading: false, error: null, baseEid: lastEid },
      openSeq: s.opened ? s.openSeq : s.openSeq + 1,
      opened: true,
      gen: s.gen + 1,
    }));
  },

  loadOlder: async (beforeApply) => {
    const s0 = get();
    const { sid, gen } = s0;
    const cursor = s0.paging.cursor;
    if (!sid || !cursor || !s0.paging.hasMore || s0.paging.loading) return;
    set({ paging: { ...s0.paging, loading: true, error: null } });
    let page: OlderPage;
    try {
      page = await getOlderPage(sid, cursor, OLDER_TURNS);
    } catch (e) {
      if (get().gen === gen) set((s) => ({ paging: { ...s.paging, loading: false, error: String((e as Error)?.message || e) } }));
      return;
    }
    if (get().gen !== gen || get().paging.cursor !== cursor) return; // reloaded meanwhile
    beforeApply?.();
    set((s) => {
      // (an event newer than the last reload already came live)
      const events = page.events.filter((e) => !(e.eid && e.eid > s.paging.baseEid));
      const inPage = new Set(page.events.map((e) => e.eid || 0));
      const parked: ProviderEvent[] = [];
      const prev = reconstruct(page.messages, events, parker(page.page.has_more, parked));
      closeTrailing(prev, s.turns[0]);
      const turns = [...prev, ...s.turns];
      // Parked events whose turn is loaded now go where they belong.
      const still: ProviderEvent[] = [];
      for (const ev of s.orphans) {
        if (ev.eid && inPage.has(ev.eid)) continue; // (pinned: the page has it)
        const launch = ev.type === "tool.use" && !(ev.data as Record<string, any>).parent;
        if (launch || isOrphan(turns, ev)) still.push(ev); // (a pinned launch waits for its own page)
        else reduce(turns, ev);
      }
      const orphans = page.page.has_more ? mergeOrphans(parked, still) : [];
      return {
        turns,
        orphans,
        detached: orphans.reduce(intoHolder, null as Turn | null),
        older: page.before,
        runningCostUsd: (page.before?.cost_usd || 0) + totalCost(turns),
        paging: { ...s.paging, cursor: page.page.cursor, hasMore: page.page.has_more, loading: false, error: null },
      };
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
      const lastEid = ev.eid ? Math.max(s.lastEid, ev.eid) : s.lastEid;
      if (s.paging.hasMore && isOrphan(s.turns, ev)) {
        // For a turn not loaded yet: parked until it is (shown under its
        // launching call meanwhile, when that one is pinned).
        return { orphans: [...s.orphans, ev], detached: intoHolder(s.detached, ev), lastEid };
      }
      const turns = [...s.turns];
      const extra = reduce(turns, ev);
      if (extra.bounced) extra.bounced = [...s.bounced, ...extra.bounced];
      if (extra.context) extra.context = mergeContext(s.context, extra.context);
      if (hasLiveTurn(turns) && ev.type !== "run.state") extra.isStreaming = true;
      return {
        turns,
        ...extra,
        lastEid,
        runningCostUsd:
          ev.type === "turn.complete" || ev.type === "error" ? (s.older?.cost_usd || 0) + totalCost(turns) : s.runningCostUsd,
      };
    }),
  }));
}

export type ChatStoreApi = ReturnType<typeof createChatStore>;
export type { ChatState };

export const useChatStore = createChatStore();
