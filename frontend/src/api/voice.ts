/**
 * Local voice models (backend app/voicehost, docs/local-voice.md): this server's GPU, the models to download and serve
 * (never shipped: each one after its license is accepted), the voices they speak with, and a line to try them.
 */
import { apiFetch, apiResponse } from "./client";

export type GateCode =
  | "ok" | "fake" | "off" | "platform" | "python" | "packages" | "no_gpu" | "gpu_not_passed" | "old_driver" | "old_gpu"
  | "small_gpu";

export interface Gpu {
  index: number;
  name: string;
  total: number;
  used: number;
  free: number;
  util: number;
  driver: string;
  capability: string;
}

export interface Gate {
  ok: boolean;
  code: GateCode;
  message: string;
  gpu: Gpu | null;
  detail: Record<string, unknown>;
  requirements: { driver: number; capability: string; vram: number; platforms: string[]; python: string };
}

export interface ModelParam {
  name: string;
  label: string;
  type: "float" | "int" | "bool" | "choice";
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  choices?: string[];
  help?: string;
  advanced: boolean;
}

export interface InstallProgress {
  state: "idle" | "queued" | "runtime" | "source" | "weights" | "done" | "error" | "cancelled";
  message: string;
  done_bytes: number;
  total_bytes: number;
  fraction: number | null;
  started_at: number;
  error: string;
  log: string[];
}

export interface Resident {
  model_id: string;
  state: "starting" | "loading" | "ready" | "parked" | "stopping";
  busy: boolean;
  pinned?: boolean;
  last_used: number;
  loaded_at: number;
  vram_estimate: number;
  vram_reserved: number;
  vram_used?: number;
  host_rss: number;
  load_seconds?: number | null;
  device?: { name?: string; dtype?: string };
}

export interface VoiceModel {
  id: string;
  name: string;
  kind: "tts" | "stt";
  engine: string;
  description: string;
  download_gb: number;
  vram_gb: number;
  host_gb: number;
  languages: string[];
  features: string[];
  params: ModelParam[];
  homepage: string;
  sample_rate: number;
  notes: string[];
  license: { name: string; url: string; summary: string[]; attribution: string; commercial: string };
  repos: { id: string; url: string; revision: string }[];
  // what is on this machine
  installed: boolean;
  weights_ready: boolean;
  runtime: string | null;
  runtime_ready: boolean;
  disk_bytes: number;
  revisions: Record<string, string>;
  installed_at: number | null;
  license_accepted: { license: string; url: string; accepted_at: string } | null;
  progress: InstallProgress | null;
  resident: Resident | null;
  need_bytes: number;
}

export interface VoiceStatus {
  gate: Gate;
  running: boolean;
  system: {
    platform: string;
    container: boolean;
    gpus: Gpu[];
    memory: { total: number; used: number; available: number; limited: boolean };
    cpu: { name: string; count: number };
    disk: { models: { path: string; total: number; free: number }; runtimes: { path: string; total: number; free: number } };
  };
  models: VoiceModel[];
  runtimes: { name: string; ready: boolean; engines: string[] }[];
  events: { t: number; model_id: string; what: string; why?: string; seconds?: number; error?: string }[];
  queue: { running: string; waiting: number };
  defaults: { tts: string; stt: string };
  settings: { models_dir: string; runtimes_dir: string; vram_budget: number; idle_unload_seconds: number; device: string; engine_mode: string };
}

export type Feeling = "neutral" | "joy" | "sadness" | "anger" | "surprise";
export const FEELINGS: Feeling[] = ["neutral", "joy", "sadness", "anger", "surprise"];

export interface VoiceRef {
  id: string;
  label: Feeling;
  transcript: string;
  language: string;
  duration: number;
  stats: { warnings?: string[]; rms_db?: number; peak?: number } | null;
}

export interface LocalVoice {
  id: string;
  name: string;
  language: string;
  instruct: string;
  builtin: boolean;
  source?: string;
  rights?: string;
  references: VoiceRef[];
}

const j = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const getVoiceStatus = (lang: string) => apiFetch<VoiceStatus>(`/api/voice/status?lang=${enc(lang)}`);
export const installModel = (id: string, acceptLicense: boolean) =>
  apiFetch<{ progress: InstallProgress }>(`/api/voice/models/${enc(id)}/install`, { method: "POST", ...j({ accept_license: acceptLicense }) });
export const cancelInstall = (id: string) => apiFetch<{ cancelled: boolean }>(`/api/voice/models/${enc(id)}/cancel`, { method: "POST" });
export const removeModel = (id: string) =>
  apiFetch<{ freed_bytes: number; removed_runtime: string | null }>(`/api/voice/models/${enc(id)}`, { method: "DELETE" });
export const loadModel = (id: string) => apiFetch<{ resident: Resident }>(`/api/voice/models/${enc(id)}/load`, { method: "POST" });
export const unloadModel = (id: string, park = false) =>
  apiFetch<{ unloaded: boolean }>(`/api/voice/models/${enc(id)}/unload`, { method: "POST", ...j({ park }) });

export const listLocalVoices = () => apiFetch<{ voices: LocalVoice[] }>("/api/voice/voices").then((r) => r.voices);
export const createLocalVoice = (name: string, language: string) =>
  apiFetch<LocalVoice>("/api/voice/voices", { method: "POST", ...j({ name, language }) });
export const updateLocalVoice = (id: string, patch: { name?: string; language?: string; instruct?: string }) =>
  apiFetch<LocalVoice>(`/api/voice/voices/${enc(id)}`, { method: "PATCH", ...j(patch) });
export const deleteLocalVoice = (id: string) => apiFetch<{ deleted: boolean }>(`/api/voice/voices/${enc(id)}`, { method: "DELETE" });

export function addVoiceReference(id: string, file: Blob, label: Feeling, transcript: string, filename = "clip.wav") {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("label", label);
  form.append("transcript", transcript);
  return apiFetch<VoiceRef>(`/api/voice/voices/${enc(id)}/references`, { method: "POST", body: form, headers: {} });
}
export const updateVoiceReference = (rid: string, patch: { label?: Feeling; transcript?: string }) =>
  apiFetch<VoiceRef>(`/api/voice/references/${enc(rid)}`, { method: "PATCH", ...j(patch) });
export const deleteVoiceReference = (rid: string) => apiFetch<{ deleted: boolean }>(`/api/voice/references/${enc(rid)}`, { method: "DELETE" });
export const referenceAudioUrl = (vid: string, rid: string) => `/api/voice/voices/${enc(vid)}/references/${enc(rid)}/audio`;

export interface PreviewInfo {
  [k: string]: string;
}

/** a line in a voice, as a WAV, and what it took (ready / generate seconds, real-time factor) */
export async function previewVoice(body: {
  model_id: string;
  voice_id?: string;
  text: string;
  emotion?: Feeling;
  language?: string;
  instruct?: string;
  params?: Record<string, unknown>;
}): Promise<{ blob: Blob; info: PreviewInfo }> {
  const res = await apiResponse("/api/voice/preview", { method: "POST", ...j(body) });
  const info: PreviewInfo = {};
  for (const part of (res.headers.get("X-Voice-Info") || "").split(";")) {
    const [k, ...v] = part.split("=");
    if (k) info[k] = v.join("=");
  }
  return { blob: await res.blob(), info };
}

export function transcribeLocal(file: Blob, language = "auto", filename = "clip.wav") {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("language", language);
  return apiFetch<{ text: string; language: string; model_id: string; seconds: number; elapsed: number }>("/api/voice/transcribe", {
    method: "POST",
    body: form,
    headers: {},
  });
}
