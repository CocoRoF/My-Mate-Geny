/**
 * The State tab's pure parts (components/mate/settings/StateTab.tsx; docs/geny-state-system.md): times before and after now
 * in the user's words, the words she is told, a model's reading of a message as chips, a promise's status, what is still
 * with her, each journal entry in one line, a model's judgement of her replies, her temperament's ranges and what of it is
 * the user's own, and a simulation as chart series. Tested in test/gss-format.test.ts.
 */
import type {
  BondAxis,
  GssCriterion,
  GssEntry,
  GssEvalReport,
  GssGrudge,
  GssLayer,
  GssPromise,
  GssReading,
  GssSimPoint,
  GssStep,
  PromiseStatus,
  StateEmotion,
  StateWhy,
  Temperament,
  TemperamentByEmotion,
} from "../api/mates";
import type { MsgKey, TFunction } from "../i18n";
import { stateWhy, whyText } from "./reasons";
import { tieEntryText } from "./ties";

export const EMOTIONS: StateEmotion[] = ["happy", "excited", "shy", "angry", "sad", "lonely", "worried", "sleepy"];
/** the kinds of the journal the user is shown (never "told" — her prompt — nor "eval": the server leaves them out) */
export const LAYERS: GssLayer[] = ["heard", "feeling", "grudge", "bond", "tie", "promise", "episode", "said", "temperament"];
export const CRITERIA: GssCriterion[] = ["persona", "variety", "hurt_and_apology", "address", "own_will", "screen", "limits"];
export const EVENTS = ["ignored", "declined_call", "poke"] as const;
export const PRESETS = ["left_unanswered", "pout_and_sweet", "repeat_offender", "threat_sorry_love"];
export const BOND_AXES: BondAxis[] = ["trust", "romance", "respect"];

export const EMOTION_LABEL: Record<StateEmotion, MsgKey> = {
  happy: "mate.stateHappy",
  excited: "mate.stateExcited",
  shy: "mate.stateShy",
  angry: "mate.stateAngry",
  sad: "mate.stateSad",
  lonely: "mate.stateLonely",
  worried: "mate.stateWorried",
  sleepy: "mate.stateSleepy",
};
export const LAYER_LABEL: Record<GssLayer, MsgKey> = {
  heard: "gss.layerHeard",
  feeling: "gss.layerFeeling",
  grudge: "gss.layerGrudge",
  bond: "gss.layerBond",
  tie: "gss.layerTie",
  promise: "gss.layerPromise",
  episode: "gss.layerEpisode",
  told: "gss.layerTold",
  said: "gss.layerSaid",
  temperament: "gss.layerTemperament",
  eval: "gss.layerEval",
};
export const BOND_LABEL: Record<BondAxis | "affinity", MsgKey> = {
  trust: "gss.bondTrust",
  romance: "gss.bondRomance",
  respect: "gss.bondRespect",
  affinity: "gss.bondAffinity",
};
export const PROMISE_STATUS: Record<PromiseStatus, MsgKey> = {
  open: "gss.promiseOpen",
  overdue: "gss.promiseOverdue",
  kept: "gss.promiseKept",
  broken: "gss.promiseBroken",
  lapsed: "gss.promiseLapsed",
};

export type Tone = "ok" | "warn" | "danger" | "accent" | "muted";
export interface Chip {
  text: string;
  tone: Tone;
}

/** a message by a code of the server's, or `fallback` when it has no words of its own (the code never shows as a key) */
function coded(t: TFunction, key: string, fallback: string, vars?: Record<string, string | number>): string {
  const s = t(key as MsgKey, vars);
  return s === key ? fallback : s;
}
const slug = (code: string) => code.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const pct = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");

// ---- time ------------------------------------------------------------------------------------------------------------

/** "3분 전" / "3시간 후" ("3m ago" / "in 3h"): before now or after it */
export function whenText(t: TFunction, when: string | number, now = Date.now()): string {
  const at = typeof when === "number" ? when : Date.parse(when);
  if (!Number.isFinite(at)) return String(when);
  const s = Math.round((now - at) / 1000);
  const a = Math.abs(s);
  if (a < 5) return t("common.justNow");
  if (s > 0) {
    if (a < 60) return t("common.secondsAgo", { n: a });
    const m = Math.round(a / 60);
    if (m < 60) return t("common.minutesAgo", { n: m });
    const h = Math.round(m / 60);
    if (h < 48) return t("common.hoursAgo", { n: h });
    return t("common.daysAgo", { n: Math.round(h / 24) });
  }
  if (a < 60) return t("gss.inSoon");
  const m = Math.round(a / 60);
  if (m < 60) return t("gss.inMinutes", { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t("gss.inHours", { n: h });
  return t("gss.inDays", { n: Math.round(h / 24) });
}

/** how long ago, from a number of hours (what is still with her) */
export function hoursAgoText(t: TFunction, hours: number): string {
  const h = Math.max(0, hours);
  if (h < 0.1) return t("common.justNow");
  if (h < 1) return t("common.minutesAgo", { n: Math.max(1, Math.round(h * 60)) });
  if (h < 36) return t("common.hoursAgo", { n: Math.round(h) });
  return t("common.daysAgo", { n: Math.round(h / 24) });
}

/** a simulation's time from its start: "시작", "+30분", "+2시간 30분", "+1일 6시간" */
export function afterText(t: TFunction, minute: number): string {
  const total = Math.max(0, Math.round(minute));
  if (total === 0) return t("gss.simStart");
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d) return h ? t("gss.simAfterDH", { d, h }) : t("gss.simAfterD", { d });
  if (h) return m ? t("gss.simAfterHM", { h, m }) : t("gss.simAfterH", { h });
  return t("gss.simAfterM", { m });
}

// ---- words -----------------------------------------------------------------------------------------------------------

/** the word she is told for a value ("a little", "quite", …) in the user's language; one with no words of its own as it is */
export function wordText(t: TFunction, word: string | null | undefined): string {
  const w = str(word);
  if (!w) return "";
  return coded(t, `gss.word_${slug(w)}`, w);
}

/** the word for a feeling: the server's, else the one its value would have (shown from 0.25) */
export function feelingWord(t: TFunction, word: string | null | undefined, v: number): string {
  if (str(word)) return wordText(t, word);
  return v >= 0.7 ? wordText(t, "strongly") : v >= 0.45 ? wordText(t, "quite") : v >= 0.25 ? wordText(t, "a little") : "";
}

/** trust / romance / respect come as 0 – 1 or 0 – 100 (affinity is always 0 – 100): the scale they are on */
export function bondScale(values: (number | null | undefined)[]): 1 | 100 {
  return values.some((v) => typeof v === "number" && v > 1.0001) ? 100 : 1;
}
/** a bond's value as 0 – 100 */
export const bondPercent = (v: number | null | undefined, scale: 1 | 100) => Math.round(Math.max(0, Math.min(100, ((v ?? 0) * 100) / scale)));

/** why (a reason code of her state, a code of the relationship's log, or her own words) */
export function anyWhy(t: TFunction, why: unknown): string {
  if (typeof why === "string") return why ? whyText(t, why) : "";
  if (why && typeof why === "object") return stateWhy(t, why as StateWhy);
  return "";
}

// ---- a reading of their message --------------------------------------------------------------------------------------

const ACT_ALIAS: Record<string, string> = {
  putdown: "put_down",
  demeaning: "put_down",
  brushoff: "brush_off",
  dismissal: "brush_off",
  dismissed: "brush_off",
  dismiss: "brush_off",
  vent: "venting",
  love: "affection",
};
const ACT_TONE: Record<string, Tone> = {
  insult: "danger",
  threat: "danger",
  coercion: "danger",
  put_down: "danger",
  violence: "danger",
  brush_off: "warn",
  apology: "ok",
  affection: "ok",
  compliment: "ok",
  gratitude: "ok",
  flirt: "ok",
  distress: "warn",
};

/** what was promised in it (text, a promise, or just that there was one) */
export function promiseWhat(x: unknown): string {
  if (typeof x === "string") return x.trim();
  if (x && typeof x === "object" && typeof (x as { what?: unknown }).what === "string") return (x as { what: string }).what.trim();
  return "";
}

/** a model's reading as chips: what they did (acts), how strongly, at her or not, sarcastic, owning it, promises */
export function readingChips(t: TFunction, r: GssReading, name = ""): Chip[] {
  const out: Chip[] = [];
  for (const raw of r.acts ?? []) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const a = ACT_ALIAS[slug(raw)] ?? slug(raw);
    out.push({ text: coded(t, `gss.act_${a}`, raw.replace(/_/g, " ")), tone: ACT_TONE[a] ?? "muted" });
  }
  const n = num(r.intensity);
  if (n !== null) out.push({ text: t("gss.readIntensity", { n: pct(n) }), tone: n >= 0.7 ? "warn" : "muted" });
  if (r.aimed === true) out.push({ text: t("gss.readAimed", { name }), tone: "accent" });
  if (r.aimed === false) out.push({ text: t("gss.readNotAimed", { name }), tone: "muted" });
  if (r.sarcastic) out.push({ text: t("gss.readSarcastic"), tone: "warn" });
  if (r.owns) out.push({ text: t("gss.readOwns"), tone: "ok" });
  const promises: [unknown, MsgKey, MsgKey][] = [
    [r.promise, "gss.readPromise", "gss.readPromiseBare"],
    [r.her_promise, "gss.readHerPromise", "gss.readHerPromiseBare"],
    [r.fulfills, "gss.readFulfills", "gss.readFulfillsBare"],
  ];
  for (const [x, withWhat, bare] of promises) {
    if (!x) continue;
    const what = promiseWhat(x);
    out.push({ text: what ? t(withWhat, { what, name }) : t(bare, { name }), tone: "accent" });
  }
  return out;
}

// ---- promises --------------------------------------------------------------------------------------------------------

export function promiseTone(status: PromiseStatus | string): Tone {
  return status === "kept" ? "ok" : status === "broken" ? "danger" : status === "overdue" ? "warn" : status === "open" ? "accent" : "muted";
}
export const promiseStatusText = (t: TFunction, status: string) => coded(t, PROMISE_STATUS[status as PromiseStatus] ?? `gss.promise_${status}`, status);

/** when: settled (kept / broken / lapsed: just when), due (open / overdue), or when it was made; `key` puts {when} in words */
export function promiseWhen(t: TFunction, p: Pick<GssPromise, "status" | "due_at" | "made_at" | "settled_at">, now = Date.now()): { text: string; at: string; key: MsgKey | null } {
  if ((p.status === "kept" || p.status === "broken" || p.status === "lapsed") && p.settled_at) return { text: whenText(t, p.settled_at, now), at: p.settled_at, key: null };
  if (p.due_at) return { text: t("gss.promiseDue", { when: whenText(t, p.due_at, now) }), at: p.due_at, key: "gss.promiseDue" };
  return { text: t("gss.promiseMade", { when: whenText(t, p.made_at, now) }), at: p.made_at, key: "gss.promiseMade" };
}

// ---- what is still with her ------------------------------------------------------------------------------------------

/** what it was, how much, how long ago, the apologies so far ("bare" or owning it) */
export function grudgeParts(t: TFunction, g: GssGrudge): { strength: string; what: string; ago: string; sorry: string; stings: boolean } {
  const stings = g.v >= 0.45;
  const sorry = !g.sorry ? t("gss.grudgeNoSorry") : g.owned ? t("gss.grudgeSorryOwned", { count: g.sorry }) : t("gss.grudgeSorryBare", { count: g.sorry });
  return { strength: stings ? t("gss.grudgeStings") : t("gss.grudgeHeld"), what: stateWhy(t, g.why) || t("gss.grudgeWhatUnknown"), ago: hoursAgoText(t, g.hours), sorry, stings };
}

// ---- the journal -----------------------------------------------------------------------------------------------------

export function filterEntries<T extends Pick<GssEntry, "layer">>(entries: T[], layer: GssLayer | "all"): T[] {
  return layer === "all" ? entries : entries.filter((e) => e.layer === layer);
}

/** the next page goes on after the last one; an entry already there (a refresh in between) isn't there twice */
export function mergeEntries<T extends Pick<GssEntry, "id">>(head: T[], tail: T[]): T[] {
  const seen = new Set(head.map((e) => String(e.id)));
  return [...head, ...tail.filter((e) => !seen.has(String(e.id)))];
}

/** an entry's own code (`kind`) in words, or "" when it has none (the layer says it then) */
export const kindText = (t: TFunction, kind: string | null | undefined) => (str(kind) ? coded(t, `gss.kind_${slug(kind!)}`, "") : "");
export const episodeText = (t: TFunction, kind: string) => coded(t, `gss.episode_${slug(kind)}`, kind.replace(/_/g, " "));

/** what moved in the relationship: each axis present with its change and where it is now */
export function bondChanges(data: Record<string, unknown>): { axis: BondAxis | "affinity"; d: number | null; v: number | null }[] {
  const out: { axis: BondAxis | "affinity"; d: number | null; v: number | null }[] = [];
  const axisOf = str(data.axis);
  for (const axis of [...BOND_AXES, "affinity"] as const) {
    const x = data[axis];
    if (num(x) !== null) out.push({ axis, d: null, v: num(x) });
    else if (x && typeof x === "object") out.push({ axis, d: num((x as { d?: unknown }).d), v: num((x as { v?: unknown }).v) });
    else if (axisOf === axis) out.push({ axis, d: num(data.d), v: num(data.v) });
  }
  return out;
}

const signed = (d: number, digits: number) => `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d).toFixed(digits).replace(/\.0+$/, "")}`;

/** one line of an entry (a reading, a told block and a promise also show more than this) */
export function entryText(t: TFunction, e: Pick<GssEntry, "layer" | "kind" | "data">): string {
  const d = e.data ?? {};
  const why = anyWhy(t, d.why);
  const join = (...xs: string[]) => xs.filter(Boolean).join(" · ");
  switch (e.layer) {
    case "heard":
      return str(d.message) ? `“${str(d.message)}”` : "";
    case "said":
      return str(d.text);
    case "told":
      return num(d.turn) !== null ? t("gss.entryToldTurn", { turn: num(d.turn)! }) : t("gss.entryTold");
    case "feeling": {
      const em = str(d.emotion) as StateEmotion;
      const name = EMOTION_LABEL[em] ? t(EMOTION_LABEL[em]) : str(d.emotion);
      const from = num(d.from);
      const to = num(d.to) ?? num(d.v);
      const move = from !== null && to !== null ? `${to >= from ? "↑" : "↓"} ${pct(from)} → ${pct(to)}` : to !== null ? `${pct(to)}` : "";
      return join(`${name} ${move}`.trim(), why);
    }
    case "grudge": {
      const v = num(d.v);
      const sorry = num(d.sorry);
      return join(
        v !== null ? t("gss.entryGrudge", { n: pct(v) }) : "",
        why,
        sorry ? (d.owned ? t("gss.grudgeSorryOwned", { count: sorry }) : t("gss.grudgeSorryBare", { count: sorry })) : "",
      );
    }
    case "bond": {
      const parts = bondChanges(d).map((c) => {
        // (trust, romance and respect may come as 0 – 1: shown as 0 – 100 like affinity)
        const unit = c.axis !== "affinity" && c.v !== null && c.v <= 1.0001 ? 100 : 1;
        const dd = c.d ? ` ${signed(c.d * unit, 1)}` : "";
        const v = c.v !== null ? ` → ${Math.round(c.v * unit)}` : "";
        return `${t(BOND_LABEL[c.axis])}${dd}${v}`;
      });
      return join(parts.join(", "), why);
    }
    case "promise": {
      const what = str(d.what);
      const status = str(d.status);
      return join(what ? `“${what}”` : "", status ? promiseStatusText(t, status) : "");
    }
    case "episode": {
      const kind = str(d.kind) || str(e.kind);
      return join(kind ? episodeText(t, kind) : "", str(d.text) || str(d.what) || str(d.summary), why);
    }
    case "tie":
      return tieEntryText(t, e.kind, d);
    case "temperament":
      return join(t("gss.entryTemperament"), str(d.by) ? t("gss.entryBy", { by: str(d.by) }) : "");
    case "eval": {
      const r = evalReport(d);
      if (!r) return "";
      return join(r.overall !== null ? t("gss.evalOverall", { n: scoreText(r.overall) }) : "", r.error ? t("gss.evalError", { error: r.error }) : r.summary);
    }
    default:
      return why;
  }
}

// ---- a model judging her replies -------------------------------------------------------------------------------------

/** a criterion in words; one with no words of its own as it came */
export const criterionText = (t: TFunction, c: string) => coded(t, `gss.crit_${slug(c)}`, c.replace(/_/g, " "));
/** "4" / "3.5" */
export function scoreText(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
export function scoreTone(v: number): Tone {
  return v >= 4 ? "ok" : v >= 3 ? "muted" : v >= 2 ? "warn" : "danger";
}

/** a report as it came (the evaluate call, or a journal entry's data), well-formed: scores 1 – 5 in the criteria's order
 *  (then any others), findings that say something; null when it isn't one */
export function evalReport(x: unknown): (GssEvalReport & { order: string[] }) | null {
  if (!x || typeof x !== "object") return null;
  const src = x as Record<string, unknown>;
  const raw = src.scores && typeof src.scores === "object" ? (src.scores as Record<string, unknown>) : {};
  const scores: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = num(v);
    if (n !== null) scores[k] = Math.max(1, Math.min(5, n));
  }
  const order = [...CRITERIA.filter((c) => c in scores), ...Object.keys(scores).filter((k) => !(CRITERIA as string[]).includes(k))];
  const findings = (Array.isArray(src.findings) ? src.findings : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({ turn: num(f.turn) ?? 0, criterion: str(f.criterion), quote: str(f.quote), issue: str(f.issue) }))
    .filter((f) => f.quote || f.issue);
  const overall = num(src.overall);
  const error = str(src.error);
  if (!order.length && !findings.length && overall === null && !str(src.summary) && !error) return null;
  return {
    scores,
    order,
    overall: overall === null ? null : Math.max(1, Math.min(5, overall)),
    findings,
    summary: str(src.summary),
    exchanges: num(src.exchanges) ?? 0,
    ...(error ? { error } : {}),
  };
}

// ---- temperament -----------------------------------------------------------------------------------------------------

export type EmotionKnob = "base" | "rise" | "settle";
export type ScalarKnob = "forgives" | "holds" | "sweet_until";
export const RANGES: Record<EmotionKnob | ScalarKnob, [number, number]> = {
  base: [0, 0.3],
  rise: [0.5, 1.8],
  settle: [0.4, 2.0],
  forgives: [0.5, 1.6],
  holds: [0.4, 2.0],
  sweet_until: [0.05, 0.45],
};
/** what a value is when her temperament doesn't say (state.py: anyone else) */
export const NEUTRAL: Record<EmotionKnob | ScalarKnob, number> = { base: 0, rise: 1, settle: 1, forgives: 1, holds: 1, sweet_until: 0.15 };
export const CONFLICTS = ["confront", "withdraw"] as const;
export const ATTACHMENTS = ["secure", "anxious", "avoidant"] as const;

const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, [lo, hi]: [number, number]) => round2(Math.max(lo, Math.min(hi, v)));

/** what lights her up, as words: a list, or the pattern the bundled ones are written as ("게임|버그|\\braid\\b") */
export function normalizeLoves(x: unknown): string[] {
  const raw = Array.isArray(x) ? x.filter((w): w is string => typeof w === "string") : typeof x === "string" ? x.split("|") : [];
  const out: string[] = [];
  for (const w of raw) {
    const word = w.replace(/\\b|[\\^$()[\]?*+{}]/g, "").trim().slice(0, 40);
    if (word && !out.includes(word)) out.push(word);
  }
  return out.slice(0, 60);
}

/** only what a temperament can hold, each within its range */
export function cleanTemperament(x: unknown): Temperament {
  const src = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const out: Temperament = {};
  for (const k of ["base", "rise", "settle"] as const) {
    const m = src[k];
    if (!m || typeof m !== "object") continue;
    const per: TemperamentByEmotion = {};
    for (const e of EMOTIONS) {
      const v = num((m as Record<string, unknown>)[e]);
      if (v !== null) per[e] = clamp(v, RANGES[k]);
    }
    if (Object.keys(per).length) out[k] = per;
  }
  for (const k of ["forgives", "holds", "sweet_until"] as const) {
    const v = num(src[k]);
    if (v !== null) out[k] = clamp(v, RANGES[k]);
  }
  if ((CONFLICTS as readonly unknown[]).includes(src.conflict)) out.conflict = src.conflict as Temperament["conflict"];
  if ((ATTACHMENTS as readonly unknown[]).includes(src.attachment)) out.attachment = src.attachment as Temperament["attachment"];
  if (src.loves !== undefined && src.loves !== null) out.loves = normalizeLoves(src.loves);
  return out;
}

/** a value in effect (its neutral one when the temperament doesn't say) */
export function knob(temp: Temperament, k: EmotionKnob | ScalarKnob, emotion?: StateEmotion): number {
  if (k === "base" || k === "rise" || k === "settle") return (emotion ? temp[k]?.[emotion] : undefined) ?? NEUTRAL[k];
  return temp[k] ?? NEUTRAL[k];
}

/** is it the user's own (prefs.temperament)? */
export function isCustom(custom: Temperament, k: keyof Temperament, emotion?: StateEmotion): boolean {
  if (k === "base" || k === "rise" || k === "settle") return emotion ? custom[k]?.[emotion] !== undefined : !!custom[k] && Object.keys(custom[k]!).length > 0;
  return custom[k] !== undefined;
}

const sameList = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x, i) => x === b[i]);

/** what to save as the user's own: what was theirs already, and whatever the form now has that differs from what is in
 *  effect (so the rest stays her character's, and follows it) */
export function overrideOf(draft: Temperament, effective: Temperament, custom: Temperament): Temperament {
  const out: Temperament = {};
  for (const k of ["base", "rise", "settle"] as const) {
    const per: TemperamentByEmotion = {};
    for (const e of EMOTIONS) {
      const v = knob(draft, k, e);
      if (custom[k]?.[e] !== undefined || Math.abs(v - knob(effective, k, e)) > 0.001) per[e] = v;
    }
    if (Object.keys(per).length) out[k] = per;
  }
  for (const k of ["forgives", "holds", "sweet_until"] as const) {
    const v = knob(draft, k);
    if (custom[k] !== undefined || Math.abs(v - knob(effective, k)) > 0.001) out[k] = v;
  }
  for (const k of ["conflict", "attachment"] as const) {
    const v = draft[k];
    if (v && (custom[k] !== undefined || v !== effective[k])) (out as Record<string, unknown>)[k] = v;
  }
  if (custom.loves !== undefined || !sameList(draft.loves, effective.loves)) out.loves = [...(draft.loves ?? [])];
  return cleanTemperament(out);
}

/** the same temperament (for "is the form changed") */
export function sameTemperament(a: Temperament, b: Temperament): boolean {
  const norm = (x: Temperament) => {
    const c = cleanTemperament(x);
    const o: Record<string, unknown> = {};
    for (const k of ["base", "rise", "settle"] as const) for (const e of EMOTIONS) o[`${k}.${e}`] = knob(c, k, e);
    for (const k of ["forgives", "holds", "sweet_until"] as const) o[k] = knob(c, k);
    o.conflict = c.conflict ?? "";
    o.attachment = c.attachment ?? "";
    o.loves = (c.loves ?? []).join("\n");
    return JSON.stringify(o);
  };
  return norm(a) === norm(b);
}

// ---- the simulator ---------------------------------------------------------------------------------------------------

/** what is still with her at a point (0 – 1) */
export function pointGrudge(p: Pick<GssSimPoint, "grudge">): number {
  const g = p.grudge;
  if (typeof g === "number") return g;
  return g && typeof g === "object" ? (num(g.v) ?? 0) : 0;
}

export const SIM_FEELINGS = ["angry", "sad", "happy", "lonely"] as const;

/** the curves: x in seconds from the start (the chart's time), feelings and what is still with her 0 – 100, the
 *  relationship 0 – 100 */
export function simSeries(points: GssSimPoint[]) {
  const scale = bondScale(points.flatMap((p) => BOND_AXES.map((a) => p.bonds?.[a])));
  return {
    t: points.map((p) => Math.round(p.minute * 60)),
    feelings: Object.fromEntries(SIM_FEELINGS.map((e) => [e, points.map((p) => pct(p.feelings?.[e] ?? 0))])) as Record<(typeof SIM_FEELINGS)[number], number[]>,
    grudge: points.map((p) => pct(pointGrudge(p))),
    bonds: Object.fromEntries(BOND_AXES.map((a) => [a, points.map((p) => (p.bonds?.[a] === undefined ? null : bondPercent(p.bonds[a], scale)))])) as Record<BondAxis, (number | null)[]>,
    affinity: points.map((p) => (num(p.bonds?.affinity) === null ? null : Math.round(p.bonds.affinity!))),
  };
}

/** "1, 6, 24" → [1, 6, 24]: hours to look in on her afterwards (positive, at most 30 days, at most 12 of them) */
export function parseHours(text: string): number[] {
  const out = text
    .split(/[\s,;/]+/)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0 && x <= 720)
    .map(round2);
  return [...new Set(out)].sort((a, b) => a - b).slice(0, 12);
}

/** the steps that say or do something, each well-formed */
export function cleanSteps(steps: GssStep[]): GssStep[] {
  const out: GssStep[] = [];
  for (const s of steps) {
    const say = str(s.say);
    const reply = str(s.reply);
    const event = (EVENTS as readonly string[]).includes(s.event ?? "") ? s.event : undefined;
    if (!say && !reply && !event) continue;
    const after = Number.isFinite(s.after_min) ? Math.max(0, Math.min(20160, Math.round(s.after_min))) : 0;
    out.push({ after_min: after, ...(event ? { event } : { ...(say ? { say } : {}), ...(reply ? { reply } : {}) }) });
  }
  return out;
}
