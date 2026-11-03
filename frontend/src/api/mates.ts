/** /api/mates (docs/mate.md §1–5). */
import { apiFetch, apiResponse, toLogin } from "./client";
import { tr } from "../i18n";
import type { Avatar } from "../mate/types";
import type { Session } from "../types";

/** who she is — the character only (how she talks is the conversation style: MatePrefs) */
export interface Persona {
  description: string;
  personality: string;
  greeting: string;
  /** the reply language (stored here: it also picks the localized name/greeting); edited in Conversation style */
  language: string;
  instructions: string;
}

export type TtsEngine = "off" | "browser" | "openai" | "elevenlabs" | "omnivoice" | "http";
/** elevenlabs = Scribe v2 Realtime (live transcript while speaking; the page streams with a server-minted token) */
export type SttEngine = "off" | "browser" | "openai" | "whisper" | "elevenlabs";

export interface MateVoice {
  auto_read: boolean;
  /** 0.0 – 3.0 (1.0 = 100 %, as synthesized); above 1 the page amplifies with a limiter. Missing on old documents = 1. */
  volume?: number;
  tts: {
    engine: TtsEngine;
    voice: string;
    model: string;
    speed: number;
    profile: string;
    language: string;
    /** OmniVoice voice design ("female, young adult, low pitch") */
    instruct?: string;
    /** a reference clip: mate asset path (e.g. "voice/ref.wav") */
    ref?: string;
    /** the reference clip's transcript */
    ref_text?: string;
  };
  stt: {
    engine: SttEngine;
    model: string;
    language: string;
    /** realtime: a finished utterance is sent by itself (default off: it waits in the box) */
    auto_send?: boolean;
    /** realtime: talking while she speaks stops her voice (default on, with echo protection) */
    barge_in?: boolean;
    /** realtime: the pause (s) that ends an utterance, 0.3 – 3 (default 1.2) */
    silence?: number;
  };
}

/** the engines that can run a mate (sealed: own prompt, only the mate tools) */
export type MateEngine = "claude" | "codex";

export interface MateLlm {
  provider: MateEngine;
  model: string; // "" = the engine's mate default
  effort: string; // default|low|medium|high|xhigh|max
}

export type Formality = "auto" | "haeyo" | "hapsyo" | "banmal";
export type ReplyLength = "short" | "normal" | "long";
export type ToneLevel = "auto" | "low" | "high";
export type RecallLevel = "off" | "light" | "normal" | "rich";
/** 0 off · 1 subtle · 2 normal · 3 expressive */
export type EmotionLevel = 0 | 1 | 2 | 3;

/** may she change her own conversation style: yes | as a proposal the user applies | no */
export type SelfEdit = "auto" | "ask" | "off";

/** the character's own way of talking (bundled characters / imports — data, not a setting) */
export interface StyleDefaults {
  /** "" = none */
  formality: "" | Exclude<Formality, "auto">;
  /** may contain {name} (the user's name) */
  address: string;
  self_ref: string;
}

/** The conversation style (대화 방식): the one place that decides how she talks (docs/mate.md "Prompt composition") */
export interface MatePrefs {
  proactive?: { enabled: boolean; interval: number; guidance: string };
  user_name: string;
  /** what she calls the user ("" = her character's way: defaults.address) */
  address: string;
  /** how she refers to herself ("" = her character's way) */
  self_ref: string;
  /** auto = her character's own level (defaults.formality) */
  formality: Formality;
  /** speech habits: rhythm, catchphrases, sample lines */
  speech_style: string;
  length: ReplyLength;
  emotion: EmotionLevel;
  tone: { warmth: ToneLevel; humor: ToneLevel; initiative: ToneLevel };
  avoid: string;
  memory: { recall: RecallLevel; self_save: boolean };
  self_edit: SelfEdit;
  defaults: StyleDefaults;
}

export const DEFAULT_PREFS: MatePrefs = {
  user_name: "",
  address: "",
  self_ref: "",
  formality: "auto",
  speech_style: "",
  length: "normal",
  emotion: 2,
  tone: { warmth: "auto", humor: "auto", initiative: "auto" },
  avoid: "",
  memory: { recall: "normal", self_save: true },
  self_edit: "auto",
  defaults: { formality: "", address: "", self_ref: "" },
};

/** a change of the conversation style she made herself (update_conversation_style) */
export interface StyleChange {
  id: string;
  mate_id: string;
  created_at: string;
  actor: "mate" | "user";
  status: "applied" | "proposed" | "dismissed" | "undone";
  reason: string;
  /** flat paths: formality, address, user_name, self_ref, language, length, emotion, tone.warmth, …, speech_style, avoid */
  changes: Record<string, { from: unknown; to: unknown }>;
  session_id: string | null;
  resolved_at: string | null;
}

export type RelationStage = "new" | "familiar" | "trusted" | "companion";
export const RELATION_STAGES: RelationStage[] = ["new", "familiar", "trusted", "companion"];
export type MoodLabel = "cheerful" | "content" | "calm" | "focused" | "sleepy" | "concerned";

/** what the mate document carries about the relationship (the indicator) */
export interface RelationSummary {
  enabled: boolean;
  paused: boolean;
  stage: RelationStage;
  /** 0 – 100, rounded */
  affinity: number;
  mood: MoodLabel | null;
  show_indicator: boolean;
  avatar_mood: boolean;
}

/** GET /api/mates/{id}/relation (docs/mate-memory-affinity.md §5) */
export interface RelationView {
  enabled: boolean;
  paused: boolean;
  /** 0.5 – 1.5 */
  sensitivity: number;
  show_indicator: boolean;
  avatar_mood: boolean;
  affinity: number;
  stage: RelationStage;
  earned_stage: RelationStage;
  warmth_stage: RelationStage;
  next: { stage: RelationStage; ratio: number; needs: { days: number; turns: number; memories: number } } | null;
  stats: { days_together: number; turns: number; active_days: number; streak_days: number; memories: number; idle_days: number | null; grace_days: number };
  mood: { label: MoodLabel; valence: number; energy: number };
  milestones: { key: string; at: string }[];
  /** newest first: d = the change, v = the value after it */
  log: { at: string; d: number; why: string; v: number }[];
  started_at: string | null;
}
export type RelationPatch = Partial<Pick<RelationView, "enabled" | "paused" | "sensitivity" | "show_indicator" | "avatar_mood" | "affinity">>;

/** a change in the Relationship panel's journal: `kind` sorts it (the user's own changes are `manual`) */
export interface RelationChange {
  at: string;
  d: number;
  why: string;
  /** the value after it (stage events: null) */
  v: number | null;
  kind: "gain" | "loss" | "manual" | "stage";
  /** stage events: the stage reached (`stage_up`) or now (`stage_now`) */
  stage?: RelationStage;
}

/** GET /api/mates/{id}/relation/journal (the Relationship panel; reads only) */
export interface RelationJournal {
  days: number;
  /** the user's local day (their timezone) */
  today: string;
  /** oldest first; v = the value at the end of that day (null: before the start) */
  series: { day: string; v: number | null; up: number; down: number; talks: number }[];
  series_source: "log" | "log+replay";
  relation: RelationView;
  /** what the next stage still needs; null at the last stage */
  requirements: {
    stage: RelationStage;
    earned: {
      stage: RelationStage;
      met: boolean;
      have: { days: number; turns: number; memories: number };
      need: { days: number; turns: number; memories: number };
      left: { days: number; turns: number; memories: number };
      ratio: number;
    };
    warmth: { stage: RelationStage; met: boolean; value: number; target: number; left: number; ratio: number };
  } | null;
  stats: RelationView["stats"] & { longest_streak: number; memories_active: number; first_talk_at: string | null; last_talk_at: string | null };
  milestones: { key: string; at: string }[];
  anniversaries: { days: number; day: string; reached: boolean; in_days: number }[];
  /** newest first */
  changes: RelationChange[];
  /** the latest memories she saved (newest first) */
  memories: { id: string; text: string; kind: string; created_at: string; source: string | null }[];
}

/** may the mate look at the screen (see_screen; docs/mate.md §4 "Seeing the screen") — what to capture is chosen in
 * the desktop app on each computer */
export interface MateScreen {
  enabled: boolean;
  approval: "ask" | "allow";
  hide_avatar: boolean;
  /** the picture's long side at most (0: as captured) */
  max_edge: 0 | 1280 | 1920 | 2560;
  format: "png" | "jpeg";
  quality: number;
}

export const DEFAULT_SCREEN: MateScreen = { enabled: false, approval: "ask", hide_avatar: true, max_edge: 1920, format: "png", quality: 85 };

/** the mate's screen settings, complete (an older server sends none) */
export const screenOf = (m: Pick<Mate, "screen"> | null | undefined): MateScreen => ({ ...DEFAULT_SCREEN, ...(m?.screen ?? {}) });

export interface Mate {
  id: string;
  name: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  persona: Persona;
  avatar: Avatar;
  llm: MateLlm;
  voice: MateVoice;
  /** missing on documents from an older server: DEFAULT_PREFS */
  prefs?: MatePrefs;
  /** missing on documents from an older server */
  relation?: RelationSummary;
  /** missing on documents from an older server: DEFAULT_SCREEN */
  screen?: MateScreen;
  session_id: string | null;
  /** a mate shipped with the app (estelle | chaerin | seoa), else null */
  builtin?: string | null;
  /** a built-in the user edited (bundle updates keep the fields the user changed) */
  customized?: boolean;
  /** still being made in the Mate Create studio (hidden from the mate list until Create mate) */
  draft?: boolean;
}

export interface MatePatch {
  name?: string;
  is_default?: boolean;
  persona?: Partial<Persona>;
  avatar?: Avatar;
  llm?: Partial<MateLlm>;
  voice?: { auto_read?: boolean; volume?: number; tts?: Partial<MateVoice["tts"]>; stt?: Partial<MateVoice["stt"]> };
  prefs?: Partial<Omit<MatePrefs, "tone" | "memory" | "defaults" | "proactive">> & { proactive?: Partial<NonNullable<MatePrefs["proactive"]>>; tone?: Partial<MatePrefs["tone"]>; memory?: Partial<MatePrefs["memory"]> };
  screen?: Partial<MateScreen>;
}

/** the mate's conversation settings, complete (an older server sends none) */
export const prefsOf = (m: Pick<Mate, "prefs"> | null | undefined): MatePrefs => ({
  ...DEFAULT_PREFS,
  ...(m?.prefs ?? {}),
  tone: { ...DEFAULT_PREFS.tone, ...(m?.prefs?.tone ?? {}) },
  memory: { ...DEFAULT_PREFS.memory, ...(m?.prefs?.memory ?? {}) },
  defaults: { ...DEFAULT_PREFS.defaults, ...(m?.prefs?.defaults ?? {}) },
});

/** what the style comes to: her own choice, else her character's (the settings show it as the "auto" value) */
export const effectiveStyle = (p: MatePrefs) => ({
  formality: (p.formality !== "auto" ? p.formality : p.defaults.formality) || "",
  address: p.address || p.defaults.address,
  selfRef: p.self_ref || p.defaults.self_ref,
});

/** an address the character builds on the user's name ({name} 님), shown with the name (or a placeholder) */
export const fillAddress = (address: string, userName: string, placeholder: string) =>
  address.split("{name}").join(userName.trim() || placeholder);

export interface Conversation {
  mate: Mate;
  session_id: string;
  session: Session;
  running: boolean;
}

export type MemoryKind = "profile" | "preference" | "fact" | "plan" | "context";
export const MEMORY_KINDS: MemoryKind[] = ["profile", "preference", "fact", "plan", "context"];
export type MemoryStatus = "active" | "done" | "archived";

/** one memory (docs/mate-memory-affinity.md §4) */
export interface Memory {
  id: string;
  text: string;
  created_at: string;
  kind: MemoryKind;
  /** 1 – 5 */
  importance: number;
  /** the user's: always in the system prompt */
  pinned: boolean;
  /** plan: YYYY-MM-DD or YYYY-MM-DDTHH:MM (the user's local time) */
  due_at: string | null;
  expires_at: string | null;
  status: MemoryStatus;
  source: "mate" | "user" | "import" | "merge";
  updated_at: string;
  last_used_at: string | null;
  use_count: number;
  /** in the core: what she always knows (the rest is recalled when relevant) */
  core?: boolean;
  /** looks like a rule about how she talks (it belongs in the conversation style); a hint, read-only */
  style_flag?: { reason: "formality" | "address" | "speech"; conflict: boolean; level?: Formality | null } | null;
}

export interface MemoryAdded extends Memory {
  /** an active memory of that kind said the same: it was updated instead */
  merged: boolean;
  similar: Memory[];
}

export type MemoryPatch = Partial<Pick<Memory, "text" | "kind" | "importance" | "pinned" | "due_at" | "status">>;
export interface MemoryQuery {
  q?: string;
  kind?: MemoryKind | "";
  status?: MemoryStatus | "all";
  sort?: "created" | "recent" | "importance" | "due";
}
export interface MemoryStats {
  active: number;
  done: number;
  archived: number;
  core: number;
}
export interface RecallPreview {
  core: Memory[];
  recalled: Memory[];
  level: RecallLevel;
  block: string;
}

export interface VoiceSettings {
  openai_key_set: boolean;
  elevenlabs_key_set: boolean;
  omnivoice_url: string;
  whisper_url: string;
  http_tts_url: string;
  http_tts_key_set: boolean;
  /** the user's IANA timezone ("" = the server's): the mate's clock, plan dates, relationship days */
  timezone?: string;
}

export type VoiceSettingsPatch = Partial<{
  timezone: string;
  openai_key: string | null;
  elevenlabs_key: string | null;
  http_tts_key: string | null;
  omnivoice_url: string;
  whisper_url: string;
  http_tts_url: string;
}>;

export interface VoiceOption {
  id: string;
  name: string;
  language?: string | null;
  /** ElevenLabs: premade | cloned | generated | professional …; OmniVoice: template */
  category?: string | null;
  /** ElevenLabs labels (accent, gender, age, use_case, …) */
  labels?: Record<string, string>;
  /** ElevenLabs verified languages */
  languages?: string[];
  description?: string;
  preview_url?: string | null;
  /** ElevenLabs: a preview per verified language */
  previews?: Record<string, string>;
  /** OmniVoice: the profile's reference-clip emotions */
  emotions?: string[];
  /** OpenAI: the models this voice speaks on */
  models?: string[];
}

export interface ModelOption {
  id: string;
  name: string;
  description?: string | null;
  languages?: string[];
}

export interface ModelList {
  engine: string;
  kind: "tts" | "stt";
  models: ModelOption[];
  /** what the backend uses when the mate names no model */
  default: string;
  /** OmniVoice: the languages it speaks */
  languages?: string[];
}

/** a voice provider set up in Global settings (GET /api/mates/providers) */
export interface ProviderStatus {
  engine: string;
  label: string;
  kind?: "tts" | "stt";
  /** its key / URL is set */
  configured: boolean;
  /** the last verification passed (null: configured, not checked yet) */
  ok: boolean | null;
  error: string | null;
  detail: string | null;
  checked_at: string | null;
}

export interface Providers {
  tts: ProviderStatus[];
  stt: ProviderStatus[];
}

/** the Live2D Cubism Core on the server (GET /api/mates/live2d/core) */
export interface CoreStatus {
  installed: boolean;
  installing?: boolean;
  received?: number;
  total?: number | null;
  error?: string | null;
  size?: number;
  source?: string;
}

/** one line of the install stream (POST /api/mates/live2d/core/install, NDJSON) */
export type CoreEvent =
  | { phase: "downloading"; received: number; total: number | null }
  | { phase: "verifying" }
  | { phase: "done"; installed: boolean; size?: number }
  | { phase: "error"; error: string };

const j = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const listMates = () => apiFetch<Mate[]>("/api/mates");
export const getMate = (id: string) => apiFetch<Mate>(`/api/mates/${enc(id)}`);
export const createMate = (body: MatePatch & { name: string }) => apiFetch<Mate>("/api/mates", { method: "POST", ...j(body) });
export const updateMate = (id: string, patch: MatePatch) =>
  apiFetch<Mate>(`/api/mates/${enc(id)}`, { method: "PATCH", ...j(patch) });
/** bring back deleted built-in mates → the whole list */
export const restoreBuiltins = () => apiFetch<Mate[]>("/api/mates/builtin/restore", { method: "POST" });
/** a built-in mate: the bundled avatar back (clip / trigger edits undone) → the mate */
export const resetBuiltinAvatar = (id: string) => apiFetch<Mate>(`/api/mates/${enc(id)}/avatar/reset`, { method: "POST" });
export const deleteMate = (id: string) => apiFetch<{ deleted: boolean }>(`/api/mates/${enc(id)}`, { method: "DELETE" });

export const openConversation = (id: string) =>
  apiFetch<Conversation>(`/api/mates/${enc(id)}/conversation`, { method: "POST" });
export const resetConversation = (id: string) =>
  apiFetch<Conversation>(`/api/mates/${enc(id)}/conversation/reset`, { method: "POST" });

export const listMemories = (id: string, q: MemoryQuery = {}) => {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
  return apiFetch<Memory[]>(`/api/mates/${enc(id)}/memories${qs ? `?${qs}` : ""}`);
};
export const memoryStats = (id: string) => apiFetch<MemoryStats>(`/api/mates/${enc(id)}/memories/stats`);
export const addMemory = (id: string, body: string | (MemoryPatch & { text: string })) =>
  apiFetch<MemoryAdded>(`/api/mates/${enc(id)}/memories`, { method: "POST", ...j(typeof body === "string" ? { text: body } : body) });
export const updateMemory = (id: string, mid: string, patch: MemoryPatch) =>
  apiFetch<Memory>(`/api/mates/${enc(id)}/memories/${enc(mid)}`, { method: "PATCH", ...j(patch) });
export const bulkMemories = (id: string, ids: string[], action: "delete" | "archive" | "restore" | "pin" | "unpin") =>
  apiFetch<{ changed: number }>(`/api/mates/${enc(id)}/memories/bulk`, { method: "POST", ...j({ ids, action }) });
export const getRelation = (id: string) => apiFetch<RelationView>(`/api/mates/${enc(id)}/relation`);
export const getRelationJournal = (id: string, days = 30) =>
  apiFetch<RelationJournal>(`/api/mates/${enc(id)}/relation/journal?days=${days}`);
export const patchRelation = (id: string, patch: RelationPatch) =>
  apiFetch<RelationView>(`/api/mates/${enc(id)}/relation`, { method: "PATCH", ...j(patch) });
export const resetRelation = (id: string, mode: "zero" | "recompute") =>
  apiFetch<RelationView>(`/api/mates/${enc(id)}/relation/reset`, { method: "POST", ...j({ mode }) });
export const previewRecall = (id: string, text: string) =>
  apiFetch<RecallPreview>(`/api/mates/${enc(id)}/memories/preview`, { method: "POST", ...j({ text }) });
export const memoryToStyle = (id: string, mid: string) =>
  apiFetch<{ mate: Mate; memory: Memory }>(`/api/mates/${enc(id)}/memories/${enc(mid)}/to-style`, { method: "POST" });
export const memoryStyleOk = (id: string, mid: string) =>
  apiFetch<{ dismissed: boolean }>(`/api/mates/${enc(id)}/memories/${enc(mid)}/style-ok`, { method: "POST" });
export const listStyleChanges = (id: string) => apiFetch<StyleChange[]>(`/api/mates/${enc(id)}/style-changes`);
export const resolveStyleChange = (id: string, cid: string, action: "undo" | "apply" | "dismiss") =>
  apiFetch<{ change: StyleChange; mate: Mate; skipped: string[] }>(`/api/mates/${enc(id)}/style-changes/${enc(cid)}/${action}`, { method: "POST" });
export const deleteMemory = (id: string, mid: string) =>
  apiFetch<{ deleted: boolean }>(`/api/mates/${enc(id)}/memories/${enc(mid)}`, { method: "DELETE" });

export const getVoiceSettings = () => apiFetch<VoiceSettings>("/api/mates/settings");
/** save keys / URLs; `verify`: the changed providers are checked right away (→ `providers`) */
export const putVoiceSettings = (patch: VoiceSettingsPatch, verify = false) =>
  apiFetch<VoiceSettings & { providers?: Providers }>(`/api/mates/settings${verify ? "?verify=1" : ""}`, {
    method: "PUT",
    ...j(patch),
  });
export const listVoices = (engine: string) =>
  apiFetch<{ engine: string; voices: VoiceOption[] }>(`/api/mates/voices?engine=${enc(engine)}`);
export const listModels = (engine: string, kind: "tts" | "stt") =>
  apiFetch<ModelList>(`/api/mates/models?engine=${enc(engine)}&kind=${kind}`);
/** every provider's state; configured ones are (re-)verified when stale, or all of them with `refresh` */
export const getProviders = (refresh = false) => apiFetch<Providers>(`/api/mates/providers${refresh ? "?refresh=1" : ""}`);
export const verifyProvider = (engine: string) =>
  apiFetch<ProviderStatus>(`/api/mates/providers/${enc(engine)}/verify`, { method: "POST" });

export const coreStatus = () => apiFetch<CoreStatus>("/api/mates/live2d/core");

/**
 * Install the Cubism Core, reporting progress. The server streams NDJSON lines (`{"phase":"downloading",…}` …
 * `{"phase":"done"|"error",…}`); an older server answers one JSON object. Either way the last event is returned
 * (always "done" or "error").
 */
export async function installCore(onEvent: (e: CoreEvent) => void, signal?: AbortSignal): Promise<CoreEvent> {
  const fail = (error: string): CoreEvent => {
    const e: CoreEvent = { phase: "error", error };
    onEvent(e);
    return e;
  };
  let res: Response;
  try {
    res = await fetch("/api/mates/live2d/core/install", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" },
      body: JSON.stringify({ accept_license: true }),
      signal,
    });
  } catch (e) {
    return fail(tr("mate.installUnreachable", { error: (e as Error).message }));
  }
  if (res.status === 401) {
    toLogin();
    return fail("authentication required"); // i18n-ignore (the page goes to the login page)
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    return fail(String(err.detail || res.statusText || `HTTP ${res.status}`));
  }
  let last: CoreEvent | null = null;
  const emit = (raw: unknown) => {
    const e = toCoreEvent(raw);
    if (e) {
      last = e;
      onEvent(e);
    }
  };
  const ctype = res.headers.get("content-type") || "";
  if (!res.body || (ctype.includes("application/json") && !ctype.includes("ndjson"))) {
    emit(await res.json().catch(() => null)); // the old one-shot answer
  } else {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const line = (l: string) => {
      const t = l.trim();
      if (!t) return;
      try {
        emit(JSON.parse(t));
      } catch {
        /* not a complete JSON line: skip it */
      }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }); // a chunk may end mid-line (or mid-character)
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          line(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      buf += dec.decode();
      line(buf);
    } catch (e) {
      if (signal?.aborted) throw e;
      return fail(tr("mate.installDropped", { error: (e as Error).message }));
    }
  }
  const end = last as CoreEvent | null;
  if (end && (end.phase === "done" || end.phase === "error")) return end;
  return fail(tr("mate.installStopped"));
}

function toCoreEvent(raw: unknown): CoreEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  switch (r.phase) {
    case "downloading":
      return { phase: "downloading", received: Number(r.received) || 0, total: r.total == null ? null : Number(r.total) || null };
    case "verifying":
      return { phase: "verifying" };
    case "done":
      return r.installed === false
        ? { phase: "error", error: String(r.error || "the server says the core isn't installed") }
        : { phase: "done", installed: true, size: typeof r.size === "number" ? r.size : undefined };
    case "error":
      return { phase: "error", error: String(r.error || r.detail || "install failed") };
  }
  // the old answer: {installed, size, source}
  if (typeof r.installed === "boolean") {
    return r.installed
      ? { phase: "done", installed: true, size: typeof r.size === "number" ? r.size : undefined }
      : { phase: "error", error: String(r.error || r.detail || "not installed") };
  }
  if (r.detail) return { phase: "error", error: String(r.detail) };
  return null;
}

/** the model a mate talks on when none is set (backend DEFAULT_MATE_MODEL) */
export const DEFAULT_MATE_MODEL = "claude-sonnet-5-5";
/** ... per engine (backend catalog.DEFAULT_MATE_MODELS) */
export const DEFAULT_MATE_MODELS: Record<MateEngine, string> = { claude: DEFAULT_MATE_MODEL, codex: "gpt-6.1-sol" };
/** the reasoning levels a mate can store (backend store.EFFORTS) */
export const MATE_EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];

/** an asset path of a mate → its URL */
export const assetUrl = (id: string, path: string) =>
  `/api/mates/${enc(id)}/assets/${path.split("/").map(enc).join("/")}`;

/** a folder of several ailism characters imports them all (`mates`; `mate` = the first) */
export const importLocal = (body: { path: string; mate_id?: string; name?: string }) =>
  apiFetch<{ mate: Mate; mates?: Mate[]; imported: string }>("/api/mates/import-local", { method: "POST", ...j(body) });

/** multipart upload (no JSON content type: the browser sets the boundary) */
async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: "POST", body: form });
  if (res.status === 401) {
    toLogin();
    throw new Error("authentication required"); // i18n-ignore (the page goes to the login page)
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json() as Promise<T>;
}

export function uploadAsset(id: string, file: Blob, path: string) {
  const f = new FormData();
  f.append("file", file, path.split("/").pop() || "file");
  f.append("path", path);
  return upload<{ path: string; url: string; size: number }>(`/api/mates/${enc(id)}/assets`, f);
}

export function importAvatarZip(id: string, file: File) {
  const f = new FormData();
  f.append("file", file, file.name);
  return upload<{ mate: Mate; avatar: Avatar }>(`/api/mates/${enc(id)}/avatar/import`, f);
}

/** a recording → text. `engine`: another provider than the mate's (the realtime mic's fallback; "auto" = the server's pick) */
export function transcribe(id: string, audio: Blob, engine?: string) {
  const f = new FormData();
  const ext = audio.type.includes("wav") ? "wav" : audio.type.includes("ogg") ? "ogg" : audio.type.includes("mp4") ? "m4a" : "webm";
  f.append("file", audio, `speech.${ext}`);
  const q = engine ? `?engine=${encodeURIComponent(engine)}` : "";
  return upload<{ text: string; language?: string; engine?: string }>(`/api/mates/${enc(id)}/transcribe${q}`, f);
}

export interface RealtimeSttToken {
  /** wss URL to stream to (the single-use token inside — consumed on connect, 15 min to use it) */
  url: string;
  model: string;
  sample_rate: number;
  language: string;
  commit_strategy: string;
  silence: number;
  expires_in: number;
  /** what transcribes a recording when the stream fails (whisper | openai | elevenlabs | null) */
  fallback: string | null;
}

/** why the realtime mic can't start (the server's `code`) and what can transcribe instead */
export class RealtimeTokenError extends Error {
  readonly code: string;
  readonly fallback: string | null;
  constructor(message: string, code: string, fallback: string | null) {
    super(message);
    this.code = code;
    this.fallback = fallback;
  }
}

/** a single-use ElevenLabs realtime token for this mate's mic (the key never leaves the server) */
export async function realtimeSttToken(id: string): Promise<RealtimeSttToken> {
  let res: Response;
  try {
    res = await fetch(`/api/mates/${enc(id)}/stt/realtime`, { method: "POST", cache: "no-store" });
  } catch (e) {
    throw new RealtimeTokenError((e as Error).message || String(e), "network", null);
  }
  if (res.status === 401) {
    toLogin();
    throw new RealtimeTokenError("authentication required", "network", null); // i18n-ignore (the page goes to the login page)
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new RealtimeTokenError(String(body.detail || res.statusText), String(body.code || "upstream"), body.fallback ?? null);
  return body as RealtimeSttToken;
}

/** The mate's engine isn't set up in Global settings (any more): the browser voice should speak instead. */
export class SpeechFallbackError extends Error {
  readonly fallback = "browser";
}

/**
 * TTS for one sentence: a Blob, or null when the page speaks itself (204: browser / off). `tts`: unsaved voice fields
 * to try (a settings preview; never stored). An engine that isn't set up throws {@link SpeechFallbackError} (the
 * server's `X-Speech-Fallback`), so the caller can say why and speak with the browser voice.
 */
export async function speech(
  id: string,
  text: string,
  emotion: string | null,
  signal?: AbortSignal,
  tts?: Partial<MateVoice["tts"]>,
): Promise<Blob | null> {
  const res = await apiResponse(`/api/mates/${enc(id)}/speech`, {
    method: "POST",
    signal,
    ...j({ text, emotion: emotion || "", ...(tts ? { tts } : {}) }),
  });
  if (res.status === 204) {
    if (res.headers.get("X-Speech-Fallback")) {
      throw new SpeechFallbackError(
        tr("mate.speechFallback", { reason: res.headers.get("X-Speech-Fallback-Reason") || tr("mate.engineNotSetUp") }),
      );
    }
    return null;
  }
  return res.blob();
}
