/** Last conversation on this device and server. Background windows never select the startup screen. */
import type { Loc } from "./navUrl";

export const LAST_CONVERSATION_KEY = "hrh_last_conversation";
export type LastConversation = { kind: "chat" | "mate"; id: string };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function readLastConversation(storage?: Storage): LastConversation | null {
  try {
    const raw = (storage ?? localStorage).getItem(LAST_CONVERSATION_KEY);
    const value = raw ? JSON.parse(raw) : null;
    if (value?.version !== 1 || !["chat", "mate"].includes(value.kind) || typeof value.id !== "string" || !value.id.trim() || value.id.length > 256) return null;
    return { kind: value.kind, id: value.id };
  } catch {
    return null;
  }
}

export function rememberConversation(value: LastConversation, storage?: Storage): void {
  try {
    (storage ?? localStorage).setItem(LAST_CONVERSATION_KEY, JSON.stringify({ version: 1, ...value }));
  } catch {
    // A blocked/full device store must never prevent navigation or sending.
  }
}

/** Only a fresh app launch at its root restores the last conversation. Explicit links keep their target. */
export function startupConversation(search: string, saved: LastConversation | null): LastConversation | null {
  return new URLSearchParams(search).size === 0 ? saved : null;
}

export function conversationLocation(value: LastConversation): Loc {
  return { view: value.kind, session: value.kind === "chat" ? value.id : null, tab: null };
}
