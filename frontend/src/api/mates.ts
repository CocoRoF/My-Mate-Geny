/** /api/mates (docs/mate.md §1–5). */
import { apiFetch, apiResponse, toLogin } from "./client";
import type { Avatar } from "../mate/types";
import type { Session } from "../types";

export interface Persona {
  description: string;
  personality: string;
  speech: string;
  greeting: string;
  address: string;
  language: string;
  instructions: string;
}

export type TtsEngine = "off" | "browser" | "openai" | "elevenlabs" | "omnivoice" | "http";
export type SttEngine = "off" | "browser" | "openai" | "whisper";

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
  stt: { engine: SttEngine; model: string; language: string };
}

export interface MateLlm {
  provider: "claude";
  model: string; // "" = catalog default
  effort: string; // default|low|medium|high|xhigh|max
}

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
  session_id: string | null;
  /** a mate shipped with the app (estelle | chaerin | seoa), else null */
  builtin?: string | null;
  /** a built-in the user edited (bundle updates leave it alone) */
  customized?: boolean;
}

export interface MatePatch {
  name?: string;
  is_default?: boolean;
  persona?: Partial<Persona>;
  avatar?: Avatar;
  llm?: Partial<MateLlm>;
  voice?: { auto_read?: boolean; volume?: number; tts?: Partial<MateVoice["tts"]>; stt?: Partial<MateVoice["stt"]> };
}

export interface Conversation {
  mate: Mate;
  session_id: string;
  session: Session;
  running: boolean;
}

export interface Memory {
  id: string;
  text: string;
  created_at: string;
}

export interface VoiceSettings {
  openai_key_set: boolean;
  elevenlabs_key_set: boolean;
  omnivoice_url: string;
  whisper_url: string;
  http_tts_url: string;
  http_tts_key_set: boolean;
}

export type VoiceSettingsPatch = Partial<{
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

export const listMemories = (id: string) => apiFetch<Memory[]>(`/api/mates/${enc(id)}/memories`);
export const addMemory = (id: string, text: string) =>
  apiFetch<Memory>(`/api/mates/${enc(id)}/memories`, { method: "POST", ...j({ text }) });
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
    return fail(`Couldn't reach the server: ${(e as Error).message}`);
  }
  if (res.status === 401) {
    toLogin();
    return fail("authentication required");
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
      return fail(`The connection dropped during the install: ${(e as Error).message}`);
    }
  }
  const end = last as CoreEvent | null;
  if (end && (end.phase === "done" || end.phase === "error")) return end;
  return fail("The install stopped before it finished — try again.");
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
    throw new Error("authentication required");
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

export function transcribe(id: string, audio: Blob) {
  const f = new FormData();
  const ext = audio.type.includes("ogg") ? "ogg" : audio.type.includes("mp4") ? "m4a" : "webm";
  f.append("file", audio, `speech.${ext}`);
  return upload<{ text: string; language?: string }>(`/api/mates/${enc(id)}/transcribe`, f);
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
        `${res.headers.get("X-Speech-Fallback-Reason") || "This voice engine isn't set up"} (the browser voice speaks instead)`,
      );
    }
    return null;
  }
  return res.blob();
}
