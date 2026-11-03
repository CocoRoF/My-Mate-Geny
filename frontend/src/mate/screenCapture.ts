/**
 * Screen capture for the Mate (docs/mate.md §4 "Seeing the screen"), the page's part.
 *
 * - Every window tells the server who it is on /ws/sessions (`clientHello`): the device (mate/voiceOwner `deviceId`),
 *   the window, the desktop app's version and its capture bridge (`window.hrhNative.capture`, desktop/src/capture.js).
 * - The mate's `see_screen`: the server sends `capture.request` to one desktop app window (the device the user talks
 *   from); `handleCaptureRequest` hands it to the app (it asks the user, hides the avatar windows, captures), uploads
 *   the picture as a normal attachment of the mate's conversation and answers `POST /api/mates/{id}/capture/{rid}`.
 *   Every path answers — a failure too — so the mate's tool call never waits for nothing.
 * - The user's Share screen (the composer's + menu): the desktop app's own capture (a picker of screens and windows),
 *   or in a browser `getDisplayMedia` (the browser's picker) → one frame; phones have neither (the item is hidden).
 * - While a picture is taken for the mate, every window shows "Screen shared with ‹mate›" for a moment.
 */
import {
  sharedScopes,
  sharingSnapshot,
  finishLocalCapture,
  localFrame,
  cancelLocalCapture,
} from "./localScreen";
import { uploadAttachment } from "../api/attachments";
import { apiFetch } from "../api/client";
import { tr } from "../i18n";
import { isTouchFirst } from "../lib/device";
import { currentSurface } from "./desktop";
import { deviceId } from "./voiceOwner";

export interface CaptureSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  display_id?: string;
  primary?: boolean;
  /** a small data: URL (sources({thumbnails: true})) */
  thumbnail?: string;
}

export type CaptureFailure =
  | "denied"
  | "timeout"
  | "busy"
  | "permission"
  | "empty"
  | "source_gone"
  | "stopped"
  | "error";

export type CaptureShot =
  | {
      ok: true;
      data: Uint8Array;
      mime: string;
      width: number;
      height: number;
      source: CaptureSource | null;
    }
  | { ok: false; code: CaptureFailure; message?: string };

export interface CaptureInfo {
  version: number;
  platform: string;
  /** Linux on Wayland: the system's share dialog asks each time */
  wayland: boolean;
  /** macOS Screen Recording: granted | denied | not-determined | restricted | unknown (other systems: granted) */
  permission: string;
}

/** window.hrhNative.capture (desktop/src/preload.js) */
export interface CaptureBridge {
  version: number;
  sharing?: {
    get(): Promise<{
      revision: number;
      state: import("./localScreen").LocalSharing | null;
      owner: boolean;
    }>;
    publish(
      state: import("./localScreen").LocalSharing | null,
    ): Promise<unknown>;
    stop(): Promise<void>;
    mode(mode: string, interval: number): Promise<void>;
    onChanged(
      cb: (v: {
        revision: number;
        state: import("./localScreen").LocalSharing | null;
        owner: boolean;
      }) => void,
    ): () => void;
    onControl(
      cb: (v: { type: string; mode?: string; interval?: number }) => void,
    ): () => void;
  };
  info(): Promise<CaptureInfo>;
  sources(o?: {
    thumbnails?: boolean;
    size?: number;
  }): Promise<CaptureSource[]>;
  getChoice(mateId: string): Promise<CaptureSource | null>;
  setChoice(mateId: string, src: CaptureSource | null): Promise<boolean>;
  grab(o: {
    id?: string;
    mateId?: string;
    sourceId?: string;
    maxEdge?: number;
    format?: "png" | "jpeg";
    quality?: number;
    hideAvatar?: boolean;
    hideConsole?: boolean;
  }): Promise<CaptureShot>;
  request(req: CaptureRequest): Promise<CaptureShot>;
  cancel(id: string): Promise<void>;
  openPrivacySettings(): Promise<void>;
}

/** what the server sends (app/mate/capture.py) */
export interface CaptureRequest {
  scope?: "session" | "mate";
  proof?: string;
  source_key?: string;
  id: string;
  mate_id: string;
  mate_name: string;
  session_id: string;
  automatic?: boolean;
  ask: boolean;
  hide_avatar: boolean;
  max_edge: number;
  format: "png" | "jpeg";
  quality: number;
  timeout_ms: number;
  reason?: string;
}

export const CAPTURE_VERSION = 1;

/** the desktop app's capture bridge (null: a browser, the Android app, an older desktop app) */
export function captureBridge(): CaptureBridge | null {
  if (typeof window === "undefined") return null;
  const c = window.hrhNative?.capture;
  return c &&
    typeof c.request === "function" &&
    Number(c.version) >= CAPTURE_VERSION
    ? c
    : null;
}

const desktopVersion = (): string | null => {
  const n = typeof window !== "undefined" ? window.hrhNative : undefined;
  return n && String(n.platform || "").startsWith("desktop")
    ? n.version || "0.0.0"
    : null;
};

/** the /ws/sessions `client` message: who this window is (`active`: it was just focused / used) */
export function clientHello(active: boolean): Record<string, unknown> {
  return {
    type: "client",
    device: deviceId,
    surface: currentSurface(),
    desktop: desktopVersion(),
    capture:
      captureBridge()?.version ?? (Object.keys(sharedScopes()).length ? 1 : 0),
    shares: sharedScopes(),
    screen_ready: true,
    active,
  };
}

/** can this page share the screen itself (Share screen in the + menu)? The desktop app, or a desktop browser */
export function canShareScreen(): boolean {
  if (captureBridge()) return true;
  if (typeof window === "undefined" || window.hrhNative) return false; // (an older desktop app, the Android app)
  if (isTouchFirst()) return false; // phones / tablets: no screen to share (mobile browsers have no getDisplayMedia)
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === "function"
  );
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function shotFile(
  shot: { data: Uint8Array; mime: string },
  prefix = "screen",
): File {
  const ext = shot.mime === "image/jpeg" ? "jpg" : "png";
  // (a copy: the IPC buffer may be a view of a larger one)
  return new File([new Uint8Array(shot.data)], `${prefix}-${stamp()}.${ext}`, {
    type: shot.mime,
  });
}

/** what a failed capture means, in words */
export function captureError(code: string | undefined): string {
  switch (code) {
    case "denied":
      return tr("mate.shareDenied");
    case "permission":
      return tr("mate.sharePermission");
    case "empty":
      return tr("mate.shareEmpty");
    case "source_gone":
      return tr("mate.shareSourceGone");
    case "busy":
      return tr("mate.shareBusy");
    default:
      return tr("mate.shareFailed");
  }
}

// ── the mate asks (capture.request from the server) ──────────────────────

const handled = new Set<string>();

const operations = new Map<
  string,
  { req: CaptureRequest; cancelled: boolean; abort?: () => void }
>();
function cancelOperation(id: string) {
  const op = operations.get(id);
  if (!op || op.cancelled) return;
  op.cancelled = true;
  op.abort?.();
  cancelLocalCapture(id);
  void captureBridge()?.cancel(id);
  void apiFetch(
    `/api/sessions/${encodeURIComponent(op.req.session_id)}/screen/cancel`,
    { method: "POST" },
  ).catch(() => {});
}
window.addEventListener("hrh:cancel-captures", () => {
  for (const id of operations.keys()) cancelOperation(id);
});
export async function handleCaptureRequest(raw: unknown): Promise<void> {
  const req = (raw && typeof raw === "object" ? raw : {}) as CaptureRequest;
  if (!req.id || !req.mate_id || handled.has(req.id)) return;
  handled.add(req.id);
  if (handled.size > 256) handled.delete(handled.values().next().value!);
  const op: { req: CaptureRequest; cancelled: boolean; abort?: () => void } = {
    req,
    cancelled: false,
  };
  operations.set(req.id, op);
  let aid: string | undefined,
    committed = false;
  const respond = async (body: Record<string, unknown>) => {
    if (req.scope === "session")
      return apiFetch(
        `/api/sessions/${encodeURIComponent(req.session_id)}/screen/${encodeURIComponent(req.id)}/result`,
        { method: "POST", body: JSON.stringify({ ...body, proof: req.proof }) },
      );
    return apiFetch(
      `/api/mates/${encodeURIComponent(req.mate_id)}/capture/${encodeURIComponent(req.id)}`,
      { method: "POST", body: JSON.stringify(body) },
    );
  };
  try {
    let file: File,
      source: CaptureSource | null = null;
    if (req.scope === "session") {
      const shared = sharingSnapshot();
      file = await localFrame(req.session_id, req.id, req.ask, req);
      if (shared) source = { id: "", name: shared.source, kind: shared.kind };
    } else {
      const bridge = captureBridge();
      if (!bridge) throw new Error(captureError("error"));
      const shot = await bridge.request({...req,hide_avatar:false});
      if (!shot.ok) throw new Error(captureError(shot.code));
      file = shotFile(shot);
      source = shot.source;
    }
    if (op.cancelled) throw new Error(captureError("stopped"));
    const upload = uploadAttachment(
      req.session_id,
      file,
      () => {},
      req.proof ? { id: req.id, proof: req.proof } : undefined,
    );
    op.abort = upload.abort;
    const att = await upload.promise;
    aid = att.id;
    op.abort = undefined;
    if (op.cancelled) throw new Error(captureError("stopped"));
    await respond({ ok: true, attachment_id: aid, source });
    committed = true;
    if (!op.cancelled) toast(tr("screen.captured"));
  } catch (e) {
    try {
      await respond({
        ok: false,
        code: op.cancelled ? "stopped" : "error",
        message: String((e as Error)?.message || e),
      });
    } catch {}
  } finally {
    if (aid && !committed)
      void apiFetch(`/api/attachments/${encodeURIComponent(aid)}`, {
        method: "DELETE",
      }).catch(() => {});
    operations.delete(req.id);
    finishLocalCapture(req.session_id);
  }
}
export function cancelCaptureRequest(raw: unknown): void {
  const id =
    raw && typeof raw === "object"
      ? String((raw as { id?: unknown }).id || "")
      : "";
  if (id) {
    cancelOperation(id);
    cancelLocalCapture(id);
    void captureBridge()?.cancel(id);
  }
}

// ── the user shares (Share screen) ────────────────────────────────────────

/** a browser: one frame of what the user picks in the browser's own dialog */
export async function grabWithBrowser(maxEdge = 1920): Promise<File> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // (the first frames can be blank while the capture starts)
    await new Promise((r) => setTimeout(r, 250));
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const k =
      maxEdge && Math.max(w, h) > maxEdge ? maxEdge / Math.max(w, h) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * k));
    canvas.height = Math.max(1, Math.round(h * k));
    canvas
      .getContext("2d")!
      .drawImage(video, 0, 0, canvas.width, canvas.height);
    video.srcObject = null;
    const blob = await new Promise<Blob | null>((r) =>
      canvas.toBlob(r, "image/png"),
    );
    if (!blob) throw new Error(tr("mate.shareFailed"));
    return new File([blob], `screen-${stamp()}.png`, { type: "image/png" });
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

const SHARE_KEY = "hrh.mate.shareSource";
/** the source the user shared last on this device (the picker preselects it) */
export const lastShared = (): string => {
  try {
    return localStorage.getItem(SHARE_KEY) || "";
  } catch {
    return "";
  }
};
export const rememberShared = (id: string) => {
  try {
    localStorage.setItem(SHARE_KEY, id);
  } catch {
    /* private mode */
  }
};

// ── "Screen shared with ‹mate›" in every window of the desktop app ───────

function toast(text: string) {
  const el = document.createElement("div");
  el.textContent = text;
  el.setAttribute("role", "status");
  el.setAttribute("data-testid", "capture-toast");
  el.style.cssText =
    "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:8px;" +
    "padding:7px 14px;border-radius:999px;background:rgb(var(--c-surface-3) / .96);border:1px solid rgb(var(--c-border-strong));" +
    "color:rgb(var(--c-content));font:12.5px Inter,system-ui,sans-serif;box-shadow:var(--shadow-float);transition:opacity .3s;" +
    "pointer-events:none;white-space:nowrap;max-width:92vw;overflow:hidden;text-overflow:ellipsis";
  const dot = document.createElement("span");
  dot.style.cssText =
    "width:8px;height:8px;border-radius:50%;background:#e5484d;box-shadow:0 0 0 3px #e5484d40;flex:none";
  el.prepend(dot);
  document.body.appendChild(el);
  setTimeout(() => (el.style.opacity = "0"), 3600);
  setTimeout(() => el.remove(), 4000);
}

let indicatorOn = false;
/** once per page: the desktop app's `capture` command → the toast (not in the see-through avatar window) */
export function installCaptureIndicator(): void {
  if (indicatorOn || typeof window === "undefined") return;
  const m = window.hrhNative?.mate;
  if (!m?.onCommand) return;
  indicatorOn = true;
  m.onCommand((cmd) => {
    if (cmd.type !== "capture" || cmd.state !== "done") return;
    if (currentSurface() === "mate-overlay") return;
    toast(tr("mate.shareIndicator", { name: String(cmd.mateName || "Mate") }));
  });
}
