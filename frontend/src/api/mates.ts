/** /api/mates (docs/mate.md §1–5). */
import { apiFetch, apiResponse, toLogin } from "./client";
import { tr } from "../i18n";
import type { Avatar, RigFrame } from "../mate/types";
import type { Session } from "../types";

/** who she is — the character only (how she talks is the conversation style: MatePrefs) */
export interface Persona {
  description: string;
  personality: string;
  greeting: string;
  /** the reply language (stored here: it also picks the localized name/greeting); edited in Conversation style */
  language: string;
  instructions: string;
  /** who she is, as the character's data: nothing in the app shows or sets it ("" = not known) */
  gender?: "female" | "male" | "";
  /** her birthday, "MM-DD" ("" none; missing on documents from an older server): her day knows it (app/mate/life) */
  birthday?: string;
}

export type TtsEngine = "google" | "off" | "browser" | "openai" | "elevenlabs" | "omnivoice" | "http";
/** elevenlabs = Scribe v2 Realtime (live transcript while speaking; the page streams with a server-minted token) */
export type SttEngine = "google" | "off" | "browser" | "openai" | "whisper" | "elevenlabs";

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
    merge_fragments?: boolean;
    continuation_grace?: number;
    ignore_short_fragments?: boolean;
    /** realtime: talking while she speaks stops her voice (default on, with echo protection) */
    barge_in?: boolean;
    /** realtime: the pause (s) that ends an utterance, 0.3 – 3 (default 1.2) */
    silence?: number;
  };
}

/** the engines that can run a mate (sealed: own prompt, only the mate tools) */
export type MateEngine = "claude" | "codex" | "anthropic" | "openai" | "google";

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
  proactive?: { enabled: boolean; interval: number; guidance: string; scope?: "all" | "screen"; preset?: GenyTriggerPreset | null };
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
  /** she changes her clothes herself, when she feels like it */
  self_outfit?: "auto" | "off";
  /** her own day: auto = on for a mate who comes with a world of her own */
  life?: "auto" | "on" | "off";
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
  self_outfit: "auto",
  life: "auto",
  defaults: { formality: "", address: "", self_ref: "" },
};

export type LifeNeed = "hunger" | "sleep" | "affection" | "fun" | "stress";
export type LifeNames = { ko?: string; en?: string };

/** her own day, as the mate document carries it (app/mate/life/sim.py ``summary``) */
export interface MateLifeSummary {
  enabled: boolean;
  /** the picture of where she is, at this time of day */
  art?: string;
  weather?: "clear" | "cloudy" | "rain" | "snow";
  /** the real weather where the user is (life/world.py): °C now, the city; none without a location */
  temp?: number | null;
  city?: string;
  /** a public holiday where the user lives (a weekday off) */
  holiday?: boolean;
  outdoor?: boolean;
  place?: string;
  place_name?: LifeNames;
  activity?: string | null;
  activity_name?: LifeNames;
  /** which of her animations this calls for: sleep, eat, drink, game, read, walk, workout, work, or none */
  body?: string;
  since?: string | null;
  until?: string | null;
  slot?: "morning" | "day" | "evening" | "night";
  asleep?: boolean;
  /** they are with her in person */
  with_user?: boolean;
  needs?: Record<LifeNeed, number>;
  /** what today is where the user lives: a day she knows (Pepero Day, Chuseok …), else the public holiday by its name */
  observance?: LifeObservance | null;
  /** whose birthday it is today */
  birthday?: "her" | "user" | "both" | null;
  /** what she just gave them (the last day and a half): for a notice */
  gift?: { id: string; name: LifeNames; at: string } | null;
}

export interface LifeObservance {
  /** a day of builtin/days.json, or "holiday" (a public holiday the calendar doesn't know) */
  id: string;
  name: LifeNames;
  tone: "festive" | "solemn" | "plain";
}

/** what she gave them: theirs to keep */
export interface LifeKeepsake {
  id: string;
  name: LifeNames;
  /** the few words that came with it */
  note: LifeNames;
  kind: string;
  at: string;
  why: string;
  /** why, for the UI: their birthday, a milestone of theirs (key), a day she knows (name), after something that happened to her (name) */
  for: { kind: "birthday" | "milestone" | "day" | "event" | "random"; key: string; name: LifeNames };
}

/** a moment they shared: a story event while together, a milestone of theirs, a birthday they talked on */
export interface LifeMoment {
  kind: "event" | "milestone" | "birthday";
  at: string;
  /** milestone: affinity's key (days_100, stage_trusted …) */
  key?: string;
  /** birthday: whose */
  who?: "her" | "user";
  /** event: its id and title */
  id?: string;
  title?: LifeNames;
}

export type LifeStat = "work" | "gaming" | "stamina" | "cooking" | "sense" | "courage";
export interface LifePlace {
  key: string;
  name: LifeNames;
  open: boolean;
  hours?: [string, string] | null;
  here: boolean;
  minutes: number;
  art: string;
  x?: number | null;
  y?: number | null;
}
export interface LifeEntry {
  activity: string;
  place: string;
  from: string;
  to: string;
  name: LifeNames;
  place_name: LifeNames;
}
/** GET /api/mates/{id}/life: all of it, for the Life panel */
export interface LifeView extends MateLifeSummary {
  stats?: Record<LifeStat, number>;
  money?: number;
  going?: string | null;
  next?: { activity: string; at: string; name: LifeNames } | null;
  map?: string;
  places?: LifePlace[];
  today?: LifeEntry[];
  coins?: number;
  shop?: LifeGift[];
  plan?: { slots: string[]; week: Record<string, string>; now: string | null; choices: { id: string; name: LifeNames }[] };
  journal?: LifeDay[];
  happened?: { at: string; title: LifeNames }[];
  /** what she does for a living */
  job?: LifeNames;
  /** what she gave them, newest first */
  given?: LifeKeepsake[];
  /** the moments they shared, newest first */
  moments?: LifeMoment[];
  /** what she has come to like by doing it with them (and from what they send her), most first; v: 0 – 0.5 */
  tastes?: { activity: string; name: LifeNames; v: number }[];
}
export interface LifeDay {
  day: string;
  hours: Record<string, number>;
  names: Record<string, LifeNames>;
  grown: Partial<Record<LifeStat, number>>;
  money: number;
  titles: LifeNames[];
  /** a few lines in her own words ("": none that day) */
  diary?: string | null;
}
export interface LifeGift {
  id: string;
  name: LifeNames;
  about: LifeNames;
  price: number;
  kind: string;
  keep: boolean;
  /** she already has it */
  have: boolean;
}

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
export type StateEmotion = "happy" | "excited" | "shy" | "angry" | "sad" | "lonely" | "worried" | "sleepy";
export type StateLabel = StateEmotion | "calm";
/** why she feels it: her own words (`text`), or what happened (`code`, with an outfit's `name` or what was said, `quote`) */
export interface StateWhy {
  text?: string;
  code?: string;
  name?: string;
  quote?: string;
  /** code "hostile": what was done to her (violence, coercion, threat, demeaning) */
  kind?: string;
}
export interface StateFeeling {
  emotion: StateEmotion;
  /** 0 – 1 */
  v: number;
  why: StateWhy;
}
/** what the mate document carries: the one state her feelings make (docs/mate-memory-affinity.md §5.4) */
export interface MateState {
  /** the strongest emotion, or calm */
  label: StateLabel;
  level: number;
  /** what the two strongest make together, when they are close */
  blend: string | null;
  /** -1 – 1: how good it all feels */
  valence: number;
  /** 0 – 1: how lively */
  arousal: number;
  /** what stands out, strongest first */
  top: StateFeeling[];
}
export interface StateLogEntry {
  at: string;
  emotion?: StateEmotion;
  from?: number;
  to?: number;
  /** she changed clothes ("": back into her usual ones) */
  clothes?: string;
  why: StateWhy;
}
/** GET /api/mates/{id}/state */
export interface StateView extends MateState {
  feelings: StateFeeling[];
  /** newest first */
  log: StateLogEntry[];
}

/** what the mate document carries about the relationship (the indicator) */
export interface RelationSummary {
  enabled: boolean;
  paused: boolean;
  stage: RelationStage;
  /** 0 – 100, rounded */
  affinity: number;
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
  next: { stage: RelationStage; ratio: number } | null;
  stats: { days_together: number; turns: number; active_days: number; streak_days: number; memories: number; idle_days: number | null; grace_days: number };
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
    warmth: { value: number; target: number; left: number; ratio: number };
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
}

export const DEFAULT_SCREEN: MateScreen = { enabled: false, approval: "ask", hide_avatar: true, max_edge: 1920 };

/** the mate's screen settings, complete (an older server sends none) */
export const screenOf = (m: Pick<Mate, "screen"> | null | undefined): MateScreen => ({ ...DEFAULT_SCREEN, ...(m?.screen ?? {}) });

/** one set in a mate's wardrobe (docs/mate.md "Outfits"): empty (kind "none") until it is filled like any avatar; id
 * "default" is her default set, its name is ours to show */
export interface OutfitCard {
  id: string;
  name: string;
  kind: Avatar["kind"];
  home: string;
  aspect: number[];
  frame?: RigFrame | null;
  clips: number;
  stills: number;
  note: string;
  /** waits for her affinity: nothing of the set comes along until then */
  locked?: { affinity: number };
  /** what wearing it does to how she feels: that emotion keeps climbing while it is on */
  feel?: Partial<Record<StateEmotion, number>>;
}

export const DEFAULT_OUTFIT = "default";

export interface Mate {
  id: string;
  name: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  persona: Persona;
  /** the set she has on */
  avatar: Avatar;
  /** missing on documents from an older server */
  outfits?: { worn: string; items: OutfitCard[] };
  llm: MateLlm;
  voice: MateVoice;
  /** missing on documents from an older server: DEFAULT_PREFS */
  prefs?: MatePrefs;
  /** missing on documents from an older server */
  relation?: RelationSummary;
  state?: MateState;
  life?: MateLifeSummary;
  /** missing on documents from an older server: DEFAULT_SCREEN */
  screen?: MateScreen;
  session_id: string | null;
  /** a mate shipped with the app (chaerin, …), else null */
  builtin?: string | null;
  /** a built-in the user edited (bundle updates keep the fields the user changed) */
  customized?: boolean;
  /** still being made in the Mate Create studio (hidden from the mate list until Create mate) */
  draft?: boolean;
  /** her profile picture, a square (POST /api/mates/{id}/icon); "" or missing: her avatar's face (MateThumb) */
  icon?: string;
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
  revision: number;
  evidence_type: string;
  subject?: string | null;
  subject_type?: "person" | "place" | "project" | "other";
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

export type MemoryPatch = Partial<Pick<Memory, "text" | "kind" | "importance" | "pinned" | "due_at" | "status">> & { expected_revision?: number };
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
  google_key_set?: boolean;
  openai_key_set: boolean;
  elevenlabs_key_set: boolean;
  omnivoice_url: string;
  whisper_url: string;
  http_tts_url: string;
  http_tts_key_set: boolean;
  /** the user's IANA timezone ("" = the server's): the mate's clock, plan dates, relationship days */
  timezone?: string;
  /** the name every mate knows you by (Settings → 계정) */
  user_name?: string;
  /** the user's birthday, "MM-DD" ("" unknown): every mate with a day of her own knows it */
  user_birthday?: string;
  /** the user's own picture, a square (Settings → 계정; the sidebar shows it): its URL, "" none */
  user_icon?: string;
  /** where the user is: her weather, their public holidays (Settings → 언어) */
  location?: UserLocation | null;
  /** an OpenAI / Google key comes from Settings → Providers (a vendor account with an API key), not one of its own */
  openai_key_shared?: boolean;
  google_key_shared?: boolean;
}

export interface UserLocation {
  lat: number;
  lon: number;
  city: string;
  country: string;
  /** found from the connection, or picked */
  source: "ip" | "manual";
  at?: string;
}

export type VoiceSettingsPatch = Partial<{
  timezone: string;
  user_name: string;
  /** "MM-DD", "" clears */
  user_birthday: string;
  location: Omit<UserLocation, "at">;
  google_key: string | null;
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
  media_models?: Record<string, { id: string; name: string }[]>;
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
export const addOutfit = (id: string, name: string) => apiFetch<{ id: string; mate: Mate }>(`/api/mates/${enc(id)}/outfits`, { method: "POST", ...j({ name }) });
export const getOutfit = (id: string, oid: string) => apiFetch<{ id: string; name: string; avatar: Avatar }>(`/api/mates/${enc(id)}/outfits/${enc(oid)}`);
export const wearOutfit = (id: string, oid: string) => apiFetch<Mate>(`/api/mates/${enc(id)}/outfits/${enc(oid)}/wear`, { method: "POST" });
export const patchOutfit = (id: string, oid: string, patch: { name?: string; avatar?: Avatar }) =>
  apiFetch<Mate>(`/api/mates/${enc(id)}/outfits/${enc(oid)}`, { method: "PATCH", ...j(patch) });
export const deleteOutfit = (id: string, oid: string) => apiFetch<Mate>(`/api/mates/${enc(id)}/outfits/${enc(oid)}`, { method: "DELETE" });
/** bring back deleted built-in mates → the whole list */
export const restoreBuiltins = () => apiFetch<Mate[]>("/api/mates/builtin/restore", { method: "POST" });
/** a built-in mate: the bundled avatar back (clip / trigger edits undone) → the mate */
export const resetBuiltinAvatar = (id: string) => apiFetch<Mate>(`/api/mates/${enc(id)}/avatar/reset`, { method: "POST" });
export const deleteMate = (id: string) => apiFetch<{ deleted: boolean }>(`/api/mates/${enc(id)}`, { method: "DELETE" });

export const openConversation = (id: string) =>
  apiFetch<Conversation>(`/api/mates/${enc(id)}/conversation`, { method: "POST" });
/** all her memories and the whole conversation go, for good; `confirm`: her name */
export const wipeMateMemory = (id: string, confirm: string) => apiFetch<Mate>(`/api/mates/${enc(id)}/memory/wipe`, { method: "POST", ...j({ confirm }) });
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
export const getLife = (id: string) => apiFetch<LifeView>(`/api/mates/${enc(id)}/life`);
export const setLifePlan = (id: string, slot: string, activity: string | null) =>
  apiFetch<LifeView>(`/api/mates/${enc(id)}/life/plan/${enc(slot)}`, { method: "PUT", body: JSON.stringify({ activity }) });
export const sendLifeGift = (id: string, item: string) =>
  apiFetch<LifeView>(`/api/mates/${enc(id)}/life/gift`, { method: "POST", body: JSON.stringify({ item }) });
export const getMateState = (id: string) => apiFetch<StateView>(`/api/mates/${enc(id)}/state`);
/** she was tapped: a bit of attention, until it is too much of it */
export const pokeMate = (id: string) => apiFetch<MateState>(`/api/mates/${enc(id)}/state/poke`, { method: "POST" });
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
export const DEFAULT_MATE_MODELS: Record<MateEngine, string> = {
  claude: DEFAULT_MATE_MODEL,
  codex: "gpt-6.1-sol",
  // API keys (backend harness.vendors.MATE_MODELS): the vendor's mid model, when it is switched on
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-6.1-terra",
  google: "gemini-3.8-flash",
};
/** the reasoning levels a mate can store (backend store.EFFORTS) */
export const MATE_EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];

/** an asset path of a mate → its URL */
export const assetUrl = (id: string, path: string) =>
  `/api/mates/${enc(id)}/assets/${path.split("/").map(enc).join("/")}`;

/** a folder of several ailism characters imports them all (`mates`; `mate` = the first) */
export const importLocal = (body: { path: string; mate_id?: string; name?: string; outfit?: string }) =>
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

/** her profile picture (a square the crop dialog made) → the mate */
export function uploadMateIcon(id: string, picture: Blob) {
  const f = new FormData();
  f.append("file", picture, picture.type === "image/png" ? "icon.png" : "icon.webp");
  return upload<Mate>(`/api/mates/${enc(id)}/icon`, f);
}
/** back to her avatar's face → the mate */
export const clearMateIcon = (id: string) => apiFetch<Mate>(`/api/mates/${enc(id)}/icon`, { method: "DELETE" });
/** the user's own picture → the settings */
export function uploadUserIcon(picture: Blob) {
  const f = new FormData();
  f.append("file", picture, picture.type === "image/png" ? "icon.png" : "icon.webp");
  return upload<VoiceSettings>("/api/mates/settings/user-icon", f);
}
export const clearUserIcon = () => apiFetch<VoiceSettings>("/api/mates/settings/user-icon", { method: "DELETE" });

export function importAvatarZip(id: string, file: File, outfit?: string) {
  const f = new FormData();
  f.append("file", file, file.name);
  if (outfit) f.append("outfit", outfit);
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

export interface GenyTriggerPreset {
  enabled:boolean;
  timing:{base_idle_seconds:number;max_idle_seconds:number;tick_interval_seconds:number;sub_worker_working_cooldown_seconds:number;adaptive_scale_triggers:number};
  categories:{id:string;label:string;weight:number;cooldown_seconds:number;requires_screen_active:boolean;prompt_refs:{prompt_id:string;weight:number}[];[k:string]:unknown}[];
  prompts:{id:string;label:string;content:Record<string,string>;[k:string]:unknown}[];
  [k:string]:unknown;
}

export interface HistoryHit {
  source_id: string; revision: number; session_id: string; title: string;
  role: string; observed_at: string; excerpt: string; offset: number; evidence_type: string; episodes: string[];
}
export interface HistorySearch { items: HistoryHit[]; next_offset: number | null; method: string; indexing_pending: number }
export interface MemoryEvidence {
  source_id: string; source_revision: number; quote: string; start: number; title: string; observed_at: string;
}
export interface MemoryHistory {
  evidence_type: string; evidence: MemoryEvidence[];
  versions: { revision: number; actor: string; recorded_at: string; snapshot: Memory; evidence: MemoryEvidence[] }[];
}
export interface EvidenceView {
  source_id: string; title: string; session_id: string; revision: number; next_offset: number | null;
  messages: { source_id: string; revision: number; role: string; text: string; observed_at: string; truncated: boolean }[];
}
export interface KnowledgeStatus { recent_runs?: {state:string; started_at:string; finished_at:string|null; sources:number; facts:number; episodes:number}[]; unindexed: number; jobs: Record<string, number>; fts: boolean; episodes: number; evidence: number; cost: number }
export interface TaskRecord {
  id: string; title: string; state: string; worker_sid: string; created_at: string; instruction: string;
  verification: string; outcome: string | null;
  receipts: { id: number; type: string; created_at: string }[];
  result: { text: string; error?: string | null } | null;
}
export const searchHistory = (id: string, q: string, scope = "mate", offset = 0) =>
  apiFetch<HistorySearch>(`/api/mates/${enc(id)}/knowledge/search?${new URLSearchParams({ q, scope, offset: String(offset) })}`);
export const readEvidence = (id: string, source: string, revision?: number, offset = 0) =>
  apiFetch<EvidenceView>(`/api/mates/${enc(id)}/knowledge/evidence/${enc(source)}?offset=${offset}${revision === undefined ? "" : `&revision=${revision}`}`);
export const forgetEvidence = (id: string, source: string) =>
  apiFetch(`/api/mates/${enc(id)}/knowledge/evidence/${enc(source)}`, { method: "DELETE" });
export const memoryHistory = (id: string, memory: string) =>
  apiFetch<MemoryHistory>(`/api/mates/${enc(id)}/memories/${enc(memory)}/history`);
export const restoreMemoryVersion = (id: string, memory: string, revision: number, expected_revision: number) =>
  apiFetch<Memory>(`/api/mates/${enc(id)}/memories/${enc(memory)}/restore-version`, { method: "POST", ...j({ revision, expected_revision }) });
export const knowledgeStatus = (id: string) => apiFetch<KnowledgeStatus>(`/api/mates/${enc(id)}/knowledge/status`);
export const retryMemory = (id: string) => apiFetch<{queued:number}>(`/api/mates/${enc(id)}/knowledge/retry`, {method:"POST"});
export const listTaskRecords = (id: string) => apiFetch<TaskRecord[]>(`/api/mates/${enc(id)}/knowledge/tasks`);
export const processMemorySource = (id: string, source_id: string) =>
  apiFetch(`/api/mates/${enc(id)}/knowledge/process-source`, { method: "POST", ...j({ source_id }) });

export interface MemoryEpisode {
  id: string; title: string; quote: string; entities: string[]; source_id: string; source_revision: number;
  created_at: string; occurred_at: string | null; observed_at: string; source_title: string;
}
export const listMemoryEpisodes = (id: string, before?: string, q?: string) => {
  const search = new URLSearchParams();
  if (before) search.set("before", before);
  if (q) search.set("q", q);
  return apiFetch<{items: MemoryEpisode[]; next_cursor: string | null}>(`/api/mates/${enc(id)}/knowledge/episodes?${search}`);
};
