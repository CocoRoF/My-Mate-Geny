/**
 * Going back in a chat (docs/session-timeline.md): the message and everything after it are gone on the server; here what is
 * on screen reloads, and the message comes back to the composer. What was waiting to be sent next comes back with it: it
 * must not go out by itself when the stopped turn ends, and it isn't lost.
 */
import { getHistoryPage, rewindSession } from "../api/sessions";
import { FIRST_TURNS, useChatStore } from "../stores/chatStore";
import { useComposerStore } from "../stores/composerStore";
import { useDraftStore } from "../stores/draftStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTaskStore } from "../stores/taskStore";

/** The chat as the server has it now, if it is the one on screen. */
export async function reloadChat(sid: string): Promise<void> {
  const h = await getHistoryPage(sid, { turns: FIRST_TURNS }, true);
  const chat = useChatStore.getState();
  if (chat.sid !== sid) return;
  chat.reset(sid);
  chat.loadHistory(h);
  useSessionStore.getState().patchLocal(sid, { ...h.session });
  useTaskStore.getState().loadSession(sid).catch(() => {});
}

/** The text a rewound message puts in the composer: it first, then what was queued, then what was being written. */
export function composerAfterRewind(text: string, queued: string[], draft: string): string {
  return [text, ...queued, draft].filter((x) => x.trim()).join("\n\n");
}

export async function rewindTo(sid: string, messageId: string, restoreFiles: boolean): Promise<void> {
  const drafts = useDraftStore.getState();
  const queue = drafts.queues[sid] ?? [];
  drafts.setQueue(sid, []);
  let result;
  try {
    result = await rewindSession(sid, messageId, restoreFiles);
  } catch (e) {
    drafts.setQueue(sid, queue);
    throw e;
  }
  const now = useDraftStore.getState();
  now.setText(sid, composerAfterRewind(result.text, queue.map((q) => q.text), now.drafts[sid]?.text ?? ""));
  useComposerStore.getState().restore(sid, [...result.attachments, ...queue.flatMap((q) => q.attachments)]);
  await reloadChat(sid).catch(() => {}); // (the socket does it too; this one doesn't depend on it being connected)
}
