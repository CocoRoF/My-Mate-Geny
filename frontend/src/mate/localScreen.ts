/** A window owns its selected local source. Consent never persists across reloads or logout. */
import { captureBridge, captureError, shotFile, type CaptureSource, type CaptureRequest } from "./screenCapture";
import { apiFetch } from "../api/client";
import { deviceId } from "./voiceOwner";
import { tr } from "../i18n";

export type ScreenMode = "ask" | "on_turn" | "observe";
export interface LocalSharing { sid: string; name: string; mode: ScreenMode; source: string; kind: "screen" | "window"; interval: number; error: string; capturing: boolean }
const listeners = new Set<() => void>();
let sharing: LocalSharing | null = null;
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let observing = false;
let generation = 0;
const cancelled = new Set<string>();
let approval: { id: string; name: string; source: string } | null = null;
let finishApproval: ((allowed: boolean) => void) | null = null;
export const approvalSnapshot = () => approval;
export const answerApproval = (allowed: boolean) => finishApproval?.(allowed);
function askApproval(id: string, current: LocalSharing): Promise<boolean> {
  if (finishApproval) return Promise.resolve(false);
  return new Promise(resolve => {
    approval = { id, name: current.name, source: current.source };
    const timeout = setTimeout(() => answerApproval(false), 45000);
    finishApproval = allowed => {
      clearTimeout(timeout); finishApproval = null; approval = null; emit(); resolve(allowed);
    };
    emit();
  });
}

function emit() {
  listeners.forEach(f => f());
  window.dispatchEvent(new Event("hrh:screen-sharing"));
}
export const subscribeSharing = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const sharingSnapshot = () => sharing;
export const sharedScopes = (): Record<string, ScreenMode> => sharing ? { [sharing.sid]: sharing.mode } : {};
export function stopSharing() {
  generation++;
  answerApproval(false);
  if (timer) clearInterval(timer);
  timer = null;
  const old = stream;
  sharing = null; stream = null;
  if (video) { video.pause(); video.srcObject = null; }
  video = null;
  old?.getTracks().forEach(t => t.stop());
  emit();
}
export function setSharingMode(mode: ScreenMode, interval = 180) {
  if (!sharing) return;
  sharing = { ...sharing, mode, interval: Math.max(60, Math.min(600, interval)), error: "" };
  if (timer) clearInterval(timer);
  timer = null;
  emit();
  if (mode === "observe") timer = setInterval(() => { void observe(); }, sharing.interval * 1000);
}
async function observe() {
  const current = sharing;
  if (!current || current.mode !== "observe" || observing) return;
  observing = true;
  try {
    await apiFetch(`/api/sessions/${encodeURIComponent(current.sid)}/screen/observe`, {
      method: "POST", body: JSON.stringify({ device: deviceId }),
    });
  } catch {
    if (sharing === current) { sharing = { ...sharing, error: tr("screen.requestFailed") }; emit(); }
  } finally { observing = false; }
}
export async function beginSharing(sid: string, name: string, source?: CaptureSource) {
  stopSharing();
  const gen = generation;
  const native = captureBridge();
  let label = source?.name || "";
  if (native) {
    if (native.version < 2) throw new Error(tr("screen.updateApp"));
    if (!source) throw new Error(tr("screen.selectSource"));
    await native.setChoice(`session:${sid}`, source);
  } else {
    const selected = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    if (gen !== generation) { selected.getTracks().forEach(t => t.stop()); return; }
    stream = selected;
    video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    try { await video.play(); } catch (e) { stopSharing(); throw e; }
    const track = stream.getVideoTracks()[0];
    label = track?.getSettings().displaySurface ? track.label || tr("screen.selectedScreen") : tr("screen.selectedScreen");
    stream.getVideoTracks()[0]?.addEventListener("ended", stopSharing, { once: true });
  }
  if (gen !== generation) return;
  sharing = { sid, name, mode: "ask", source: label, kind: source?.kind || (stream?.getVideoTracks()[0]?.getSettings().displaySurface === "window" ? "window" : "screen"), interval: 180, error: "", capturing: false };
  emit();
}
export function cancelLocalCapture(id: string) {
  cancelled.add(id);
  if (approval?.id === id) answerApproval(false);
  if (cancelled.size > 128) cancelled.delete(cancelled.values().next().value!);
}
export async function localFrame(sid: string, id = "", ask = false, options: Partial<CaptureRequest> = {}): Promise<File> {
  const current = sharing;
  const gen = generation;
  if (!current || current.sid !== sid) throw new Error(tr("screen.notSharing"));
  if (current.capturing) throw new Error(tr("mate.shareBusy"));
  if (ask && !captureBridge() && !await askApproval(id, current)) throw new Error(tr("mate.shareDenied"));
  if (cancelled.has(id) || gen !== generation) throw new Error(tr("screen.notSharing"));
  sharing = { ...current, capturing: true, error: "" }; emit();
  try {
    let result: File;
    const native = captureBridge();
    if (native) {
      const shot = id ? await native.request({ id, mate_id: `session:${sid}`, mate_name: current.name, session_id: sid,
        ask, hide_avatar: options.hide_avatar !== false, max_edge: options.max_edge ?? 1920, format: options.format || "jpeg", quality: options.quality || 85, timeout_ms: options.timeout_ms || 45000, reason: options.reason })
        : await native.grab({ mateId: `session:${sid}`, maxEdge: 1920, format: "jpeg", quality: 85, hideAvatar: true, hideConsole: true });
      if (!shot.ok) throw new Error(captureError(shot.code));
      result = shotFile(shot);
    } else {
      if (!video || !stream?.active) throw new Error(tr("screen.notSharing"));
      const canvas = document.createElement("canvas");
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) throw new Error(tr("mate.shareEmpty"));
      const edge = options.max_edge ?? 1920;
      const k = edge > 0 ? Math.min(1, edge / Math.max(w, h)) : 1;
      canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      const mime = options.format === "png" ? "image/png" : "image/jpeg";
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, (options.quality || 85) / 100));
      if (!blob) throw new Error(tr("mate.shareEmpty"));
      result = new File([blob], `screen-${Date.now()}.${mime === "image/png" ? "png" : "jpg"}`, { type: mime });
    }
    if (cancelled.has(id) || gen !== generation) throw new Error(tr("screen.notSharing"));
    return result;
  } catch (e) {
    if (sharing?.sid === sid) sharing = { ...sharing, error: String((e as Error).message || e) };
    throw e;
  } finally {
    cancelled.delete(id);
    if (sharing?.sid === sid) sharing = { ...sharing, capturing: false };
    emit();
  }
}
window.addEventListener("pagehide", stopSharing);
