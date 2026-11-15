/**
 * Local image models (backend app/imagehost, docs/local-image.md): this server's GPU, the image engine (ComfyUI,
 * installed from upstream), the models to download (never shipped: each one after its license is accepted), the
 * recipes to try them with, and what they made. Image Studio sets things up; the avatar maker uses them.
 */
import { apiFetch } from "./client";
import type { Gate, Gpu, InstallProgress, ModelParam } from "./voice";

export type ImageUse = "draft" | "edit" | "loop" | "cutout";
export type JobKind = "draft" | "edit" | "loop" | "cutout" | "matte";
export type AvatarStage = "design" | "home" | "stills" | "clips" | "matte";
export const USES: ImageUse[] = ["draft", "edit", "loop", "cutout"];
export const AVATAR_STAGES: AvatarStage[] = ["design", "home", "stills", "clips", "matte"];

export interface ImageFile {
  name: string;
  folder: string;
  size: number;
  url: string;
  repo: string;
  revision: string;
  role: string;
}

export interface ImageModel {
  id: string;
  name: string;
  kind: "image" | "edit" | "video" | "cutout";
  description: string;
  files: ImageFile[];
  download_gb: number;
  vram_gb: number;
  ram_gb: number;
  uses: ImageUse[];
  homepage: string;
  seconds: string;
  defaults: Record<string, unknown>;
  notes: string[];
  license: { name: string; url: string; summary: string[]; attribution: string; commercial: string };
  // (the server's install state)
  installed: boolean;
  weights: boolean;
  engine: boolean;
  missing_bytes: number;
  busy: boolean;
  progress: (Omit<InstallProgress, "state"> & { state: InstallProgress["state"] | "engine" }) | null;
  license_accepted: { license: string; url: string; accepted_at: string } | null;
}

export interface Recipe {
  id: ImageUse;
  use: ImageUse;
  label: string;
  description: string;
  models: string[];
  params: ModelParam[];
  model: string;
  ready: boolean;
  values: Record<string, unknown>;
}

export interface AvatarEngines {
  available: boolean;
  gate?: string;
  stages: Partial<Record<AvatarStage, { use: ImageUse; ready: boolean; model: string; model_name: string; seconds: string; default: "local" | "higgsfield" }>>;
}

export interface LiveJob {
  kind: JobKind;
  model_id: string;
  source: string;
  step: string;
  value: number;
  max: number;
  node?: string;
  started: number;
}

export interface ImageStatus {
  gate: Gate;
  running: boolean;
  engine: { engine: string; running: boolean; busy: boolean; pid: number | null; reserve_gb?: number; port?: number | null; started_at?: number; last_used?: number; log?: string[]; installed: boolean; version: string; vram: number | null };
  system: { platform: string; container: boolean; gpus: Gpu[]; memory: { total: number; available: number }; disk: { models: { free: number; total: number } } };
  models: ImageModel[];
  recipes: Recipe[];
  defaults: Record<ImageUse, string>;
  queue: { running: ({ id: string } & LiveJob) | null; waiting: number };
  avatar: AvatarEngines;
}

export interface ImageJob {
  id: string;
  kind: JobKind;
  recipe: string;
  model_id: string;
  source: string;
  state: "queued" | "running" | "done" | "failed" | "canceled";
  inputs: { prompt?: string; negative?: string; image?: string; end_image?: string; clip?: string; refs?: string[]; box?: number[] };
  params: Record<string, unknown> & { result?: Record<string, unknown> };
  outputs: { name: string; kind: "image" | "video" | "file"; bytes: number }[];
  error: string;
  seconds: number;
  starred: boolean;
  created_at: string;
  started_at: string;
  ended_at: string;
  live?: LiveJob;
}

export type RuntimeKey = "idle_stop_seconds" | "history_max_entries" | "voice_room_gb";
export interface ImageSettings {
  values: Record<RuntimeKey, number>;
  defaults: Record<RuntimeKey, number>;
  bounds: Record<RuntimeKey, [number, number]>;
  models: Record<ImageUse, string>;
  recipes: Record<ImageUse, Record<string, unknown>>;
  avatar: Partial<Record<AvatarStage, "local" | "higgsfield">>;
  paths: { home: string; models: string; engine: string; history: string };
  engine_mode: string;
  device: string;
}

const j = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const getImageStatus = (lang: string) => apiFetch<ImageStatus>(`/api/image/status?lang=${enc(lang)}`);
export const installImageModel = (id: string, acceptLicense: boolean) =>
  apiFetch<{ progress: InstallProgress }>(`/api/image/models/${enc(id)}/install`, { method: "POST", ...j({ accept_license: acceptLicense }) });
export const cancelImageInstall = (id: string) => apiFetch<{ cancelled: boolean }>(`/api/image/models/${enc(id)}/cancel`, { method: "POST" });
export const removeImageModel = (id: string) => apiFetch<{ freed: number }>(`/api/image/models/${enc(id)}`, { method: "DELETE" });
export const stopImageEngine = () => apiFetch<{ stopped: boolean }>("/api/image/engine/stop", { method: "POST" });
export const getImageSettings = () => apiFetch<ImageSettings>("/api/image/settings");
export const putImageSettings = (
  patch: Partial<Record<RuntimeKey, number | null>> & {
    models?: Partial<Record<ImageUse, string>>;
    recipes?: Partial<Record<ImageUse, Record<string, unknown> | null>>;
    avatar?: Partial<Record<AvatarStage, "local" | "higgsfield">>;
  },
) => apiFetch<ImageSettings>("/api/image/settings", { method: "PUT", ...j(patch) });

/** a picture or a clip: a file the user picked, or a result already in the history ("<job id>/<file>") */
export type MediaInput = File | { from: string };

export function submitImageJob(body: {
  kind: JobKind;
  prompt?: string;
  negative?: string;
  params?: Record<string, unknown>;
  model_id?: string;
  image?: MediaInput | null;
  end_image?: MediaInput | null;
  clip?: MediaInput | null;
  refs?: MediaInput[];
}) {
  const form = new FormData();
  form.append("kind", body.kind);
  if (body.prompt) form.append("prompt", body.prompt);
  if (body.negative) form.append("negative", body.negative);
  if (body.params) form.append("params", JSON.stringify(body.params));
  if (body.model_id) form.append("model_id", body.model_id);
  for (const key of ["image", "end_image", "clip"] as const) {
    const v = body[key];
    if (!v) continue;
    if (v instanceof File) form.append(key, v, v.name);
    else form.append(`${key}_from`, v.from);
  }
  for (const r of body.refs ?? []) {
    if (r instanceof File) form.append("refs", r, r.name);
    else form.append("refs_from", r.from);
  }
  return apiFetch<ImageJob>("/api/image/jobs", { method: "POST", body: form, headers: {} });
}

export function listImageJobs(q: { kind?: JobKind | ""; source?: string; starred?: boolean; limit?: number; offset?: number } = {}) {
  const p = new URLSearchParams();
  if (q.kind) p.set("kind", q.kind);
  if (q.source) p.set("source", q.source);
  if (q.starred) p.set("starred", "1");
  if (q.limit) p.set("limit", String(q.limit));
  if (q.offset) p.set("offset", String(q.offset));
  return apiFetch<{ items: ImageJob[]; total: number }>(`/api/image/jobs?${p}`);
}
export const getImageJob = (id: string) => apiFetch<ImageJob>(`/api/image/jobs/${enc(id)}`);
export const cancelImageJob = (id: string) => apiFetch<{ cancelled: boolean }>(`/api/image/jobs/${enc(id)}/cancel`, { method: "POST" });
export const starImageJob = (id: string, starred: boolean) => apiFetch<ImageJob>(`/api/image/jobs/${enc(id)}`, { method: "PATCH", ...j({ starred }) });
export const deleteImageJobs = (ids: string[]) => apiFetch<{ deleted: string[] }>("/api/image/jobs/delete", { method: "POST", ...j({ ids }) });
export const imageJobFileUrl = (id: string, name: string, download = false) =>
  `/api/image/jobs/${enc(id)}/files/${enc(name)}${download ? "?download=1" : ""}`;

/** the server says something changed (a job's progress, a model's install, the settings): `hrh:image-changed` */
export const IMAGE_CHANGED = "hrh:image-changed";
