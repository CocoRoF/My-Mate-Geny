import {deviceEventHello} from "./deviceEvents";
/** the phone-call screen this page has (backend app/mate/calls.py CALL_CLIENT) */
const CALL_CLIENT = 1;
import { devicePreferences } from "../stores/devicePreferences";
/**
 * Screen capture for the Mate (docs/mate.md §4 "Seeing the screen"), the page's part.
 *
 * - Every window tells the server who it is on /ws/sessions (`clientHello`): the device (mate/voiceOwner `deviceId`),
 *   the window, the desktop app's version and its capture bridge (`window.hrhNative.capture`, desktop/src/capture.js).
 * - The mate's `see_screen`, on the device the user talks from: shared, the window sharing that conversation takes
 *   a frame of the share (scope "session", mate/localScreen.ts); not shared, a desktop app window hands it to the app
 *   (scope "mate": this device's chosen source, asking first unless this device allows it — a browser can't, the
 *   server tells her why). `handleCaptureRequest` uploads the picture as a normal attachment of the mate's
 *   conversation and answers `POST /api/mates/{id}/capture/{rid}` (shared: `/api/sessions/{sid}/screen/{rid}/result`).
 *   Every path answers — a failure too — so the mate's tool call never waits for nothing.
 * - The user's Share screen (the composer's + menu): the desktop app's picker of screens and windows, or in a browser
 *   `getDisplayMedia` (the browser's picker) → sharing on, "with each message"; phones have neither (no item).
 * - All screens (desktop app ≥ CAPTURE_ALL_SCREENS, more than one display): every screen its own picture, never
 *   stitched, the one in use first ("main", the others "sub"). Each is uploaded with the request's proof; the answer
 *   lists them in that order — only when the server asked for them (`multi`), else the main one alone.
 * - Completed captures are silent: no toast, banner, tray alert or completion listener.
 */
import {
  sharedScopes,
  sharingSnapshot,
  finishLocalCapture,
  localFrames,
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

/** one picture of an all-screens capture */
export interface CapturePicture {
  data: Uint8Array;
  mime: string;
  width: number;
  height: number;
  source: CaptureSource | null;
  role: "main" | "sub";
}

export type CaptureShot =
  | {
      ok: true;
      data: Uint8Array;
      mime: string;
      width: number;
      height: number;
      source: CaptureSource | null;
      /** asked with `multi` (bridge ≥ 4): every picture, main first (the fields above are the main one) */
      shots?: CapturePicture[];
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
  notifications?: number;
  resume?: number;
  runtime?: number;
  sharing?: {
    pause?(reason:string):Promise<void>;
    claim?(): Promise<boolean>;
    get(): Promise<{
      revision: number;
      state: import("./localScreen").LocalSharing | null;
      owner: boolean; status?:string; enabled?:boolean;
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
        owner: boolean; status?:string; enabled?:boolean;
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
    hideAvatar?: boolean;
    hideConsole?: boolean;
    /** every screen of an all-screens share (`shots`) */
    multi?: boolean;
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
  timeout_ms: number;
  reason?: string;
  /** the server takes every screen of an all-screens share (app/mate/capture.py MULTI_BRIDGE) */
  multi?: boolean;
  max_pictures?: number;
}

export const CAPTURE_VERSION = 1;
/** the bridge that shares all screens, each its own picture (desktop/src/capture.js) */
export const CAPTURE_ALL_SCREENS = 4;
/** the pseudo source "All screens" (desktop: device preference screen.all_screens) */
export const ALL_SCREENS = "screen:all";
export const allScreensSource = (): CaptureSource => ({ id: ALL_SCREENS, name: tr("screen.allScreens"), kind: "screen" });
/** "All screens" is offered: a desktop app that can, and more than one screen */
export const canShareAllScreens = (sources: CaptureSource[]): boolean =>
  Number(captureBridge()?.version) >= CAPTURE_ALL_SCREENS &&
  sources.filter((s) => s.kind === "screen" && s.id !== ALL_SCREENS).length > 1;

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
    ...deviceEventHello(),
    user_busy: typeof document!=="undefined" && document.hasFocus() && !!((document.activeElement as HTMLInputElement|null)?.value),
    type: "client",
    device: deviceId,
    surface: currentSurface(),
    desktop: desktopVersion(),
    capture:
      captureBridge()?.version ?? (Object.keys(sharedScopes()).length ? 1 : 0),
    shares: sharedScopes(),
    screen_policy: {enabled:devicePreferences().screen.proactive_enabled,interval:60,mate_id:devicePreferences().screen.proactive_mate||"",fixed:true},
    screen_ready: true,
    // (her phone calls ring the Android app: app/mate/calls.py)
    native: typeof window !== "undefined" ? window.hrhNative?.platform || "" : "",
    calls: CALL_CLIENT,
    visible: typeof document === "undefined" || document.visibilityState === "visible",
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
  at = stamp(),
): File {
  const ext = shot.mime === "image/jpeg" ? "jpg" : "png";
  // (a copy: the IPC buffer may be a view of a larger one)
  return new File([new Uint8Array(shot.data)], `${prefix}-${at}.${ext}`, {
    type: shot.mime,
  });
}

/** one picture of a capture as a file: its role (main = the screen in use) and source */
export interface SharedPicture {
  file: File;
  role: "main" | "sub";
  source: CaptureSource | null;
}

/** a capture's pictures as files, main first (one picture: one file, named as before) */
export function shotPictures(
  shot: Extract<CaptureShot, { ok: true }>,
  prefix = "screen",
): SharedPicture[] {
  const list = shot.shots?.length ? shot.shots : [shot];
  const at = stamp();
  return list.map((s, i) => ({
    file: shotFile(s, list.length > 1 ? `${prefix}-${i ? `other-${i}` : "main"}` : prefix, at),
    role: i ? "sub" : "main",
    source: s.source,
  }));
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
  const aids: string[] = [];
  let committed = false;
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
    let pictures: SharedPicture[];
    if (req.scope === "session") {
      const shared = sharingSnapshot();
      pictures = await localFrames(req.session_id, req.id, req.ask, req);
      // (one picture: named as the share is; all screens: each by its own screen)
      if (shared && pictures.length === 1) pictures[0].source = { id: "", name: shared.source, kind: shared.kind };
    } else {
      // Not shared: she asked to look once — this app's chosen source, asking first and size as this device says.
      const bridge = captureBridge();
      if (!bridge) throw new Error(captureError("error"));
      const screen = devicePreferences().screen;
      const shot = await bridge.request({
        ...req, hide_avatar: false, ask: !req.automatic && screen.approval === "ask", max_edge: screen.max_edge,
      });
      if (!shot.ok) throw new Error(captureError(shot.code));
      pictures = shotPictures(shot);
    }
    // (an older server takes one picture: the main one)
    pictures = pictures.slice(0, req.multi ? Math.max(1, req.max_pictures || 6) : 1);
    if (op.cancelled || !pictures.length) throw new Error(captureError("stopped"));
    const answer: { id: string; role: string; source: { name: string; kind: string } | null }[] = [];
    for (const p of pictures) {
      const upload = uploadAttachment(
        req.session_id,
        p.file,
        () => {},
        req.proof ? { id: req.id, proof: req.proof } : undefined,
      );
      op.abort = upload.abort;
      const att = await upload.promise;
      aids.push(att.id);
      op.abort = undefined;
      if (op.cancelled) throw new Error(captureError("stopped"));
      answer.push({ id: att.id, role: p.role, source: p.source && { name: p.source.name, kind: p.source.kind } });
    }
    await respond({
      ok: true, attachment_id: answer[0].id, source: pictures[0].source,
      ...(req.multi ? { attachments: answer } : {}),
    });
    committed = true;
  } catch (e) {
    try {
      await respond({
        ok: false,
        code: op.cancelled ? "stopped" : "error",
        message: String((e as Error)?.message || e),
      });
    } catch {}
  } finally {
    if (!committed)
      for (const aid of aids)
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
