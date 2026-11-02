/**
 * Her own changes of the conversation style (docs/mate.md "Prompt composition": update_conversation_style): the list
 * per mate (shared by every chip in the conversation and the Conversation style tab's history — one request, fetched
 * again when the server says the style changed), undo / apply / dismiss, and how a change reads ("Speech level →
 * Casual (반말)").
 */
import { useEffect, useState } from "react";
import { listStyleChanges, resolveStyleChange, type StyleChange } from "../api/mates";
import { tr, type MsgKey } from "../i18n";
import { useMateStore } from "../stores/mateStore";

const cache = new Map<string, { rev: number; list: Promise<StyleChange[]> }>();

function fetchChanges(mateId: string, rev: number): Promise<StyleChange[]> {
  const hit = cache.get(mateId);
  if (hit && hit.rev === rev) return hit.list;
  const list = listStyleChanges(mateId);
  cache.set(mateId, { rev, list });
  list.catch(() => cache.delete(mateId));
  return list;
}

/** this mate's changes (newest first); null until loaded */
export function useStyleChanges(mateId: string | null | undefined): StyleChange[] | null {
  const rev = useMateStore((s) => (mateId ? (s.styleRev[mateId] ?? 0) : 0));
  const [list, setList] = useState<StyleChange[] | null>(null);
  useEffect(() => {
    if (!mateId) return;
    let live = true;
    fetchChanges(mateId, rev)
      .then((l) => live && setList(l))
      .catch(() => live && setList((x) => x ?? []));
    return () => {
      live = false;
    };
  }, [mateId, rev]);
  return list;
}

/** undo an applied change / apply or dismiss a proposed one; the mate document and every list follow */
export async function resolveChange(mateId: string, cid: string, action: "undo" | "apply" | "dismiss") {
  const out = await resolveStyleChange(mateId, cid, action);
  useMateStore.getState().upsert(out.mate);
  useMateStore.getState().bumpStyle(mateId);
  return out;
}

/** the change id a tool result names ("… [stc_…] …") */
export const changeIdOf = (output: string | undefined) => /\[(stc_[A-Za-z0-9_-]+)\]/.exec(output || "")?.[1] ?? null;

const FIELD: Record<string, MsgKey> = {
  formality: "mateSettings.styleFormality",
  address: "mateSettings.profCallsYou",
  user_name: "mateSettings.profUserName",
  self_ref: "mateSettings.profSelfRef",
  language: "mateSettings.profReplyLang",
  length: "mateSettings.styleLength",
  emotion: "mateSettings.styleEmotion",
  "tone.warmth": "mateSettings.styleWarmth",
  "tone.humor": "mateSettings.styleHumor",
  "tone.initiative": "mateSettings.styleInitiative",
  speech_style: "mateSettings.styleHabits",
  avoid: "mateSettings.styleAvoid",
};
const ENUM: Record<string, Record<string, MsgKey>> = {
  formality: { auto: "mateSettings.styleAsWritten", haeyo: "mateSettings.styleHaeyo", hapsyo: "mateSettings.styleHapsyo", banmal: "mateSettings.styleBanmal" },
  length: { short: "mateSettings.styleShort", normal: "mateSettings.styleNormal", long: "mateSettings.styleLong" },
  emotion: { "0": "mateSettings.styleEmoOff", "1": "mateSettings.styleEmoSubtle", "2": "mateSettings.styleNormal", "3": "mateSettings.styleEmoExpressive" },
  "tone.warmth": { low: "mateSettings.styleWarmthLow", auto: "mateSettings.styleAsWritten", high: "mateSettings.styleWarmthHigh" },
  "tone.humor": { low: "mateSettings.styleHumorLow", auto: "mateSettings.styleAsWritten", high: "mateSettings.styleHumorHigh" },
  "tone.initiative": { low: "mateSettings.styleInitiativeLow", auto: "mateSettings.styleAsWritten", high: "mateSettings.styleInitiativeHigh" },
};
export const LANG_NAMES: Record<string, string> = {
  ko: "한국어",
  en: "English",
  ja: "日本語",
  zh: "中文",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  pt: "Português",
  vi: "Tiếng Việt",
};

const clip = (s: string, n = 28) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export const fieldLabel = (path: string) => (FIELD[path] ? tr(FIELD[path]) : path);

/** one value as the settings show it */
export function valueLabel(path: string, v: unknown): string {
  const key = ENUM[path]?.[String(v)];
  if (key) return tr(key);
  if (path === "language") return LANG_NAMES[String(v)] ?? String(v);
  const s = String(v ?? "").trim();
  if (!s) return path === "address" || path === "self_ref" ? tr("mateSettings.styleAsWritten") : tr("mateSettings.styleEmpty");
  return `“${clip(s.replace(/\s+/g, " "))}”`;
}

/** "Speech level → Casual (반말) · Calls you → “하렴”" (speech habits / avoid: just the field: the text is long) */
export function describeChanges(changes: Record<string, { from: unknown; to: unknown }> | Record<string, unknown>): string {
  return Object.entries(changes)
    .map(([path, c]) => {
      const to = c && typeof c === "object" && "to" in (c as object) ? (c as { to: unknown }).to : c;
      return path === "speech_style" || path === "avoid" ? fieldLabel(path) : `${fieldLabel(path)} → ${valueLabel(path, to)}`;
    })
    .join(" · ");
}

/** the tool's arguments as the same flat paths the server records (for the chip before the record has loaded) */
export function flatArgs(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["formality", "address", "user_name", "self_ref", "language", "length", "emotion", "speech_style", "avoid"]) {
    if (input[k] !== undefined && input[k] !== null) out[k] = input[k];
  }
  const tone = input.tone as Record<string, unknown> | undefined;
  if (tone && typeof tone === "object") for (const k of ["warmth", "humor", "initiative"]) if (tone[k] != null) out[`tone.${k}`] = tone[k];
  return out;
}
