/**
 * The UI's languages (docs/i18n.md): English and 한국어.
 *
 *   const t = useT();                      // in a component: re-renders when the language changes
 *   t("sidebar.newChat")                   // "New chat" / "새 채팅"
 *   t("sidebar.bgTasks", { count: 3 })     // {count} fills in; a { one, other } message picks its plural form
 *   t.rich("banner.change", { b: (s) => <b>{s}</b>, link })  // <b>…</b> tags and {name} → React nodes
 *   tr("common.save")                      // outside React (stores, toasts): the current language
 *
 * Messages live per namespace in `en/<ns>.ts` (the source: its keys are the type `MsgKey`) and `ko/<ns>.ts` (typed
 * against en, so a missing or extra key is a compile error; test/i18n.test.ts checks placeholders too). Only the
 * active language's catalog is loaded (a lazy chunk); main.tsx waits for it before the first render.
 *
 * The choice: localStorage (`hrh_lang`) → instantly on this device; the server (`/api/preferences`) → every device
 * follows; the `hrh_lang` cookie → the server-rendered login page; the desktop app (hrhNative.setLanguage) → its
 * tray, menus and local pages. Without a choice: the browser's language.
 */
import { cloneElement, isValidElement, type ReactNode } from "react";
import { create } from "zustand";
import type { Catalog } from "./en";
import { fillPlaceholders, particle } from "../lib/josa";

export type Lang = "en" | "ko";
export const LANGS: { id: Lang; label: string; english: string }[] = [
  { id: "en", label: "English", english: "English" },
  { id: "ko", label: "한국어", english: "Korean" },
];

export type Plural = { one: string; other: string };
export type Msg = string | Plural;
/** a namespace's messages: the en keys, each a string or a { one, other } plural */
export type Messages<N extends keyof Catalog> = { [K in keyof Catalog[N]]: Msg };
export type Locale = { [N in keyof Catalog]: Messages<N> };
export type MsgKey = { [N in keyof Catalog & string]: `${N}.${keyof Catalog[N] & string}` }[keyof Catalog & string];
export type Vars = Record<string, string | number | null | undefined>;

const STORAGE_KEY = "hrh_lang";
const loaders: Record<Lang, () => Promise<{ default: Locale }>> = {
  en: () => import("./en"),
  ko: () => import("./ko"),
};
const catalogs: Partial<Record<Lang, Locale>> = {};

const isLang = (v: unknown): v is Lang => v === "en" || v === "ko";

function stored(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

/** the browser's / system's language (Korean if it comes first, else English) */
export function systemLang(): Lang {
  const list = typeof navigator !== "undefined" ? [...(navigator.languages || []), navigator.language] : [];
  for (const l of list) {
    if (!l) continue;
    if (/^ko\b/i.test(l)) return "ko";
    if (/^en\b/i.test(l)) return "en";
  }
  return "en";
}

/** BCP-47 tag for Intl (dates, numbers) */
export const localeOf = (lang: Lang) => (lang === "ko" ? "ko-KR" : "en-US");

interface I18nState {
  lang: Lang;
  /** true once the user picked one (here or on another device) — else it follows the system */
  chosen: boolean;
  /** switch now (loads the catalog first); `persist`: save the choice here (localStorage, cookie, desktop app) */
  setLang: (lang: Lang, opts?: { persist?: boolean }) => Promise<void>;
}

async function load(lang: Lang): Promise<Locale | null> {
  if (catalogs[lang]) return catalogs[lang]!;
  for (let i = 0; i < 2; i++) {
    try {
      catalogs[lang] = (await loaders[lang]()).default;
      return catalogs[lang]!;
    } catch {
      /* once more, then the other language */
    }
  }
  return null;
}

function applyDocument(lang: Lang) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
}

function persist(lang: Lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* private mode */
  }
  try {
    // the server-rendered login page reads it (one year, this site only)
    document.cookie = `${STORAGE_KEY}=${lang}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    /* no cookies */
  }
}

/** the desktop app's tray, menus and local pages follow the console's language */
export function tellNative(lang: Lang) {
  try {
    (window.hrhNative as { setLanguage?: (l: string) => void } | undefined)?.setLanguage?.(lang);
  } catch {
    /* an older app */
  }
}

const initial: Lang = stored() ?? systemLang();

export const useI18n = create<I18nState>((set, get) => ({
  lang: initial,
  chosen: stored() !== null,
  setLang: async (lang, opts = {}) => {
    const ok = await load(lang);
    if (!ok) return;
    if (opts.persist !== false) persist(lang);
    applyDocument(lang);
    tellNative(lang);
    if (get().lang !== lang || (opts.persist !== false && !get().chosen)) set({ lang, chosen: get().chosen || opts.persist !== false });
  },
}));

/** before the first render: the active language's messages (falls back to English if its chunk won't load) */
export async function i18nReady(): Promise<void> {
  const lang = useI18n.getState().lang;
  applyDocument(lang);
  if (await load(lang)) return;
  if (lang !== "en" && (await load("en"))) useI18n.setState({ lang: "en" });
}

// another tab / window of this browser (the desktop app's Mate windows) switched: follow it
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY && isLang(e.newValue) && e.newValue !== useI18n.getState().lang) {
      void useI18n.getState().setLang(e.newValue, { persist: false });
    }
  });
}

// ---- formatting ---------------------------------------------------------------------------------------------------

const plurals = new Map<string, Intl.PluralRules>();
function pluralOf(lang: Lang, n: number): "one" | "other" {
  const loc = localeOf(lang);
  let r = plurals.get(loc);
  if (!r) plurals.set(loc, (r = new Intl.PluralRules(loc)));
  return r.select(n) === "one" ? "one" : "other";
}

function lookup(lang: Lang, key: string): Msg | undefined {
  const dot = key.indexOf(".");
  const ns = (catalogs[lang] ?? catalogs.en) as Record<string, Record<string, Msg>> | undefined;
  return ns?.[key.slice(0, dot)]?.[key.slice(dot + 1)];
}

const fmtVar = (lang: Lang, v: string | number | null | undefined) =>
  v == null ? "" : typeof v === "number" ? v.toLocaleString(localeOf(lang)) : v;

/** the message's text for these vars (the plural form by `count`, else by the first number given) */
function pick(lang: Lang, key: string, vars?: Vars): string {
  const m = lookup(lang, key);
  if (m === undefined) return key;
  if (typeof m === "string") return m;
  const n = Number(vars?.count ?? Object.values(vars ?? {}).find((v) => typeof v === "number") ?? 0);
  return pluralOf(lang, n) === "one" ? m.one : m.other;
}

/** `{name}` or `{name:이}` — the value followed by the Korean particle that fits it (이/가, 은/는, 을/를, 과/와, 아/야,
 * (으)로 …: src/lib/josa.ts); English messages never carry a particle, and in English it is ignored anyway. */
const withParticle = (lang: Lang, value: string, p: string | undefined) => (p && lang === "ko" ? value + particle(value, p) : value);

export function translate(lang: Lang, key: MsgKey, vars?: Vars): string {
  const s = pick(lang, key, vars);
  if (!vars) return s;
  return fillPlaceholders(s, (name) => (name in vars ? fmtVar(lang, vars[name]) : undefined), lang === "ko");
}

export type RichVars = Record<string, ReactNode | ((inner: string) => ReactNode)>;

/** `<b>text</b>` → vars.b("text"); `{name}` → vars.name (a node, a string or a number) */
export function translateRich(lang: Lang, key: MsgKey, vars: RichVars): ReactNode[] {
  const s = pick(lang, key, Object.fromEntries(Object.entries(vars).filter(([, v]) => typeof v === "number")) as Vars);
  const out: ReactNode[] = [];
  const re = /<(\w+)>([\s\S]*?)<\/\1>|\{(\w+)(?::([^{}\s]+))?\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const name = m[1] ?? m[3];
    const v = vars[name];
    let node: ReactNode;
    if (m[1] !== undefined) node = typeof v === "function" ? v(m[2]) : m[2];
    else if (typeof v === "function") node = v("");
    else if (typeof v === "number" || typeof v === "string") node = withParticle(lang, fmtVar(lang, v), m[4]);
    else node = v === undefined ? m[0] : m[4] && lang === "ko" ? [v, particle("", m[4])] : v;
    // keyed so React doesn't warn about a list
    out.push(typeof node === "object" && node !== null ? withKey(node, i++) : node);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function withKey(node: ReactNode, i: number): ReactNode {
  return isValidElement(node) && node.key == null ? cloneElement(node, { key: `t${i}` }) : node;
}

export interface TFunction {
  (key: MsgKey, vars?: Vars): string;
  rich: (key: MsgKey, vars: RichVars) => ReactNode[];
  lang: Lang;
  locale: string;
}

const bound = new Map<Lang, TFunction>();
function tFor(lang: Lang): TFunction {
  let f = bound.get(lang);
  if (!f) {
    const fn = ((key: MsgKey, vars?: Vars) => translate(lang, key, vars)) as TFunction;
    fn.rich = (key, vars) => translateRich(lang, key, vars);
    fn.lang = lang;
    fn.locale = localeOf(lang);
    bound.set(lang, (f = fn));
  }
  return f;
}

/** `t` for the current language; the component re-renders when it changes */
export function useT(): TFunction {
  return tFor(useI18n((s) => s.lang));
}

export const useLang = () => useI18n((s) => s.lang);

/** outside React (stores, toasts, notifications): the current language at call time */
export const tr = ((key: MsgKey, vars?: Vars) => translate(useI18n.getState().lang, key, vars)) as TFunction;
tr.rich = (key, vars) => translateRich(useI18n.getState().lang, key, vars);
Object.defineProperties(tr, {
  lang: { get: () => useI18n.getState().lang },
  locale: { get: () => localeOf(useI18n.getState().lang) },
});

/** the current Intl locale ("en-US" / "ko-KR") */
export const currentLocale = () => localeOf(useI18n.getState().lang);
