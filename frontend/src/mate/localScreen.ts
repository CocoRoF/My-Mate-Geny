import { devicePreferences, patchDevicePreferences, loadDevicePreferences, subscribeDevicePreferences } from "../stores/devicePreferences";
/** One runtime owner restores explicit sharing intent stored only on this device. */
import {
  captureBridge,
  captureError,
  toast,
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
  const local = devicePreferences().screen;
  if (local.proactive_enabled !== null) { enabled=local.proactive_enabled; interval=local.proactive_interval; }
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
let releaseBrowserOwner: (() => void) | null = null;
async function claimBrowserOwner() {
  if (!navigator.locks) return true;
  return new Promise<boolean>((resolve) => {
    void navigator.locks.request("hrh-screen-owner", {ifAvailable:true}, async lock => {
      if (!lock) {resolve(false);return;}
      resolve(true);
      await new Promise<void>(release => {releaseBrowserOwner=release;});
    });
  });
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
  if (notify !== false) void patchDevicePreferences({sharing:{enabled:false}});
  window.dispatchEvent(new Event("hrh:cancel-captures"));
  if (notify !== false) {
    void captureBridge()?.sharing?.stop();
    void captureBridge()?.cancel("*");
  }
  generation++;
  releaseBrowserOwner?.();releaseBrowserOwner=null;
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
  if (ownsSharing) { stopSharing(false); void captureBridge()?.sharing?.publish(null); }
}
export function setSharingMode(mode: ScreenMode, interval = 180) {
  void patchDevicePreferences({sharing:{mode,interval}});
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
  restoring = false,
) {
  stopSharing(false);
  ownsSharing = true;
  const gen = generation;
  const native = captureBridge();
  let label = source?.name || "";
  if (native) {
    if (native.version < 3) throw new Error(tr("screen.updateApp"));
    if (!source) throw new Error(tr("screen.selectSource"));
    await native.setChoice(`session:${sid}`, source);
  } else {
    if (!(await claimBrowserOwner())) throw new Error(tr("mate.shareBusy"));
    let selected: MediaStream;
    try {selected=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});}
    catch(e) {releaseBrowserOwner?.();releaseBrowserOwner=null;throw e;}
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
    mode: devicePreferences().sharing.mode,
    source: label,
    kind:
      source?.kind ||
      (stream?.getVideoTracks()[0]?.getSettings().displaySurface === "window"
        ? "window"
        : "screen"),
    interval: devicePreferences().sharing.interval,
    error: "",
    capturing: false,
  };
  if (restoring && native?.sharing) {
    const result = await native.sharing.publish({...sharing, restoring:true} as LocalSharing);
    if (gen !== generation) return;
    if (!(result as {owner?:boolean})?.owner) { stopSharing(false); return; }
  }
  if (!restoring && (!native || native.resume) && typeof location !== "undefined") await patchDevicePreferences({sharing:{enabled:true,origin:location.origin,sid,name}});
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
      if (!shot.ok) {
        if (["source_gone","permission"].includes(shot.code || "")) {stopSharing();toast(tr("screen.restoreMissing"));}
        throw new Error(captureError(shot.code));
      }
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
let leaving = false;
window.addEventListener("pagehide", () => {leaving=true;stopOwnedSharing();});
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
      if (!sharing && !leaving) void resumeSharing();
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

let resuming = false;
/** Restore validates source metadata without uploading an image. Missing sources never fall back. */
export async function resumeSharing() {
  if (leaving || resuming || sharing) return;
  const saved = devicePreferences().sharing;
  if (!saved.enabled || saved.origin !== location.origin) return;
  const native = captureBridge();
  if (native && !native.resume) return; // new app required for the restore lease
  resuming = true;
  try {
    if (native && !(await native.sharing?.claim?.())) return;
    // Authentication/network errors preserve intent for reconnect, not an unwanted logout/reset.
    let response: Response;
    try {response=await fetch(`/api/sessions/${encodeURIComponent(saved.sid)}`);} catch {return;}
    if ([401,403].includes(response.status)) return;
    if (response.status === 404) throw new Error(tr("screen.restoreMissing"));
    if (!response.ok) return;
    if (!native) {
      if (!(await claimBrowserOwner())) return; // another tab already owns the live stream
      await loadDevicePreferences();
      if (!devicePreferences().sharing.enabled) {releaseBrowserOwner?.();releaseBrowserOwner=null;return;}
      throw new Error(tr("screen.restoreBrowser"));
    }
    const info = await native.info();
    if (info.wayland || info.permission !== "granted") throw new Error(tr("screen.restorePermission"));
    const rows = await native.sources();
    const pref = devicePreferences().screen.source;
    let source = pref ? rows.find(r=>r.id===pref.id) : rows.find(r=>r.primary) || rows.find(r=>r.kind==="screen");
    if (source && pref?.kind==="window" && source.name!==pref.name) source=undefined;
    if (!source && pref?.kind==="screen" && pref.display_id) source=rows.find(r=>r.kind==="screen" && r.display_id===pref.display_id);
    if (!source && pref?.kind==="window") {const matches=rows.filter(r=>r.kind==="window" && r.name===pref.name);if(matches.length===1)source=matches[0];}
    if (!source) throw new Error(tr("screen.restoreMissing"));
    await beginSharing(saved.sid,saved.name,source,true);
  } catch(e) {
    stopSharing();
    toast(String((e as Error).message || tr("screen.restoreMissing")));
  } finally {resuming=false;}
}
subscribeDevicePreferences(() => {
  const prefs=devicePreferences();
  for(const [sid,p] of proactive)configureProactive(sid,p.enabled,p.interval);
  if (sharing && !prefs.sharing.enabled && (!captureBridge() || captureBridge()?.resume)) stopOwnedSharing();
  window.dispatchEvent(new Event("hrh:screen-sharing"));
  if (!sharing) void resumeSharing();
});
void loadDevicePreferences().then(()=>resumeSharing()).catch(()=>{});
