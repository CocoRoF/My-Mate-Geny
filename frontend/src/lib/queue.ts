/**
 * The composer's queue (components/composer/useComposer.ts): messages that go out one per turn, each once the run
 * before it has ended. A message the server didn't take — sent while a run was still on, or a steer the turn could no
 * longer take — was meant to go now, so it goes back first, ahead of what was queued for later.
 */
import type { Attachment } from "../types";
import type { QueuedMessage } from "../stores/draftStore";

let seq = 0;
const newId = () => `q${Date.now().toString(36)}${(++seq).toString(36)}`;

/** `items` first (in their order), then the queue as it was. */
export function putFirst(queue: QueuedMessage[], items: { text: string; attachments: Attachment[] }[]): QueuedMessage[] {
  return [...items.map((m) => ({ id: newId(), text: m.text, attachments: m.attachments })), ...queue];
}

/** At the end, for after the current run. */
export function putLast(queue: QueuedMessage[], item: { text: string; attachments: Attachment[] }): QueuedMessage[] {
  return [...queue, { id: newId(), text: item.text, attachments: item.attachments }];
}

/** The queue's next message may go now: no run is on (by the server's word, and none shown here), and the socket is up. */
export function readyToSend(s: { isStreaming: boolean; runActive: boolean; connection: string; queued: number }): boolean {
  return !s.isStreaming && !s.runActive && s.connection === "open" && s.queued > 0;
}
