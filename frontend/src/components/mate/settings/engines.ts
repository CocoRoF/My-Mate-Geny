/**
 * Voice engines a mate can pick and whether Global settings has them working; a tiny shared player for voice
 * previews (a preview URL or a synthesized Blob).
 */
import { useSyncExternalStore } from "react";
import type { Providers, ProviderStatus, SttEngine, TtsEngine } from "../../../api/mates";
import { webSpeechRecognition } from "../../../mate/desktop";

export interface EngineInfo<T extends string> {
  id: T;
  label: string;
  hint: string;
  /** synthesized / recognized by the backend through a provider of Global settings */
  provider: boolean;
}

export const TTS_ENGINES: EngineInfo<TtsEngine>[] = [
  { id: "off", label: "Off", hint: "Never speaks.", provider: false },
  { id: "browser", label: "Browser voice", hint: "Free, spoken by this device. Some systems (often Linux) have no voices.", provider: false },
  { id: "openai", label: "OpenAI", hint: "Natural voices; GPT-4o mini TTS follows the reply's emotion.", provider: true },
  { id: "elevenlabs", label: "ElevenLabs", hint: "Your account's voices — premade, cloned and from the library.", provider: true },
  { id: "omnivoice", label: "OmniVoice", hint: "Your own server: cloned voice profiles with emotion clips, or a designed voice.", provider: true },
  { id: "http", label: "OpenAI-compatible server", hint: "Any server with an OpenAI-shaped /audio/speech.", provider: true },
];

export const STT_ENGINES: EngineInfo<SttEngine>[] = [
  { id: "off", label: "Off", hint: "No mic button.", provider: false },
  { id: "browser", label: "Browser recognition", hint: "Web Speech in Chrome, Edge and Safari.", provider: false },
  { id: "openai", label: "OpenAI", hint: "GPT-4o (mini) Transcribe or Whisper.", provider: true },
  { id: "whisper", label: "Whisper server", hint: "Your own OpenAI-compatible transcription server.", provider: true },
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

/** can a mate use this engine now? (Off/Browser always; providers only once Global settings verified them) */
export function availability(providers: Providers | null, kind: "tts" | "stt", engine: string): Availability {
  if (engine === "off") return { state: "ready" };
  if (engine === "browser") {
    if (kind === "stt" && !webSpeechRecognition()) return { state: "unsupported", why: "Not available in this app or browser" };
    if (kind === "tts" && typeof speechSynthesis === "undefined") return { state: "unsupported", why: "This browser can't speak" };
    return { state: "ready" };
  }
  if (!providers) return { state: "checking" };
  const p = providerOf(providers, kind, engine);
  if (!p || !p.configured) return { state: "missing" };
  if (p.ok === null) return { state: "checking" };
  if (!p.ok) return { state: "error", error: p.error || "verification failed" };
  return { state: "ready", detail: p.detail };
}

export const usable = (a: Availability) => a.state === "ready" || a.state === "checking";

// ── preview player (one sound at a time across the settings) ──

let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let playing: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function stopPreview(): void {
  if (audio) {
    audio.pause();
    audio.src = "";
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  if (playing !== null) {
    playing = null;
    emit();
  }
}

/** play a URL / Blob as preview `key` (a second click on the same key stops it) */
export async function playPreview(key: string, src: string | Blob): Promise<void> {
  const again = playing === key;
  stopPreview();
  if (again) return;
  audio ??= new Audio();
  const url = typeof src === "string" ? src : (objectUrl = URL.createObjectURL(src));
  audio.src = url;
  playing = key;
  emit();
  const ended = () => {
    if (playing === key) {
      playing = null;
      emit();
    }
  };
  audio.onended = ended;
  audio.onerror = ended;
  try {
    await audio.play();
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
