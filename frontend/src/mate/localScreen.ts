import { devicePreferences } from "../stores/devicePreferences";
/** A window owns its selected local source. Consent never persists across reloads or logout. */
import {
  captureBridge,
  captureError,
  shotFile,
  type CaptureSource,
  type CaptureRequest,
} from "./screenCapture";
import { apiFetch } from "../api/client";
import { deviceId } from "./voiceOwner";
import { tr } from "../i18n";

export type ScreenMode = "ask" | "on_turn" | "observe";
export interface LocalSharing {
  sid: string;
  name: string;
  mode: ScreenMode;
  source: string;
  kind: "screen" | "window";
  interval: number;
  error: string;
  capturing: boolean;
}
const listeners = new Set<() => void>();
let sharing: LocalSharing | null = null;
let ownsSharing = true;
let nativeRevision = -1;
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let observing = false;
const proactive = new Map<string, { enabled: boolean; interval: number }>();
export function configureProactive(
  sid: string,
  enabled: boolean,
  interval: number,
) {
  const previous = proactive.get(sid);
  if (previous?.enabled === enabled && previous.interval === interval) return;
  proactive.set(sid, { enabled, interval });
  if (sharing?.sid === sid && ownsSharing) {
    scheduleObservation();
    if (enabled && !previous?.enabled) {
      primedGeneration = -1;
      emit();
    }
  }
}
function scheduleObservation() {
  if (timer) clearInterval(timer);
  timer = null;
  if (!sharing || !ownsSharing) return;
  const p = proactive.get(sharing.sid);
  if (p?.enabled || sharing.mode === "observe")
    timer = setInterval(
      () => void observe(),
      (p?.enabled ? p.interval : sharing.interval) * 1000,
    );
}
let generation = 0;
let primedGeneration = -1;
export function observeSharingReady(shares: string[]) {
  if (
    !sharing ||
    !ownsSharing ||
    !proactive.get(sharing.sid)?.enabled ||
    !shares.includes(sharing.sid) ||
    primedGeneration === generation
  )
    return;
  primedGeneration = generation;
  void observe();
}
const cancelled = new Set<string>();
let approval: { id: string; name: string; source: string } | null = null;
let finishApproval: ((allowed: boolean) => void) | null = null;
export const approvalSnapshot = () => approval;
export const answerApproval = (allowed: boolean) => finishApproval?.(allowed);
function askApproval(id: string, current: LocalSharing): Promise<boolean> {
  if (finishApproval) return Promise.resolve(false);
  return new Promise((resolve) => {
    approval = { id, name: current.name, source: current.source };
    const timeout = setTimeout(() => answerApproval(false), 45000);
    finishApproval = (allowed) => {
      clearTimeout(timeout);
      finishApproval = null;
      approval = null;
      emit();
      resolve(allowed);
    };
    emit();
  });
}

function emit(publish = true) {
  if (publish && ownsSharing)
    void captureBridge()
      ?.sharing?.publish(sharing)
      .catch(() => {});
  listeners.forEach((f) => f());
  window.dispatchEvent(new Event("hrh:screen-sharing"));
}
export const subscribeSharing = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};
export const sharingSnapshot = () => sharing;
export const sharedScopes = (): Record<string, ScreenMode> =>
  sharing && ownsSharing ? { [sharing.sid]: sharing.mode } : {};
export function stopSharing(notify: unknown = true) {
  window.dispatchEvent(new Event("hrh:cancel-captures"));
  if (notify !== false) {
    void captureBridge()?.sharing?.stop();
    void captureBridge()?.cancel("*");
  }
  generation++;
  answerApproval(false);
  if (timer) clearInterval(timer);
  timer = null;
  const old = stream;
  sharing = null;
  stream = null;
  if (video) {
    video.pause();
    video.srcObject = null;
  }
  video = null;
  old?.getTracks().forEach((t) => t.stop());
  emit(false);
}
export const sharingOwned = () => ownsSharing;
export function stopOwnedSharing() {
  if (ownsSharing) stopSharing();
}
export function setSharingMode(mode: ScreenMode, interval = 180) {
  if (!sharing) return;
  if (!ownsSharing && captureBridge()?.sharing) {
    void captureBridge()!.sharing!.mode(mode, interval);
    return;
  }
  sharing = {
    ...sharing,
    mode,
    interval: Math.max(60, Math.min(600, interval)),
    error: "",
  };
  if (timer) clearInterval(timer);
  timer = null;
  emit();
  scheduleObservation();
}
async function observe() {
  const current = sharing;
  if (
    !current ||
    !ownsSharing ||
    (current.mode !== "observe" && !proactive.get(current.sid)?.enabled) ||
    observing
  )
    return;
  observing = true;
  try {
    await apiFetch(
      `/api/sessions/${encodeURIComponent(current.sid)}/screen/observe`,
      {
        method: "POST",
        body: JSON.stringify({ device: deviceId }),
      },
    );
  } catch {
    if (sharing === current) {
      sharing = { ...sharing, error: tr("screen.requestFailed") };
      emit();
    }
  } finally {
    observing = false;
  }
}
export async function beginSharing(
  sid: string,
  name: string,
  source?: CaptureSource,
) {
  stopSharing();
  ownsSharing = true;
  const gen = generation;
  const native = captureBridge();
  let label = source?.name || "";
  if (native) {
    if (native.version < 3) throw new Error(tr("screen.updateApp"));
    if (!source) throw new Error(tr("screen.selectSource"));
    await native.setChoice(`session:${sid}`, source);
  } else {
    const selected = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    if (gen !== generation) {
      selected.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = selected;
    video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (e) {
      stopSharing();
      throw e;
    }
    const track = stream.getVideoTracks()[0];
    label = track?.getSettings().displaySurface
      ? track.label || tr("screen.selectedScreen")
      : tr("screen.selectedScreen");
    stream
      .getVideoTracks()[0]
      ?.addEventListener("ended", stopSharing, { once: true });
  }
  if (gen !== generation) return;
  ownsSharing = true;
  sharing = {
    sid,
    name,
    mode: "ask",
    source: label,
    kind:
      source?.kind ||
      (stream?.getVideoTracks()[0]?.getSettings().displaySurface === "window"
        ? "window"
        : "screen"),
    interval: 180,
    error: "",
    capturing: false,
  };
  emit();
  scheduleObservation();
}
export function cancelLocalCapture(id: string) {
  cancelled.add(id);
  if (approval?.id === id) answerApproval(false);
  if (cancelled.size > 128) cancelled.delete(cancelled.values().next().value!);
}
export async function localFrame(
  sid: string,
  id = "",
  ask = false,
  options: Partial<CaptureRequest> = {},
): Promise<File> {
  const current = sharing;
  const gen = generation;
  options = { ...options, ...devicePreferences().screen };
  ask = !options.automatic && devicePreferences().screen.approval === "ask";
  if (!current || !ownsSharing || current.sid !== sid)
    throw new Error(tr("screen.notSharing"));
  if (current.capturing) throw new Error(tr("mate.shareBusy"));
  if (ask && !captureBridge() && !(await askApproval(id, current)))
    throw new Error(tr("mate.shareDenied"));
  if (cancelled.has(id) || gen !== generation)
    throw new Error(tr("screen.notSharing"));
  sharing = { ...current, capturing: true, error: "" };
  emit();
  try {
    let result: File;
    const native = captureBridge();
    if (native) {
      const shot = id
        ? await native.request({
            id,
            mate_id: `session:${sid}`,
            mate_name: current.name,
            session_id: sid,
            ask,
            hide_avatar: false,
            max_edge: options.max_edge ?? 1920,
            format: options.format || "jpeg",
            quality: options.quality || 85,
            timeout_ms: options.timeout_ms || 45000,
            reason: options.reason,
            automatic: options.automatic,
          })
        : await native.grab({
            mateId: `session:${sid}`,
            maxEdge: 1920,
            format: "jpeg",
            quality: 85,
            hideAvatar: false,
            hideConsole: false,
          });
      if (!shot.ok) throw new Error(captureError(shot.code));
      result = shotFile(shot);
    } else {
      if (!video || !stream?.active) throw new Error(tr("screen.notSharing"));
      const canvas = document.createElement("canvas");
      const w = video.videoWidth,
        h = video.videoHeight;
      if (!w || !h) throw new Error(tr("mate.shareEmpty"));
      const edge = options.max_edge ?? 1920;
      const k = edge > 0 ? Math.min(1, edge / Math.max(w, h)) : 1;
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(h * k);
      canvas
        .getContext("2d")!
        .drawImage(video, 0, 0, canvas.width, canvas.height);
      const mime = options.format === "png" ? "image/png" : "image/jpeg";
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, mime, (options.quality || 85) / 100),
      );
      if (!blob) throw new Error(tr("mate.shareEmpty"));
      result = new File(
        [blob],
        `screen-${Date.now()}.${mime === "image/png" ? "png" : "jpg"}`,
        { type: mime },
      );
    }
    if (cancelled.has(id) || gen !== generation)
      throw new Error(tr("screen.notSharing"));
    return result;
  } catch (e) {
    if (sharing?.sid === sid)
      sharing = { ...sharing, error: String((e as Error).message || e) };
    throw e;
  } finally {
    cancelled.delete(id);
    if (sharing?.sid === sid && options.scope !== "session")
      sharing = { ...sharing, capturing: false };
    emit();
  }
}
export function finishLocalCapture(sid: string) {
  if (sharing?.sid === sid && ownsSharing) {
    sharing = { ...sharing, capturing: false };
    emit();
  }
}
window.addEventListener("pagehide", stopOwnedSharing);
queueMicrotask(() => {
  const nativeSharing = captureBridge()?.sharing;
  if (nativeSharing) {
    const receive = (v: {
      revision: number;
      state: LocalSharing | null;
      owner: boolean;
    }) => {
      if (!v || v.revision < nativeRevision) return;
      nativeRevision = v.revision;
      if (!v.owner && ownsSharing && sharing) {
        generation++;
        if (timer) clearInterval(timer);
        timer = null;
      }
      ownsSharing = v.owner;
      sharing = v.state;
      // IPC stop/snapshot replies can arrive after beginSharing scheduled its timer. Recover only
      // from the authoritative owner snapshot; don't reset a live timer on every capture update.
      if (ownsSharing && sharing && !timer) scheduleObservation();
      emit(false);
    };
    nativeSharing.onChanged(receive);
    nativeSharing.onControl((cmd) => {
      if (cmd.type === "cancel-captures")
        window.dispatchEvent(new Event("hrh:cancel-captures"));
      if (cmd.type === "stop") stopSharing(false);
      if (
        cmd.type === "mode" &&
        ["ask", "on_turn", "observe"].includes(cmd.mode || "")
      )
        setSharingMode(cmd.mode as ScreenMode, cmd.interval);
    });
    void nativeSharing.get().then(receive);
  }
});

// Keep the owner's policy current even when its composer is not mounted (console navigated elsewhere).
if (typeof window !== "undefined")
  window.addEventListener("hrh:mate-policies", (event) => {
    const rows = (event as CustomEvent).detail;
    if (!Array.isArray(rows)) return;
    for (const p of rows)
      if (p.sid) configureProactive(p.sid, !!p.enabled, p.interval || 180);
  });
