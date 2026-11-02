/**
 * The Mate Create studio's fields (the right side): each saves itself (a moment after the last key, or on leaving
 * the field), follows the server while untouched (the agent writing it), and — when the agent filled it — glows
 * briefly and carries a "filled by the agent" badge with Undo (back to what was there before it wrote).
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../../i18n";
import Icon from "../../ui/Icon";

export interface FilledEntry {
  at: string;
  prev: unknown;
}

/** what the fields need from the studio */
export interface FieldsApi {
  filled: Record<string, FilledEntry>;
  /** save one field (a flat path: name, persona.speech, prefs.tone.humor, concept.pitch, …) */
  save: (path: string, value: unknown) => Promise<void>;
  undo: (path: string) => Promise<void>;
  /** when the studio opened: fills older than this don't glow (they were there before) */
  since: number;
}

export const FieldsCtx = createContext<FieldsApi | null>(null);

const SAVE_AFTER_MS = 650;

/** the agent filled this field: the badge, Undo, and whether it should glow now (a fill that just arrived) */
export function useFilled(path: string): { entry: FilledEntry | null; glow: boolean; undo: () => void } {
  const api = useContext(FieldsCtx);
  const entry = api?.filled[path] ?? null;
  const [glow, setGlow] = useState(false);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!entry || entry.at === seen.current) return;
    const fresh = seen.current !== null || Date.parse(entry.at) > (api?.since ?? 0);
    seen.current = entry.at;
    if (!fresh) return;
    setGlow(true);
    const t = setTimeout(() => setGlow(false), 2600);
    return () => clearTimeout(t);
  }, [entry, api?.since]);
  return { entry, glow, undo: () => void api?.undo(path) };
}

export function FilledBadge({ path }: { path: string }) {
  const t = useT();
  const { entry, undo } = useFilled(path);
  if (!entry) return null;
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 py-0.5 pl-2 pr-0.5 text-[10.5px] font-medium text-success" data-testid="studio-filled-badge" data-field={path}>
      <Icon name="sparkles" size={10} /> {t("studio.filledBadge")}
      <button
        type="button"
        onClick={undo}
        className="ml-0.5 rounded-full px-1.5 py-0.5 text-content-dim hover:bg-surface-3 hover:text-content"
        title={t("studio.undoTitle")}
        data-testid="studio-undo"
      >
        {t("studio.undo")}
      </button>
    </span>
  );
}

/** a field's frame: label (+ badge), the control, a hint; glows when the agent just filled it */
export function FieldFrame({ path, label, hint, children, as = "label" }: { path: string; label: ReactNode; hint?: ReactNode; children: ReactNode; as?: "label" | "div" }) {
  const { glow } = useFilled(path);
  const Tag = as;
  return (
    <Tag className={`-m-1.5 block rounded-xl p-1.5 transition-shadow duration-700 ${glow ? "studio-glow" : ""}`} data-field={path}>
      <span className="flex min-h-[22px] items-center gap-2">
        <span className="text-[12px] font-medium text-content-dim">{label}</span>
        <FilledBadge path={path} />
      </span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-content-faint">{hint}</span>}
    </Tag>
  );
}

/** a text that saves itself; `value` is the saved one (the server's) */
export function AutoText({ path, value, multiline = false, rows = 3, placeholder, maxLength, testId, className = "", onLocal }: {
  path: string;
  value: string;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
  testId?: string;
  className?: string;
  /** every keystroke (a live preview next to it) */
  onLocal?: (v: string) => void;
}) {
  const api = useContext(FieldsCtx);
  const [v, setV] = useState(value);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef(v);
  latest.current = v;
  // untouched: follow the server (the agent wrote it, another window changed it)
  useEffect(() => {
    if (!dirty.current) setV(value);
  }, [value]);
  const flush = () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    const next = latest.current;
    void api?.save(path, next).finally(() => {
      if (latest.current === next) dirty.current = false;
    });
  };
  useEffect(() => () => {
    // (leaving the studio with a field half-typed: it is saved too)
    if (dirty.current) flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const change = (s: string) => {
    setV(s);
    onLocal?.(s);
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_AFTER_MS);
  };
  const props = {
    value: v,
    placeholder,
    maxLength,
    onBlur: flush,
    "data-testid": testId,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change(e.target.value),
  };
  return multiline ? (
    <textarea className={`field resize-y leading-relaxed ${className}`} rows={rows} {...props} />
  ) : (
    <input className={`field ${className}`} {...props} />
  );
}

/** a few choices as one row of buttons (saved at once) */
export function Choice<T extends string | number>({ path, value, options, testId }: { path: string; value: T; options: { id: T; label: string }[]; testId?: string }) {
  const api = useContext(FieldsCtx);
  const [v, setV] = useState<T>(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-0.5" role="radiogroup" data-testid={testId}>
      {options.map((o) => (
        <button
          key={String(o.id)}
          type="button"
          role="radio"
          aria-checked={v === o.id}
          className={`rounded-md px-2.5 py-1 text-[12px] transition ${v === o.id ? "bg-accent text-white shadow-sm" : "text-content-dim hover:bg-surface-3 hover:text-content"}`}
          onClick={() => {
            if (v === o.id) return;
            setV(o.id);
            void api?.save(path, o.id);
          }}
          data-value={String(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** the hex colours written in a palette text ("#2B2D42, #F4C7D0 — navy and pink") */
export const swatchesOf = (s: string): string[] => Array.from(new Set((s.match(/#[0-9a-fA-F]{6}\b/g) || []).map((x) => x.toUpperCase()))).slice(0, 6);
