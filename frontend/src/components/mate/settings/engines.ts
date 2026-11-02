/**
 * Voice engines a mate can pick and whether Global settings has them working; a tiny shared player for voice
 * previews (a preview URL or a synthesized Blob).
 */
import { useSyncExternalStore } from "react";
import type { Providers, ProviderStatus, SttEngine, TtsEngine } from "../../../api/mates";
import { webSpeechRecognition } from "../../../mate/desktop";
import { routeOutput, setOutputVolume } from "../../../mate/voiceBridge";
import { tr, type MsgKey } from "../../../i18n";

export interface EngineInfo<T extends string> {
  id: T;
  /** message keys (shown with t()) */
  label: MsgKey;
  hint: MsgKey;
  /** synthesized / recognized by the backend through a provider of Global settings */
  provider: boolean;
}

export const TTS_ENGINES: EngineInfo<TtsEngine>[] = [
  { id: "off", label: "common.off", hint: "mateSettings.engTtsOffHint", provider: false },
  { id: "browser", label: "mateSettings.engTtsBrowser", hint: "mateSettings.engTtsBrowserHint", provider: false },
  { id: "openai", label: "mateSettings.engOpenai", hint: "mateSettings.engTtsOpenaiHint", provider: true },
  { id: "elevenlabs", label: "mateSettings.engElevenlabs", hint: "mateSettings.engTtsElevenHint", provider: true },
  { id: "omnivoice", label: "mateSettings.engOmnivoice", hint: "mateSettings.engTtsOmniHint", provider: true },
  { id: "http", label: "mateSettings.engHttp", hint: "mateSettings.engTtsHttpHint", provider: true },
];

export const STT_ENGINES: EngineInfo<SttEngine>[] = [
  { id: "off", label: "common.off", hint: "mateSettings.engSttOffHint", provider: false },
  { id: "browser", label: "mateSettings.engSttBrowser", hint: "mateSettings.engSttBrowserHint", provider: false },
  { id: "openai", label: "mateSettings.engOpenai", hint: "mateSettings.engSttOpenaiHint", provider: true },
  { id: "whisper", label: "mateSettings.engWhisper", hint: "mateSettings.engSttWhisperHint", provider: true },
  { id: "elevenlabs", label: "mateSettings.engElevenRealtime", hint: "mateSettings.engSttElevenHint", provider: true },
];

export type Availability =
  | { state: "ready"; detail?: string | null }
  | { state: "checking" }
  | { state: "error"; error: string }
  | { state: "missing" }
  | { state: "unsupported"; why: string };

export function providerOf(providers: Providers | null, kind: "tts" | "stt", engine: string): ProviderStatus | undefined {
  return providers?.[kind].find((p) => p.engine === engine);
}

/** can a mate use this engine now? (Off/Browser always; providers only once Global settings verified them)
 * (`why` / `error` are in the UI's language at call time — call it while rendering) */
export function availability(providers: Providers | null, kind: "tts" | "stt", engine: string): Availability {
  if (engine === "off") return { state: "ready" };
  if (engine === "browser") {
    if (kind === "stt" && !webSpeechRecognition()) return { state: "unsupported", why: tr("mateSettings.engNoRecognition") };
    if (kind === "tts" && typeof speechSynthesis === "undefined") return { state: "unsupported", why: tr("mateSettings.engNoSpeech") };
    return { state: "ready" };
  }
  if (!providers) return { state: "checking" };
  const p = providerOf(providers, kind, engine);
  if (!p || !p.configured) return { state: "missing" };
  if (p.ok === null) return { state: "checking" };
  if (!p.ok) return { state: "error", error: p.error || tr("mateSettings.engVerifyFailed") };
  return { state: "ready", detail: p.detail };
}

export const usable = (a: Availability) => a.state === "ready" || a.state === "checking";

// ── preview player (one sound at a time across the settings) ──

/** synthesized previews (Blob / same-origin): routed through Web Audio, so a volume over 100 % really amplifies */
let audio: HTMLAudioElement | null = null;
/** provider preview URLs on another origin: played as they are (Web Audio would get silence from them) */
let plainAudio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let playing: string | null = null;
/** the volume previews play at (the Voice tab's unsaved slider), 0..3 */
let previewVolume = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** the volume of voice previews (0..3; the Voice tab sets its slider's value) — applies to the one playing too */
export function setPreviewVolume(v: number): void {
  previewVolume = Number.isFinite(v) ? Math.max(0, Math.min(3, v)) : 1;
  if (audio) setOutputVolume(audio, previewVolume);
  if (plainAudio) plainAudio.volume = Math.min(1, previewVolume);
}

export function stopPreview(): void {
  for (const a of [audio, plainAudio]) {
    if (!a) continue;
    a.pause();
    a.removeAttribute("src");
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  if (playing !== null) {
    playing = null;
    emit();
  }
}

const sameOrigin = (url: string) => {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
};

/** play a URL / Blob as preview `key` (a second click on the same key stops it) */
export async function playPreview(key: string, src: string | Blob): Promise<void> {
  const again = playing === key;
  stopPreview();
  if (again) return;
  const routed = typeof src !== "string" || src.startsWith("blob:") || sameOrigin(src);
  let el: HTMLAudioElement;
  if (routed) {
    audio ??= new Audio();
    el = audio;
    // (a click: the context may resume) — over 100 % needs the element in the Web Audio graph
    await routeOutput(el);
    setOutputVolume(el, previewVolume);
  } else {
    plainAudio ??= new Audio();
    el = plainAudio;
    el.volume = Math.min(1, previewVolume);
  }
  const url = typeof src === "string" ? src : (objectUrl = URL.createObjectURL(src));
  el.src = url;
  playing = key;
  emit();
  const ended = () => {
    if (playing === key) {
      playing = null;
      emit();
    }
  };
  el.onended = ended;
  el.onerror = ended;
  try {
    await el.play();
  } catch (e) {
    if (playing === key) {
      playing = null;
      emit();
    }
    throw e;
  }
}

/** speak with the browser (the browser-voice preview) */
export function speakPreview(key: string, text: string, opts: { voice?: string; lang?: string; rate?: number }): void {
  const again = playing === key;
  stopPreview();
  if (again || typeof speechSynthesis === "undefined") return;
  const u = new SpeechSynthesisUtterance(text);
  if (opts.lang) u.lang = opts.lang;
  if (opts.rate) u.rate = opts.rate;
  u.volume = Math.min(1, previewVolume); // speechSynthesis stops at 100 %
  const v = opts.voice ? speechSynthesis.getVoices().find((x) => x.voiceURI === opts.voice || x.name === opts.voice) : undefined;
  if (v) u.voice = v;
  const ended = () => {
    if (playing === key) {
      playing = null;
      emit();
    }
  };
  u.onend = ended;
  u.onerror = ended;
  playing = key;
  emit();
  speechSynthesis.speak(u);
}

/** which preview plays now (null = none) */
export function usePreviewPlaying(): string | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => playing,
    () => null,
  );
}
