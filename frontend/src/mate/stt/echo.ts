/**
 * The mic must not transcribe the mate's own voice (docs/mate.md §5 "Listening while she speaks"). Three layers:
 *   1. the browser's echo cancellation (getUserMedia echoCancellation / noiseSuppression / autoGainControl) — good for
 *      what the page itself plays, but blind to the OS speech engine (the browser voice) and to loud speakers;
 *   2. while she speaks on this device (any window: mate/voiceOwner) and a short tail after, the gate:
 *      barge-in off → the mic sends silence (her voice never leaves the device);
 *      barge-in on  → audio goes out, but a transcript that is just what she is saying is dropped (echo), and only
 *                     words of the user's own (enough of them) count — they interrupt her (barge-in);
 *   3. committed text from such a stretch keeps only the user's words.
 * Pure (tested in test/mate-stt.test.ts).
 */

/** numbers come back spelled differently ("1" said, "one" heard; "세 시" said, "3시" heard): left out of the comparison */
const NUM_WORDS = new Set(
  "zero one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty hundred thousand first second third".split(" "),
);

/** letters only, lower case, without numbers (what is compared) */
export function normalizeForEcho(s: string): string {
  return (s || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !NUM_WORDS.has(w))
    .map((w) => w.replace(/\p{N}+/gu, ""))
    .join("");
}

function grams(s: string): string[] {
  if (s.length < 2) return s ? [s] : [];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** how much of `heard` is in what she said (0..1): the share of its character pairs found in `spoken` */
export function echoScore(heard: string, spoken: string[]): number {
  const h = normalizeForEcho(heard);
  if (!h) return 0;
  const said = spoken.map(normalizeForEcho).filter(Boolean);
  if (!said.length) return 0;
  const all = said.join("|");
  if (h.length < 2) return all.includes(h) ? 1 : 0;
  const set = new Set(said.flatMap(grams));
  const g = grams(h);
  return g.filter((x) => set.has(x)).length / g.length;
}

const ECHO = 0.6;

/** her words at the start and the end of what was heard, dropped (the user's in the middle stay) */
export function stripEcho(heard: string, spoken: string[]): string {
  if (!spoken.length) return heard.trim();
  const words = heard.trim().split(/\s+/).filter(Boolean);
  const isEcho = (w: string) => {
    const n = normalizeForEcho(w);
    return !n || echoScore(w, spoken) >= ECHO;
  };
  let a = 0;
  let b = words.length;
  while (a < b && isEcho(words[a])) a++;
  while (b > a && isEcho(words[b - 1])) b--;
  return words.slice(a, b).join(" ");
}

/** enough to be someone talking (not a cough, not one stray syllable): 4+ letters, or two words */
export function meaningful(text: string): boolean {
  const n = normalizeForEcho(text);
  if (n.length >= 4) return true;
  return text.trim().split(/\s+/).filter((w) => normalizeForEcho(w)).length >= 2 && n.length >= 3;
}

/** the user's own words in `heard` (after dropping her echo), or "" */
export function userWords(heard: string, spoken: string[]): string {
  const rest = stripEcho(heard, spoken);
  return rest && meaningful(rest) && echoScore(rest, spoken) < 0.5 ? rest : "";
}

export interface GateOptions {
  bargeIn: boolean;
  /** after her voice stops: reverb, the speaker's buffer, the recognizer's lag (ms) */
  tailMs?: number;
}

/**
 * One listening session's view of "is she speaking". `setVoicing` follows the device (every change); `partial` /
 * `committed` filter what the recognizer sends. A segment (one utterance between two commits) that heard her becomes
 * "echo"; once the user's own words show up in it, it is "user" — and if she was still speaking, that is a barge-in.
 */
export class EchoGate {
  bargeIn: boolean;
  tailMs: number;
  private voicing = false;
  private endedAt = -Infinity;
  private segment: "clean" | "echo" | "user" = "clean";

  constructor(o: GateOptions) {
    this.bargeIn = o.bargeIn;
    this.tailMs = o.tailMs ?? 700;
  }

  setVoicing(on: boolean, now: number): void {
    if (this.voicing && !on) this.endedAt = now;
    this.voicing = on;
  }

  /** she is speaking (or just stopped) */
  gated(now: number): boolean {
    return this.voicing || now - this.endedAt < this.tailMs;
  }

  /** send silence instead of the mic (barge-in off, while she speaks) */
  muted(now: number): boolean {
    return !this.bargeIn && this.gated(now);
  }

  /** a live transcript: what to show (null: nothing — it is her) and whether the user just interrupted her */
  partial(text: string, spoken: string[], now: number): { show: string | null; barge: boolean } {
    const g = this.gated(now);
    // barge-in off: the mic sent silence while she spoke — whatever is heard is the user's (said before she began)
    if (!this.bargeIn || (this.segment === "clean" && !g)) return { show: text, barge: false };
    if (this.segment === "user") return { show: stripEcho(text, spoken) || null, barge: false };
    const mine = userWords(text, spoken);
    if (mine) {
      this.segment = "user";
      return { show: mine, barge: this.voicing || g };
    }
    this.segment = "echo";
    return { show: null, barge: false };
  }

  /** a committed transcript: the user's text of it (null: nothing of theirs) */
  committed(text: string, spoken: string[], now: number): string | null {
    const seg = this.segment;
    this.segment = "clean";
    if (!this.bargeIn || (seg === "clean" && !this.gated(now))) return text.trim() || null;
    if (seg === "user") return stripEcho(text, spoken) || null;
    return userWords(text, spoken) || null;
  }
}
