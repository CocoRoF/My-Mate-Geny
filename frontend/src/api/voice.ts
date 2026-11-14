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
  /** the models used when none is named; the profile the studio starts from (Voice Studio → 설정) */
  defaults: { tts: string; stt: string; voice?: string };
  settings: { models_dir: string; runtimes_dir: string; vram_budget: number; idle_unload_seconds: number; device: string; engine_mode: string };
}

export type Feeling = "neutral" | "joy" | "sadness" | "anger" | "surprise" | "fear" | "disgust" | "smile";
export const FEELINGS: Feeling[] = ["neutral", "joy", "sadness", "anger", "surprise", "fear", "disgust", "smile"];

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
  description?: string;
  default_model?: string;
  default_params?: Record<string, unknown>;
  tags?: string[];
  starred?: boolean;
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
export type VoicePatch = Partial<Pick<LocalVoice, "name" | "language" | "instruct" | "description" | "default_model" | "default_params" | "tags" | "starred">>;
export const updateLocalVoice = (id: string, patch: VoicePatch) =>
  apiFetch<LocalVoice>(`/api/voice/voices/${enc(id)}`, { method: "PATCH", ...j(patch) });
export const duplicateLocalVoice = (id: string, name = "") =>
  apiFetch<LocalVoice>(`/api/voice/voices/${enc(id)}/duplicate`, { method: "POST", ...j({ name }) });
export const deleteLocalVoice = (id: string) => apiFetch<{ deleted: boolean }>(`/api/voice/voices/${enc(id)}`, { method: "DELETE" });

export function addVoiceReference(
  id: string,
  file: Blob,
  label: Feeling,
  transcript: string,
  filename = "clip.wav",
  opts: { start?: number | null; end?: number | null; language?: string } = {},
) {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("label", label);
  form.append("transcript", transcript);
  if (opts.language) form.append("language", opts.language);
  if (opts.start != null) form.append("start", String(opts.start));
  if (opts.end != null) form.append("end", String(opts.end));
  return apiFetch<VoiceRef>(`/api/voice/voices/${enc(id)}/references`, { method: "POST", body: form, headers: {} });
}
export const trimVoiceReference = (rid: string, start: number, end: number) =>
  apiFetch<VoiceRef>(`/api/voice/references/${enc(rid)}/trim`, { method: "POST", ...j({ start, end }) });
export const updateVoiceReference = (rid: string, patch: { label?: Feeling; transcript?: string; language?: string }) =>
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

// ---- Voice Studio (Settings → 로컬 모델 호스팅 → Voice Studio) ----------------------------------------------------------

export type Mode = "clone" | "design" | "auto";

export interface GpuUsageItem {
  pid: number;
  bytes: number;
  name: string;
  model_id?: string;
}

export interface GpuOverview extends Gpu {
  mem_util?: number | null;
  temperature?: number | null;
  power?: number | null;
  power_limit?: number | null;
  clock?: number | null;
  clock_max?: number | null;
  fan?: number | null;
  pstate?: string;
  usage: { ours: GpuUsageItem[]; others: GpuUsageItem[]; unseen: number };
}

export interface GpuSample {
  t: number;
  gpu: number;
  util: number | null;
  used: number;
  temperature: number | null;
  power: number | null;
  ours: number;
}

/** a GPU job: what, on which model, for whom (mate:<name>, call:<name>, studio, compare, seed, batch, settings) */
export interface GpuJob {
  id: number;
  label: string;
  kind?: "speak" | "hear" | "load" | "warm";
  model_id?: string;
  source: string;
  priority: number;
  queued_at: number;
  started_at: number | null;
  ended_at: number | null;
  ok: boolean | null;
  error?: string;
  chars?: number;
  audio_seconds?: number;
  rtf?: number | null;
}

export interface ResidentEx extends Resident {
  name: string;
  kind: string;
  pid?: number;
  parked_at?: number;
  vram_peak?: number;
  host_peak?: number;
}

export interface EngineEvent {
  t: number;
  model_id: string;
  what: string;
  why?: string;
  seconds?: number;
  error?: string;
}

export type RuntimeKey = "vram_budget_fraction" | "idle_unload_seconds" | "parked_ttl_seconds" | "park_ram_gb" | "history_max_entries" | "history_max_gb";

export interface Overview {
  gate: Gate;
  running: boolean;
  gpus: GpuOverview[];
  series: GpuSample[];
  residents: ResidentEx[];
  queue: { running: GpuJob | null; waiting: GpuJob[]; recent: GpuJob[] };
  events: EngineEvent[];
  host: {
    memory: { total: number; used: number; available: number; limited: boolean };
    cpu: { name: string; count: number };
    disk: { models: { path: string; total: number; free: number }; history: { path: string; total: number; free: number } };
  };
  history: HistoryUsage;
  batches: { running: string[] };
  settings: Record<RuntimeKey, number>;
}

export interface StudioSettings {
  values: Record<RuntimeKey, number>;
  defaults: Record<RuntimeKey, number>;
  bounds: Record<RuntimeKey, [number, number]>;
  default_tts: string;
  default_stt: string;
  default_voice: string;
  paths: { home: string; models: string; runtimes: string; references: string; history: string };
  engine_mode: string;
  device: string;
  hf_endpoint: string;
}

export interface HistoryEntry {
  id: string;
  created_at: string;
  source: string;
  model_id: string;
  voice_id: string;
  voice_name: string;
  feeling: string;
  ref_label: string;
  mode: Mode;
  language: string;
  text: string;
  instruct: string;
  params: Record<string, unknown>;
  seed: number | null;
  sample_rate: number;
  seconds: number;
  ready_seconds: number | null;
  generate_seconds: number | null;
  rtf: number | null;
  size: number;
  starred: boolean;
  note: string;
  batch_id: string;
  batch_index: number | null;
  info?: { segments?: number; device?: string; elapsed?: number };
}

export interface HistoryUsage {
  count: number;
  bytes: number;
  starred: number;
  batch_bytes: number;
}

export interface HistoryPage {
  items: HistoryEntry[];
  total: number;
  usage: HistoryUsage;
  limits: { entries: number; bytes: number };
}

export interface GenerateBody {
  model_id?: string;
  voice_id?: string;
  feeling?: Feeling;
  mode?: Mode;
  language?: string;
  instruct?: string;
  params?: Record<string, unknown>;
  seed?: number | null;
  text: string;
  source?: "studio" | "compare" | "seed";
}

export type BatchState = "queued" | "running" | "done" | "done_with_errors" | "cancelled" | "interrupted" | "failed";

export interface Batch {
  id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  label: string;
  state: BatchState;
  total: number;
  done: number;
  failed: number;
  settings: Record<string, unknown>;
  error: string;
  items?: BatchItem[];
}

export interface BatchItem {
  batch_id: string;
  idx: number;
  text: string;
  overrides: Record<string, unknown>;
  state: "queued" | "running" | "done" | "failed" | "skipped";
  history_id: string;
  error: string;
  seconds: number | null;
  rtf: number | null;
  seed: number | null;
}

export interface Analysis {
  probe: { sample_rate: number | null; channels: number | null; format: string; subtype: string; seconds: number | null };
  stats: { duration: number; rms_db: number; peak: number; clipped: number; silence: number; warnings: string[] };
  windows: { start: number; end: number; level_db: number; silence: number; score: number }[];
  transcript: { text: string; language: string; seconds: number; elapsed: number } | null;
}

export type AudioFormat = "wav" | "mp3" | "ogg" | "flac";
export const AUDIO_FORMATS: AudioFormat[] = ["wav", "mp3", "ogg", "flac"];

export const getOverview = (lang: string) => apiFetch<Overview>(`/api/voice/overview?lang=${enc(lang)}`);
export const getStudioSettings = () => apiFetch<StudioSettings>("/api/voice/settings");
export const putStudioSettings = (patch: Partial<Record<RuntimeKey, number | null>> & { default_tts?: string; default_stt?: string; default_voice?: string }) =>
  apiFetch<StudioSettings>("/api/voice/settings", { method: "PUT", ...j(patch) });
export const getModelDefaults = (id: string) => apiFetch<{ params: Record<string, unknown> }>(`/api/voice/models/${enc(id)}/defaults`).then((r) => r.params);
export const putModelDefaults = (id: string, params: Record<string, unknown>) =>
  apiFetch<{ params: Record<string, unknown> }>(`/api/voice/models/${enc(id)}/defaults`, { method: "PUT", ...j({ params }) }).then((r) => r.params);
export const generateVoice = (body: GenerateBody) => apiFetch<HistoryEntry>("/api/voice/generate", { method: "POST", ...j(body) });

export function listHistory(q: { q?: string; voice_id?: string; model_id?: string; source?: string; starred?: boolean; batch_id?: string; limit?: number; offset?: number } = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "" && v !== false) u.set(k, v === true ? "1" : String(v));
  return apiFetch<HistoryPage>(`/api/voice/history?${u}`);
}
export const historyFacets = () =>
  apiFetch<{ models: { value: string; count: number }[]; sources: { value: string; count: number }[]; voices: { value: string; name: string; count: number }[] }>("/api/voice/history/facets");
export const historyAudioUrl = (id: string, format: AudioFormat = "wav", download = false) =>
  `/api/voice/history/${enc(id)}/audio?format=${format}${download ? "&download=1" : ""}`;
export const updateHistory = (id: string, patch: { starred?: boolean; note?: string }) =>
  apiFetch<HistoryEntry>(`/api/voice/history/${enc(id)}`, { method: "PATCH", ...j(patch) });
export const deleteHistory = (ids: string[]) => apiFetch<{ deleted: number }>("/api/voice/history/delete", { method: "POST", ...j({ ids }) });
export const saveAsReference = (id: string, voiceId: string, label: Feeling, transcript = "") =>
  apiFetch<VoiceRef>(`/api/voice/history/${enc(id)}/save-as-reference`, { method: "POST", ...j({ voice_id: voiceId, label, transcript }) });

export function analyzeAudio(file: Blob, opts: { transcribe?: boolean; window?: number; filename?: string } = {}) {
  const form = new FormData();
  form.append("file", file, opts.filename ?? "clip.wav");
  form.append("transcribe", opts.transcribe ? "1" : "0");
  form.append("window", String(opts.window ?? 10));
  return apiFetch<Analysis>("/api/voice/analyze", { method: "POST", body: form, headers: {} });
}

export const listBatches = () => apiFetch<{ batches: Batch[]; running: string[] }>("/api/voice/batches");
export const getBatch = (id: string) => apiFetch<Batch>(`/api/voice/batches/${enc(id)}`);
export const createBatch = (body: { label: string; settings: Record<string, unknown>; content: string; format: "txt" | "csv" | "json" }) =>
  apiFetch<Batch>("/api/voice/batches", { method: "POST", ...j(body) });
export const cancelBatch = (id: string) => apiFetch<{ cancelled: boolean }>(`/api/voice/batches/${enc(id)}/cancel`, { method: "POST" });
export const retryBatch = (id: string, failedOnly = true) =>
  apiFetch<Batch>(`/api/voice/batches/${enc(id)}/retry`, { method: "POST", ...j({ failed_only: failedOnly }) });
export const deleteBatch = (id: string) => apiFetch<{ deleted: boolean }>(`/api/voice/batches/${enc(id)}`, { method: "DELETE" });
export const batchZipUrl = (id: string, format: AudioFormat = "wav") => `/api/voice/batches/${enc(id)}/zip?format=${format}`;
export const loadModelFrom = (id: string, source: string) =>
  apiFetch<{ resident: Resident }>(`/api/voice/models/${enc(id)}/load`, { method: "POST", ...j({ source }) });
