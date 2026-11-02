/** /api/avatar — Avatar Create (docs/avatar-create.md). */
import { apiFetch, apiResponse, toLogin } from "./client";
import { tr } from "../i18n";
import type { Avatar } from "../mate/types";
import type { Mate } from "./mates";

export type ProjectStatus = "interview" | "estimate" | "running" | "waiting" | "paused" | "ready" | "applied" | "canceled" | "failed";

export interface QuestionOption {
  value: string;
  label: string;
  description?: string | null;
  /** concepts: the direction's colours (#RRGGBB) */
  palette?: string[];
}

export interface Question {
  id: string;
  kind: "choice" | "multi" | "slider" | "upload" | "text" | "mate" | "concepts";
  question: string;
  options: QuestionOption[];
  allow_other: boolean;
  min?: number;
  max?: number;
  step?: number;
  default?: number;
  unit?: string;
}

export interface PlanLine {
  key: string;
  stage: "design" | "home" | "stills" | "clips" | "matte";
  job_type: string;
  params: Record<string, unknown>;
  count: number;
  unit: number | null;
  credits: number | null;
  error?: string;
}

export interface Plan {
  id: string;
  quoted_at: string;
  lines: PlanLine[];
  total: number;
  reserve: number;
  cap: number;
  minutes: number;
  complete: boolean;
  errors: string[];
  balance: number | null;
  balance_after: number | null;
  credit_usd: number | null;
  usd: number | null;
  counts: { candidates: number; stills: number; clips: number };
  settings: { aspect: string; tier: string; preset: string; mode: string; seconds: number };
}

export interface Extra {
  id: string;
  reason: string;
  total: number;
  status: "pending" | "confirmed" | "declined";
}

export interface ClipCheck {
  seam?: number;
  start?: number;
  drift?: number;
  soft?: number;
  ok?: boolean;
  missing?: boolean;
}

export interface ProjectFiles {
  refs: { name: string; url: string }[];
  candidates: { id: string; url: string; full: string }[];
  stills: { name: string; status: string; url: string | null; error?: string | null }[];
  clips: {
    id: string;
    kind: string;
    emotion?: string | null;
    action: string;
    status: string;
    matte?: string | null;
    processed: boolean;
    error?: string | null;
    raw: string | null;
    web: string | null;
    check?: ClipCheck | null;
  }[];
  home: string | null;
  face: string | null;
}

export interface BriefClip {
  id: string;
  kind: string;
  action: string;
  emotion?: string;
  loop?: boolean;
}

export interface Brief {
  reference: { mode: "none" | "redraw" | "as_base"; files: string[] };
  design: { prompt: string; notes: string };
  pronoun: string;
  candidates: number;
  aspect: "1:1" | "9:16";
  tier: "studio" | "light";
  preset: "minimal" | "standard" | "rich" | "custom";
  clips: BriefClip[];
  stills: { name: string; face: string }[];
  target: { mode: "new" | "existing"; mate_id: string | null; name: string };
}

export interface Item {
  key: string;
  stage: string;
  status: "pending" | "running" | "done" | "failed";
  tries: number;
  credits: number;
  error?: string | null;
}

export interface AvatarProject {
  id: string;
  title: string;
  status: ProjectStatus;
  phase: string | null;
  language: string;
  session_id: string;
  brief: Brief;
  question: Question | null;
  plan: Plan | null;
  confirmation: { plan_id: string; total: number; cap: number; at: string } | null;
  extras: Extra[];
  items: Record<string, Item>;
  checkpoint: { stage: "pick" | "home" | "stills" | "cap"; at: string; reason?: string } | null;
  paused: boolean;
  picked: string | null;
  check: { clips: Record<string, ClipCheck>; passed: boolean; redo: string[] } | null;
  result: { stills: number; clips: number; aspect: number[] } | null;
  applied: { mate_id: string; name: string; at: string; backup: unknown; new: boolean; restored_at?: string } | null;
  error: string | null;
  processing: { step: string; args: string[]; at: string } | null;
  ledger: { committed: number; jobs: number };
  credits: { committed: number; cap: number; confirmed: number | null; reserve: number | null };
  files: ProjectFiles;
  preview: Avatar | null;
  agent_running: boolean;
  /** the Mate Create studio's part (docs/avatar-create.md §11): absent on a plain Avatar Create project */
  studio?: StudioInfo;
  log: { at: string; what: string }[];
  updated_at: string;
  version: number;
}

/** the concept notes of a mate being made (shown on the right; the persona and the avatar are made from them) */
export const CONCEPT_KEYS = ["pitch", "role", "interests", "backstory", "voice", "style", "look", "outfit", "palette", "mood"] as const;
export type ConceptKey = (typeof CONCEPT_KEYS)[number];

export interface StudioInfo {
  /** new: a draft mate being made · existing: the studio for an existing mate's avatar */
  kind: "new" | "existing";
  mate_id: string;
  concept: Partial<Record<ConceptKey, string>>;
  /** field path (name, persona.description, prefs.tone.warmth, concept.pitch, …) → the agent wrote it: when, and
   *  what was there before (per-field undo) */
  filled: Record<string, { at: string; prev: unknown }>;
  avatar_skipped: boolean;
  voice_ok: boolean;
  finished_at: string | null;
  /** what Create mate still needs */
  missing: string[];
  mate: Mate | null;
}

export interface DraftSummary {
  mate_id: string;
  name: string;
  project_id: string;
  status: ProjectStatus;
  pitch: string;
  updated_at: string;
  thumb: string | null;
}

export interface StudioFieldsPatch {
  name?: string;
  persona?: Partial<Mate["persona"]>;
  prefs?: Record<string, unknown>;
  voice?: Mate["voice"];
  llm?: Partial<Mate["llm"]>;
  concept?: Partial<Record<ConceptKey, string>>;
}

export interface ProjectSummary {
  id: string;
  title: string;
  status: ProjectStatus;
  phase: string | null;
  mate_id: string | null;
  updated_at: string;
  created_at: string;
  thumb: string | null;
}

export interface AvatarEnv {
  higgsfield: { connected: boolean; cli: boolean; account: { credits: number | null; plan: string | null; email: string | null; status: string } | null };
  deps: { ready: boolean; installing: boolean; phase: string | null; error: string | null; log: string[] };
}

const P = (pid: string) => `/api/avatar/projects/${pid}`;
const post = <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const avatarEnv = () => apiFetch<AvatarEnv>("/api/avatar/env");
export const listProjects = () => apiFetch<ProjectSummary[]>("/api/avatar/projects");
export const createProject = (body: { mate_id?: string | null; language: string }) =>
  post<AvatarProject>("/api/avatar/projects", body);
export const getProject = (pid: string) => apiFetch<AvatarProject>(P(pid));
export const deleteProject = (pid: string) => apiFetch<{ ok: boolean }>(P(pid), { method: "DELETE" });

export const answered = (pid: string) => post<AvatarProject>(`${P(pid)}/answer`);
export const reEstimate = (pid: string) => post<AvatarProject>(`${P(pid)}/estimate`);
export const confirmPlan = (pid: string, plan: Plan) => post<AvatarProject>(`${P(pid)}/confirm`, { plan_id: plan.id, total: plan.total });
export const changePlan = (pid: string) => post<AvatarProject>(`${P(pid)}/change`);
export const discardPlan = (pid: string) => post<AvatarProject>(`${P(pid)}/discard`);
export const pauseRun = (pid: string) => post<AvatarProject>(`${P(pid)}/pause`);
export const resumeRun = (pid: string) => post<AvatarProject>(`${P(pid)}/resume`);
export const cancelRun = (pid: string) => post<AvatarProject>(`${P(pid)}/cancel`);
export const checkpoint = (pid: string, action: "pick" | "approve" | "back", candidate?: string) =>
  post<AvatarProject>(`${P(pid)}/checkpoint`, { action, candidate });
export const redoItem = (pid: string, item: string, note = "") =>
  post<{ result: { started: boolean; credits: number; needs_confirmation?: string }; project: AvatarProject }>(`${P(pid)}/redo`, { item, note });
export const confirmExtra = (pid: string, x: Extra) => post<AvatarProject>(`${P(pid)}/extras/${x.id}/confirm`, { total: x.total });
export const declineExtra = (pid: string, x: Extra) => post<AvatarProject>(`${P(pid)}/extras/${x.id}/decline`);
export const applyAvatar = (pid: string, body: { mate_id?: string; new?: boolean; new_name?: string }) =>
  post<{ project: AvatarProject; mate: Mate }>(`${P(pid)}/apply`, body);
export const restoreAvatar = (pid: string) => post<{ project: AvatarProject; mate: Mate }>(`${P(pid)}/restore`);

// ── the Mate Create studio ──
const SP = (pid: string) => `/api/avatar/studio/${pid}`;
/** a new draft (no mate_id), a draft's project, or an existing mate's latest project (fresh: a new one) */
export const openStudio = (body: { mate_id?: string | null; language: string; fresh?: boolean }) => post<AvatarProject>("/api/avatar/studio", body);
export const listDrafts = () => apiFetch<DraftSummary[]>("/api/avatar/studio/drafts");
export const patchStudioFields = (pid: string, patch: StudioFieldsPatch) =>
  apiFetch<AvatarProject>(`${SP(pid)}/fields`, { method: "PATCH", body: JSON.stringify(patch) });
export const undoStudioField = (pid: string, field: string) => post<AvatarProject>(`${SP(pid)}/undo`, { field });
export const finishStudio = (pid: string) => post<{ mate: Mate; project: AvatarProject }>(`${SP(pid)}/finish`);
export const skipAvatar = (pid: string, skip: boolean) => post<AvatarProject>(`${SP(pid)}/skip-avatar`, { skip });
export const studioTemplate = (pid: string, mateId: string) => post<AvatarProject>(`${SP(pid)}/template`, { mate_id: mateId });
export const studioVoiceOk = (pid: string) => post<AvatarProject>(`${SP(pid)}/voice-ok`);
export const discardDraft = (pid: string) => apiFetch<{ ok: boolean }>(SP(pid), { method: "DELETE" });

/** the 409 the gate answers with: {code, message} */
export function gateMessage(e: unknown): string {
  const m = (e as Error)?.message;
  return typeof m === "string" ? m : String(e);
}

export async function uploadReference(pid: string, file: File): Promise<AvatarProject> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`${P(pid)}/reference`, { method: "POST", body: form });
  if (res.status === 401) toLogin();
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(typeof err.detail === "string" ? err.detail : err.detail?.message || tr("avatar.uploadFailed"));
  }
  return res.json();
}

/** install the processing tools: NDJSON {phase, line} … then the status */
export async function installDeps(onLine: (o: { phase?: string; line?: string; ready?: boolean; error?: string | null }) => void): Promise<void> {
  const res = await apiResponse("/api/avatar/env/install", { method: "POST" });
  const reader = res.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try {
          onLine(JSON.parse(line));
        } catch {
          /* a partial line */
        }
      }
    }
  }
}
