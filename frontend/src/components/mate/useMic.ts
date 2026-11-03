/**
 * Push-to-talk for a mate (docs/mate.md §5): the mate's STT engine decides how — `browser` = Web Speech recognition
 * (only in a real browser: Electron and the Android WebView have none), `openai` / `whisper` = record with
 * MediaRecorder (webm/opus) and POST it to /api/mates/{id}/transcribe, `elevenlabs` = realtime (mate/stt/realtime.ts):
 * the mic streams to ElevenLabs with a token the server mints, the live text shows in the box while you speak, each
 * finished utterance comes through `onSegment` (the composer puts it in the box, or sends it: auto-send). While she
 * speaks on this device the mic is gated (silence sent, or her echo filtered and the user's own words interrupt her:
 * barge-in). The stream failing falls back to the server's recording engine, else the browser's recognition.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { realtimeSttToken, RealtimeTokenError, transcribe, type Mate } from "../../api/mates";
import { webSpeechRecognition } from "../../mate/desktop";
import { usePreviewFlags } from "../../mate/livePreview";
import { bcp47 } from "../../mate/useMateConversation";
import { deviceVoicing, hushDevice, recentSpoken } from "../../mate/voiceOwner";
import { MIC_CONSTRAINTS, micErrorKind, micSupported, openMic } from "../../mate/stt/capture";
import { RealtimeStt, TokenError, type RealtimeNotice, type RealtimeState } from "../../mate/stt/realtime";
import { fallbackPlan, type SttFailure } from "../../mate/stt/scribe";
import { browserResults } from "../../mate/stt/browser";
import { tr, useLang } from "../../i18n";

export type MicState = "idle" | "starting" | "recording" | "transcribing";

export interface Mic {
  state: MicState;
  /** why the mic can't be used here (null = it can) */
  unavailable: string | null;
  error: string | null;
  /** what is heard so far (Web Speech: the whole utterance; realtime: the utterance in progress) */
  interim: string;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  clearError: () => void;
  /** realtime engine (ElevenLabs): the live text belongs in the box, utterances come through onSegment */
  realtime: boolean;
  /** Browser and realtime engines finalize segments while listening. */
  segmented: boolean;
  /** the realtime session's phase (null: none / another engine) */
  phase: RealtimeState | null;
  /** something to know that isn't an error (a fallback, reconnected, stopped after a quiet stretch) */
  notice: string | null;
  /** she is speaking on this device: the mic is muted (barge-in off) or listening for an interruption */
  gated: boolean;
  /** mic level 0..1 (realtime) */
  level: number;
  /** auto-send (realtime): each finished utterance goes out by itself */
  autoSend: boolean;
  bargeIn: boolean;
  /** activity (she is answering, the user typed): a quiet stretch starts again */
  touch: () => void;
}

export interface MicOptions {
  /** realtime: a finished utterance (committed text) */
  onSegment?: (text: string) => void;
  onPartial?: (text: string) => void;
  onActivity?: () => void;
  onSpeaking?: (speaking: boolean) => void;
}

const MAX_MS = 60_000;

function recorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* old engines */
    }
  }
  return "";
}

export function micUnavailable(mate: Mate | null): string | null {
  if (!mate) return tr("mate.micNoMate");
  const engine = mate.voice.stt.engine;
  if (engine === "off") return tr("mate.micOff");
  if (engine === "browser") {
    if (!webSpeechRecognition()) return tr("mate.micNoBrowserStt");
    return null;
  }
  if (engine === "elevenlabs") return micSupported() ? null : tr("mate.micNoRecorder");
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
    return tr("mate.micNoRecorder");
  return null;
}

const ENGINE_NAME: Record<string, string> = { whisper: "Whisper", openai: "OpenAI", elevenlabs: "ElevenLabs Scribe" };

/** a realtime failure in the user's words */
export function sttFailureText(code: SttFailure, reason: string): string {
  switch (code) {
    case "missing":
      return tr("mate.sttRtMissing");
    case "auth":
      return tr("mate.sttRtAuth", { reason });
    case "quota":
      return tr("mate.sttRtQuota", { reason });
    case "busy":
      return tr("mate.sttRtBusy");
    case "network":
      return tr("mate.sttRtNetwork", { reason });
    default:
      return tr("mate.sttFailed", { reason });
  }
}

/** the short why of a fallback notice */
const shortWhy = (code: SttFailure): string =>
  code === "auth" ? tr("mate.sttWhyAuth") : code === "quota" ? tr("mate.sttWhyQuota") : code === "missing" ? tr("mate.sttWhyMissing") : code === "busy" ? tr("mate.sttWhyBusy") : tr("mate.sttWhyNetwork");

export function useMic(mate: Mate | null, onText: (text: string) => void, opts: MicOptions = {}): Mic {
  const [browserLive, setBrowserLive] = useState(false);
  const [state, setState] = useState<MicState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [interim, setInterim] = useState("");
  const [phase, setPhase] = useState<RealtimeState | null>(null);
  const [gated, setGated] = useState(false);
  const [level, setLevel] = useState(0);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const onSegmentRef = useRef(opts.onSegment);
  onSegmentRef.current = opts.onSegment;
  const optionsRef = useRef(opts);
  optionsRef.current = opts;
  const rec = useRef<{ stop: () => void; cancel: () => void; touch?: () => void } | null>(null);
  useLang(); // (the reason below is in the UI's language)
  const unavailable = micUnavailable(mate);
  const realtime = mate?.voice.stt.engine === "elevenlabs";

  // Settings → Voice's unsaved toggles apply at once in every window (mate/livePreview), the saved ones after that
  const flags = usePreviewFlags(mate?.id ?? null);
  const autoSend = flags?.sttAutoSend ?? !!mate?.voice.stt.auto_send;
  const bargeIn = flags?.sttBargeIn ?? mate?.voice.stt.barge_in !== false;
  const bargeRef = useRef(bargeIn);
  bargeRef.current = bargeIn;

  const finish = useCallback(() => {
    rec.current = null;
    setBrowserLive(false);
    setState("idle");
    setInterim("");
    optionsRef.current.onPartial?.("");
    optionsRef.current.onSpeaking?.(false);
    setPhase(null);
    setGated(false);
    setLevel(0);
  }, []);

  /** Web Speech recognition (the browser engine, and the realtime engine's last resort) */
  const startBrowser = useCallback(
    (lang: string | undefined, deliver?: (text: string) => void) => {
      const SR = webSpeechRecognition()!;
      const r = new SR();
      r.lang = lang || "";
      r.interimResults = true;
      r.continuous = true;
      let delivered = 0;
      setBrowserLive(true);
      let cancelled = false;
      r.onresult = (e: any) => {
        if (cancelled) return;
        const result = browserResults(e.results, delivered);
        delivered = result.delivered;
        // Clear the old partial before committing; a final will replace it in the persistent draft.
        optionsRef.current.onPartial?.("");
        for (const text of result.finals)
          (deliver ?? onSegmentRef.current ?? onTextRef.current)(text);
        setInterim(result.partial);
        optionsRef.current.onPartial?.(result.partial);
      };
      r.onspeechstart = () => optionsRef.current.onSpeaking?.(true);
      r.onspeechend = () => optionsRef.current.onSpeaking?.(false);
      r.onerror = (e: any) => {
        if (e?.error === "no-speech" || e?.error === "aborted") return;
        setError(
          e?.error === "not-allowed"
            ? tr("mate.micRefused")
            : tr("mate.sttFailed", {
                reason: e?.error || tr("common.unknown"),
              }),
        );
      };
      r.onend = () => {
        finish();
      };
      rec.current = {
        stop: () => r.stop(),
        cancel: () => {
          cancelled = true;
          r.abort();
        },
      };
      setState("recording");
      try {
        r.start();
      } catch (e) {
        finish();
        setError(tr("mate.sttFailed", { reason: (e as Error).message }));
      }
    },
    [finish],
  );

  const start = useCallback(() => {
    if (!mate || rec.current || unavailable) {
      if (unavailable) setError(unavailable);
      return;
    }
    setError(null);
    setNotice(null);
    setInterim("");
    const lang = bcp47(mate.voice.stt.language || mate.persona.language) || undefined;

    if (mate.voice.stt.engine === "browser") return startBrowser(lang);

    if (mate.voice.stt.engine === "elevenlabs") {
      const mateId = mate.id;
      let stopRequested = false;
      const session = new RealtimeStt(
        {
          getToken: async () => {
            try {
              return await realtimeSttToken(mateId);
            } catch (e) {
              if (e instanceof RealtimeTokenError) throw new TokenError(e.message, e.code as SttFailure, e.fallback);
              throw e;
            }
          },
          transcribe: (wav, engine) => transcribe(mateId, wav, engine),
          openMic,
          voicing: () => deviceVoicing(mateId),
          spoken: () => recentSpoken(mateId),
          bargeIn: () => bargeRef.current,
        },
        {
          onState: (s) => {
            setPhase(s);
            if (s === "closed") return finish();
            setState(s === "connecting" ? "starting" : s === "finishing" || s === "transcribing" ? "transcribing" : "recording");
          },
          onPartial: (text) => {setInterim(text); optionsRef.current.onPartial?.(text);},
          onSegment: (text) => onSegmentRef.current?.(text),
          onBargeIn: () => hushDevice(mateId),
          onNotice: (n: RealtimeNotice) =>
            setNotice(
              n.kind === "fallback"
                ? tr("mate.sttFallbackServer", { why: shortWhy(n.code), engine: ENGINE_NAME[n.engine] ?? n.engine })
                : n.kind === "reconnected"
                  ? tr("mate.sttReconnected")
                  : tr("mate.sttIdleStopped"),
            ),
          onError: (code, message, serverFallback) => {
            finish();
            if (code === "mic") {
              const kind = micErrorKind(session.micError);
              setError(
                message === "ended" ? tr("mate.micEnded") : kind === "denied" ? tr("mate.micRefused") : tr("mate.noMic", { reason: message }),
              );
              return;
            }
            const plan = fallbackPlan(code, serverFallback, !!webSpeechRecognition());
            if (plan.kind === "browser" && !stopRequested) {
              setNotice(tr("mate.sttFallbackBrowser", { why: shortWhy(code) }));
              startBrowser(lang, (text) => onSegmentRef.current?.(text));
              return;
            }
            setError(sttFailureText(code, message));
          },
          onLevel: (value) => {setLevel(value); if(value > .025 && !deviceVoicing(mateId)) optionsRef.current.onActivity?.();},
        },
        { idleMs: autoSend ? 90_000 : 40_000 },
      );
      rec.current = {
        stop: () => {
          stopRequested = true;
          void session.stop();
        },
        cancel: () => {
          stopRequested = true;
          session.cancel();
        },
        touch: () => session.touch(),
      };
      setState("starting");
      setPhase("connecting");
      void session.start();
      return;
    }

    // server engines: record, then transcribe
    setState("starting");
    let cancelled = false;
    let stopRequested = false;
    rec.current = {
      stop: () => {
        stopRequested = true;
      },
      cancel: () => {
        cancelled = true;
        stopRequested = true;
      },
    };
    navigator.mediaDevices
      .getUserMedia({ audio: MIC_CONSTRAINTS })
      .then((stream) => {
        const mime = recorderMime();
        const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        const chunks: Blob[] = [];
        const startedAt = Date.now();
        mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        mr.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          clearTimeout(cap);
          if (cancelled || Date.now() - startedAt < 300) return finish();
          const blob = new Blob(chunks, { type: mr.mimeType || mime || "audio/webm" });
          if (!blob.size) return finish();
          setState("transcribing");
          try {
            const r = await transcribe(mate.id, blob);
            finish();
            if (r.text?.trim()) onTextRef.current(r.text.trim());
            else setError(tr("mate.nothingHeard"));
          } catch (e) {
            finish();
            setError(tr("mate.transcribeFailed", { error: (e as Error).message }));
          }
        };
        const cap = setTimeout(() => mr.state === "recording" && mr.stop(), MAX_MS);
        rec.current = {
          stop: () => mr.state === "recording" && mr.stop(),
          cancel: () => {
            cancelled = true;
            if (mr.state === "recording") mr.stop();
          },
        };
        mr.start(250);
        setState("recording");
        if (stopRequested) mr.stop(); // released before the mic opened
      })
      .catch((e: DOMException) => {
        finish();
        if (!cancelled)
          setError(e?.name === "NotAllowedError" ? tr("mate.micRefused") : tr("mate.noMic", { reason: String(e?.message || e) }));
      });
  }, [mate, unavailable, finish, startBrowser, autoSend]);

  const stop = useCallback(() => rec.current?.stop(), []);
  const cancel = useCallback(() => rec.current?.cancel(), []);
  useEffect(()=>window.hrhNative?.onQuitting?.(()=>rec.current?.cancel()),[]);
  const clearError = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);
  const touch = useCallback(() => rec.current?.touch?.(), []);

  // a different mate / unmount: drop the recording
  useEffect(() => () => rec.current?.cancel(), [mate?.id]);

  const live = realtime && state !== "idle";
  // the realtime mic in a page that goes to the background (tab switched, app sent home): finish what was said
  useEffect(() => {
    if (!live) return;
    const hide = () => document.visibilityState === "hidden" && rec.current?.stop();
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", hide);
    };
  }, [live]);

  // "she is speaking here" for the status line (the session itself checks every chunk)
  useEffect(() => {
    if (!live || !mate) return;
    const id = mate.id;
    const t = setInterval(() => setGated(deviceVoicing(id)), 250);
    return () => clearInterval(t);
  }, [live, mate]);

  // a notice fades after a while (an error stays until dismissed)
  useEffect(() => {
    if (!notice || state !== "idle") return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice, state]);

  return { state, unavailable, error, interim, start, stop, cancel, clearError, realtime, segmented: realtime || browserLive, phase, notice, gated, level, autoSend, bargeIn, touch };
}
