import type { MessageMeta } from "../stores/chatStore";

/** Delete is on the user's own words, once stored — not on what a mate sent, the app made, speech still being heard,
 *  or what is gone already (backend services/hidden_messages.py) */
export const deletable = (messageId: string | undefined, meta: MessageMeta | undefined) =>
  !!messageId && !meta?.via && !meta?.internal && !meta?.speech_pending && !meta?.hidden;
