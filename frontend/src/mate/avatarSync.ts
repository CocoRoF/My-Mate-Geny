/**
 * One mate, one face on this computer (docs/mate.md §2 "In step"): the console's stage, the desktop avatar overlay and
 * the mate chat window show her at once — they move together. The window elected to speak for her (mate/voiceOwner:
 * the overlay while it is on screen, else the Mate surface last used) leads; the others follow it over a BroadcastChannel:
 *
 * - her reactions (the faces of a reply, her mood now and then, a tap): the leader decides and tells; a follower shows
 *   what it is told (a tap in a follower is told too, and every window reacts to it);
 * - her clips (the video body): the leader says which clip it starts and when; a follower plays the same one, that far
 *   into it — at the end of its own clip, or at once when it is out of step;
 * - her mouth: the voice says itself, from whichever window plays it (mate/voiceBridge.ts, "hrh-mate-lips").
 *
 * A window with no leader for her (the only one, the others closed) decides by itself, as before.
 */

type Msg =
  | { type: "react"; mateId: string; name: string; from: string }
  | { type: "clip"; mateId: string; clip: string; at: number; from: string };

/** this page (a message it sent itself is not for it) */
const ME = Math.random().toString(36).slice(2, 10);

const channel: BroadcastChannel | null = (() => {
  try {
    return typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("hrh-mate-avatar") : null;
  } catch {
    return null;
  }
})();

const reactFns = new Set<(mateId: string, name: string) => void>();
const clipFns = new Set<(mateId: string, clip: string, at: number) => void>();
/** the leader's last clip for each mate: a body made after it started still joins it */
const lastClip = new Map<string, { clip: string; at: number }>();

const post = (m: Msg) => {
  try {
    channel?.postMessage(m);
  } catch {
    /* closed */
  }
};

if (channel) {
  (channel as unknown as { unref?: () => void }).unref?.(); // (Node — the tests — must not stay up for it)
  channel.onmessage = (e: MessageEvent) => {
    const m = e.data as Msg | null;
    if (!m || typeof m.mateId !== "string" || m.from === ME) return;
    if (m.type === "react" && typeof m.name === "string") reactFns.forEach((f) => f(m.mateId, m.name));
    else if (m.type === "clip" && typeof m.clip === "string" && typeof m.at === "number") {
      lastClip.set(m.mateId, { clip: m.clip, at: m.at });
      clipFns.forEach((f) => f(m.mateId, m.clip, m.at));
    }
  };
}

/** her face reacts (the leader's decision, or a tap here): every other window shows it too */
export function tellReact(mateId: string, name: string): void {
  post({ type: "react", mateId, name, from: ME });
}

/** a reaction told by another window */
export function onReact(fn: (mateId: string, name: string) => void): () => void {
  reactFns.add(fn);
  return () => reactFns.delete(fn);
}

/** the leader started a clip (`at`: when, Date.now()) */
export function tellClip(mateId: string, clip: string, at = Date.now()): void {
  lastClip.set(mateId, { clip, at });
  post({ type: "clip", mateId, clip, at, from: ME });
}

/** a clip the leader started */
export function onClip(fn: (mateId: string, clip: string, at: number) => void): () => void {
  clipFns.add(fn);
  return () => clipFns.delete(fn);
}

/** the leader's latest clip for her (null: none heard yet) */
export const leaderClip = (mateId: string) => lastClip.get(mateId) ?? null;

/** how far into a clip the leader is now (s) */
export const sinceStart = (at: number, now = Date.now()) => Math.max(0, (now - at) / 1000);
