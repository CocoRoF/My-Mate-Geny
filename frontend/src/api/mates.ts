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
  voice?: { auto_read?: boolean; tts?: Partial<MateVoice["tts"]>; stt?: Partial<MateVoice["stt"]> };
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
  language?: string;
  preview_url?: string;
  emotions?: unknown;
  [k: string]: unknown;
}

const j = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const listMates = () => apiFetch<Mate[]>("/api/mates");
export const getMate = (id: string) => apiFetch<Mate>(`/api/mates/${enc(id)}`);
export const createMate = (body: MatePatch & { name: string }) => apiFetch<Mate>("/api/mates", { method: "POST", ...j(body) });
export const updateMate = (id: string, patch: MatePatch) =>
  apiFetch<Mate>(`/api/mates/${enc(id)}`, { method: "PATCH", ...j(patch) });
/** bring back deleted built-in mates → the whole list */
export const restoreBuiltins = () => apiFetch<Mate[]>("/api/mates/builtin/restore", { method: "POST" });
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
export const putVoiceSettings = (patch: VoiceSettingsPatch) =>
  apiFetch<VoiceSettings>("/api/mates/settings", { method: "PUT", ...j(patch) });
export const listVoices = (engine: string) =>
  apiFetch<{ engine: string; voices: VoiceOption[] }>(`/api/mates/voices?engine=${enc(engine)}`);

export const coreStatus = () => apiFetch<{ installed: boolean; size?: number; source?: string }>("/api/mates/live2d/core");
export const installCore = () =>
  apiFetch<{ installed: boolean; size?: number; source?: string }>("/api/mates/live2d/core/install", {
    method: "POST",
    ...j({ accept_license: true }),
  });

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

/** TTS for one sentence: a Blob, or null when the page speaks itself (204: browser / off). */
export async function speech(id: string, text: string, emotion: string | null, signal?: AbortSignal): Promise<Blob | null> {
  const res = await apiResponse(`/api/mates/${enc(id)}/speech`, {
    method: "POST",
    signal,
    ...j({ text, emotion: emotion || "" }),
  });
  if (res.status === 204) return null;
  return res.blob();
}
