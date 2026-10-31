/**
 * Push-to-talk for a mate (docs/mate.md §5): the mate's STT engine decides how — `browser` = Web Speech recognition
 * (only in a real browser: Electron and the Android WebView have none), `openai` / `whisper` = record with
 * MediaRecorder (webm/opus) and POST it to /api/mates/{id}/transcribe.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { transcribe, type Mate } from "../../api/mates";
import { webSpeechRecognition } from "../../mate/desktop";
import { bcp47 } from "../../mate/useMateConversation";

export type MicState = "idle" | "starting" | "recording" | "transcribing";

export interface Mic {
  state: MicState;
  /** why the mic can't be used here (null = it can) */
  unavailable: string | null;
  error: string | null;
  /** what Web Speech heard so far */
  interim: string;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  clearError: () => void;
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
  if (!mate) return "No mate";
  const engine = mate.voice.stt.engine;
  if (engine === "off") return "Voice input is off — choose a speech-to-text engine in Mate settings → Voice.";
  if (engine === "browser") {
    if (!webSpeechRecognition())
      return "This app has no built-in speech recognition — choose OpenAI or Whisper in Mate settings → Voice.";
    return null;
  }
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
    return "This browser can't record audio here (a secure https page is needed).";
  return null;
}

export function useMic(mate: Mate | null, onText: (text: string) => void): Mic {
  const [state, setState] = useState<MicState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [interim, setInterim] = useState("");
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const rec = useRef<{ stop: () => void; cancel: () => void } | null>(null);
  const unavailable = micUnavailable(mate);

  const finish = useCallback(() => {
    rec.current = null;
    setState("idle");
    setInterim("");
  }, []);

  const start = useCallback(() => {
    if (!mate || rec.current || unavailable) {
      if (unavailable) setError(unavailable);
      return;
    }
    setError(null);
    setInterim("");
    const lang = bcp47(mate.voice.stt.language || mate.persona.language) || undefined;

    if (mate.voice.stt.engine === "browser") {
      const SR = webSpeechRecognition()!;
      const r = new SR();
      r.lang = lang || "";
      r.interimResults = true;
      r.continuous = true;
      let finalText = "";
      let cancelled = false;
      r.onresult = (e: any) => {
        let live = "";
        finalText = "";
        for (let i = 0; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) finalText += res[0].transcript;
          else live += res[0].transcript;
        }
        setInterim((finalText + live).trim());
      };
      r.onerror = (e: any) => {
        if (e?.error === "no-speech" || e?.error === "aborted") return;
        setError(
          e?.error === "not-allowed"
            ? "Microphone access was refused."
            : `Speech recognition failed (${e?.error || "unknown"}).`,
        );
      };
      r.onend = () => {
        const text = finalText.trim();
        finish();
        if (!cancelled && text) onTextRef.current(text);
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
        setError(`Speech recognition failed (${(e as Error).message}).`);
      }
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
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
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
            else setError("Didn't catch that — nothing was heard.");
          } catch (e) {
            finish();
            setError(`Transcription failed: ${(e as Error).message}`);
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
          setError(e?.name === "NotAllowedError" ? "Microphone access was refused." : `No microphone (${e?.message || e}).`);
      });
  }, [mate, unavailable, finish]);

  const stop = useCallback(() => rec.current?.stop(), []);
  const cancel = useCallback(() => rec.current?.cancel(), []);
  const clearError = useCallback(() => setError(null), []);

  // a different mate / unmount: drop the recording
  useEffect(() => () => rec.current?.cancel(), [mate?.id]);

  return { state, unavailable, error, interim, start, stop, cancel, clearError };
}
