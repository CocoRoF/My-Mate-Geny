/**
 * The microphone as raw samples (docs/mate.md §5): getUserMedia with echo cancellation, noise suppression and
 * automatic gain → an AudioWorklet tap (ScriptProcessor where worklets are missing) → `onFrames(samples, rate)` at the
 * device's rate. close() stops the tracks (the browser's "mic in use" mark goes), disconnects the nodes and closes the
 * context. The Android app's WebView asks for the permission through Capacitor (RECORD_AUDIO); the desktop app allows
 * audio for the server's own pages (desktop/src/main.js setupPermissions).
 */

export interface MicHandle {
  rate: number;
  close: () => void;
  /** the track ended by itself (unplugged, revoked, another app took it) */
  onEnded: (() => void) | null;
}

/** the same constraints for every recorder in the app: echo cancellation matters while she speaks */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

// batches the worklet's 128-sample blocks (≈ 21 ms at 48 kHz per message)
const WORKLET = `
class HrhPcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(1024); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("hrh-pcm-tap", HrhPcmTap);
`;

export function micSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined";
}

export async function openMic(onFrames: (samples: Float32Array, rate: number) => void): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  let ctx: AudioContext | null = null;
  let url: string | null = null;
  const nodes: AudioNode[] = [];
  const handle: MicHandle = { rate: 0, close: () => {}, onEnded: null };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stream.getTracks().forEach((t) => t.stop());
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* already */
      }
    }
    const p = nodes.find((n) => n instanceof AudioWorkletNode) as AudioWorkletNode | undefined;
    if (p) p.port.onmessage = null;
    void ctx?.close().catch(() => {});
    if (url) URL.revokeObjectURL(url);
  };
  handle.close = close;
  try {
    ctx = new AudioContext();
    handle.rate = ctx.sampleRate;
    const src = ctx.createMediaStreamSource(stream);
    // pulled by the graph, heard by nobody
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    nodes.push(src, sink);
    let tap: AudioNode | null = null;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        const node = new AudioWorkletNode(ctx, "hrh-pcm-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        node.port.onmessage = (e) => !closed && onFrames(e.data as Float32Array, ctx!.sampleRate);
        tap = node;
      } catch {
        tap = null; // (a WebView without worklets / a blob: policy) → ScriptProcessor
      }
    }
    if (!tap) {
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => !closed && onFrames(new Float32Array(e.inputBuffer.getChannelData(0)), ctx!.sampleRate);
      tap = sp;
    }
    nodes.push(tap);
    src.connect(tap);
    tap.connect(sink);
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    for (const t of stream.getAudioTracks()) t.addEventListener("ended", () => !closed && handle.onEnded?.());
    return handle;
  } catch (e) {
    close();
    throw e;
  }
}

/** a getUserMedia failure in the user's terms */
export function micErrorKind(e: unknown): "denied" | "nodevice" | "busy" | "other" {
  const name = (e as DOMException)?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "nodevice";
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") return "busy";
  return "other";
}
