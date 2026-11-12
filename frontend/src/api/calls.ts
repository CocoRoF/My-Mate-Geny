/** Phone calls with a mate (backend app/routers/mate_calls.py, docs/mate-calls.md). */
import { apiResponse } from "./client";

export interface CallInfo {
  id: string;
  mate_id: string;
  name: string;
  session_id: string;
  /** outgoing: the user called her · incoming: she called the user */
  direction: "outgoing" | "incoming";
  status: "ringing" | "dialing" | "active" | "ended";
  device: string;
  /** why she called: question · work · lonely */
  reason: string;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  end_reason: string;
  error: string;
  model: string;
  engine: string;
}

export interface CallPlan {
  /** realtime: ElevenLabs streaming · record: the page cuts utterances and sends each · browser: Web Speech */
  stt: { mode: "realtime" | "record" | "browser"; engine: string; fallback: string | null };
  tts: { engine: string };
  model: string;
}

/** one call in her conversation (the message's meta.call) */
export interface CallCardData {
  id: string;
  direction: "outgoing" | "incoming";
  status: "talked" | "declined" | "missed" | "cancelled" | "failed";
  reason?: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  end_reason: string;
  duration_s: number;
  transcript: { who: "user" | "mate"; text: string; at?: string; cut?: boolean }[];
  latency?: { n: number; first_audio_ms: number | null; ttft_ms: number | null };
  engine?: string;
  model?: string;
  error?: string;
}

export class CallApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  try {
    const res = await apiResponse(path, { method: "POST", body: JSON.stringify(body) });
    return (await res.json()) as T;
  } catch (e) {
    const err = e as Error & { status?: number };
    throw new CallApiError(err.message, err.status === 409 ? "busy" : err.status === 404 ? "gone" : "error", err.status ?? 0);
  }
}

export const dialMate = (mateId: string, device: string) =>
  post<{ call: CallInfo; plan: CallPlan }>(`/api/mates/${encodeURIComponent(mateId)}/calls`, { device });
export const acceptCall = (id: string, device: string) =>
  post<{ call: CallInfo; plan: CallPlan }>(`/api/mate-calls/${encodeURIComponent(id)}/accept`, { device });
export const declineCall = (id: string) => post<{ call: CallInfo }>(`/api/mate-calls/${encodeURIComponent(id)}/decline`);
export const hangupCall = (id: string) => post<{ call: CallInfo }>(`/api/mate-calls/${encodeURIComponent(id)}/hangup`);
export async function activeCall(): Promise<CallInfo | null> {
  const res = await apiResponse("/api/mate-calls/active");
  return ((await res.json()) as { call: CallInfo | null }).call;
}
