/**
 * ElevenLabs Scribe v2 Realtime, the wire protocol (docs/mate.md §5; https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime):
 * the frames the page sends and what each server message means for the mic — a live (partial) transcript, a
 * committed one, or a failure with what to do about it (reconnect with a fresh token, fall back, or give up).
 * Pure (tested in test/mate-stt.test.ts).
 */

/** why a realtime session can't go on — the token endpoint's `code` values plus the socket's own */
export type SttFailure =
  | "missing" // no ElevenLabs key in Global settings
  | "auth" // the key is rejected / may not use speech to text / terms not accepted
  | "quota" // out of credits
  | "busy" // rate limited / too many sessions / their queue is full
  | "expired" // the session's time limit (a new session goes on)
  | "input" // the page sent something wrong (a bug): not retried
  | "network" // ElevenLabs can't be reached / the socket dropped
  | "upstream" // their transcriber failed
  | "mic"; // the microphone (permission, no device)

export type ScribeEvent =
  | { type: "started"; sessionId: string }
  | { type: "partial"; text: string }
  | { type: "committed"; text: string }
  | { type: "warning"; message: string }
  | { type: "error"; code: SttFailure; message: string; retry: boolean }
  /** the server ends the session because nothing was said for long (not a failure) */
  | { type: "idle"; message: string }
  | { type: "ignore" };

const ERRORS: Record<string, { code: SttFailure; retry: boolean }> = {
  auth_error: { code: "auth", retry: false },
  unaccepted_terms: { code: "auth", retry: false },
  quota_exceeded: { code: "quota", retry: false },
  rate_limited: { code: "busy", retry: true },
  queue_overflow: { code: "busy", retry: true },
  resource_exhausted: { code: "busy", retry: true },
  session_time_limit_exceeded: { code: "expired", retry: true },
  input_error: { code: "input", retry: false },
  invalid_request: { code: "input", retry: false },
  chunk_size_exceeded: { code: "input", retry: false },
  transcriber_error: { code: "upstream", retry: true },
  error: { code: "upstream", retry: true },
};

/** one server message → what it means */
export function parseScribeMessage(raw: unknown): ScribeEvent {
  let d: Record<string, unknown>;
  try {
    d = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
  } catch {
    return { type: "ignore" };
  }
  if (!d || typeof d !== "object") return { type: "ignore" };
  const t = String(d.message_type ?? "");
  const text = typeof d.text === "string" ? d.text : "";
  switch (t) {
    case "session_started":
      return { type: "started", sessionId: String(d.session_id ?? "") };
    case "partial_transcript":
      return { type: "partial", text };
    case "committed_transcript":
      return { type: "committed", text };
    case "warning":
      return { type: "warning", message: String(d.warning ?? "") };
    case "commit_throttled":
      // (a commit too soon after the last one: the audio stays in the next segment)
      return { type: "warning", message: String(d.error ?? t) };
    case "insufficient_audio_activity":
      return { type: "idle", message: String(d.error ?? t) };
  }
  // committed_transcript_with_timestamps / _entities / edited_transcript: not asked for (would repeat a commit)
  const e = ERRORS[t];
  if (e) return { type: "error", code: e.code, retry: e.retry, message: String(d.error ?? d.message ?? t) };
  return { type: "ignore" };
}

/** a frame of audio (`commit`: end the segment now — a stop) */
export function audioFrame(base64: string, commit = false, sampleRate = 16000): string {
  return JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: base64, commit, sample_rate: sampleRate });
}

/** a WebSocket close the page didn't ask for: what it means */
export function closeFailure(code: number, reason: string): { code: SttFailure; retry: boolean; message: string } {
  // 1008 policy (bad / used token), 4001-4003 auth-ish: a fresh token may still work once
  if (code === 1008 || (code >= 4001 && code <= 4003)) return { code: "auth", retry: true, message: reason || `closed (${code})` }; // i18n-ignore (a technical detail after the translated sentence)
  return { code: "network", retry: true, message: reason || `connection closed (${code})` }; // i18n-ignore
}

/** scripts written without spaces between words (a space would be wrong there) */
const NO_SPACE = /[぀-ヿ㐀-䶿一-鿿＀-￯]/;

/** two pieces of transcript, joined the way the language writes them */
export function joinText(a: string, b: string): string {
  const x = a.replace(/\s+$/, "");
  const y = b.replace(/^\s+/, "");
  if (!x) return y;
  if (!y) return x;
  if (NO_SPACE.test(x[x.length - 1]) && NO_SPACE.test(y[0])) return x + y;
  return `${x} ${y}`;
}

export type FallbackPlan = { kind: "server"; engine: string } | { kind: "browser" } | { kind: "none" };

/**
 * The realtime stream can't be used (`code`): how this recording gets transcribed instead. `server` = the engine the
 * backend offered (Whisper → OpenAI → ElevenLabs' batch model); ElevenLabs' own batch model is no help when the key or
 * the credits are the problem; the browser's Web Speech (where it exists) when the server has nothing.
 */
export function fallbackPlan(code: SttFailure, serverFallback: string | null | undefined, browserStt: boolean): FallbackPlan {
  if (code === "mic") return { kind: "none" }; // no microphone: nothing else can hear either
  const s = serverFallback && !(serverFallback === "elevenlabs" && (code === "auth" || code === "quota" || code === "missing")) ? serverFallback : null;
  if (s) return { kind: "server", engine: s };
  if (browserStt) return { kind: "browser" };
  return { kind: "none" };
}
