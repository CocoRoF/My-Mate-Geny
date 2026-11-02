/**
 * What a chat's sidebar row says about its work: working (a turn, or background tasks / subagents), else how its
 * last run ended — Complete / Failed / Stopped — until someone opens the chat (the server keeps `result_unseen`
 * for every device: backend session_service `_record_result` / `mark_seen`). The chat on screen shows none.
 */
import type { Session } from "../types";

export type SessionBadge = "working" | "ok" | "error" | "stopped" | null;

export function sessionBadge(
  s: Pick<Session, "running" | "background" | "result_unseen" | "last_result">,
  onScreen: boolean,
): SessionBadge {
  if (s.running || (s.background ?? 0) > 0) return "working";
  if (onScreen || !s.result_unseen || !s.last_result) return null;
  return s.last_result;
}

/** the chats with a result nobody has seen yet (the list's "N complete") */
export const unseenCount = (sessions: Session[], onScreenId: string | null): number =>
  sessions.filter((s) => {
    const b = sessionBadge(s, s.id === onScreenId);
    return b !== null && b !== "working";
  }).length;
