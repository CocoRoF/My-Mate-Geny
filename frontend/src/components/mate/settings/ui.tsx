import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Icon, { type IconName } from "../../ui/Icon";

export function Section({ title, hint, children, right, testId }: { title: ReactNode; hint?: ReactNode; children: ReactNode; right?: ReactNode; testId?: string }) {
  return (
    <section className="rounded-xl border border-border bg-surface-2/50 p-4" data-testid={testId}>
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-semibold text-content">{title}</h3>
          {hint && <p className="mt-0.5 text-[11.5px] leading-relaxed text-content-faint">{hint}</p>}
        </div>
        {right}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children, as = "label" }: { label: ReactNode; hint?: ReactNode; children: ReactNode; as?: "label" | "div" }) {
  const Tag = as;
  return (
    <Tag className="block">
      <span className="text-[12px] font-medium text-content-dim">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-content-faint">{hint}</span>}
    </Tag>
  );
}

export function Toggle({ on, onChange, label, hint, disabled, testId }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode; disabled?: boolean; testId?: string }) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange(!on)}
        data-testid={testId}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${on ? "bg-accent" : "bg-surface-3 border border-border-strong"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
      </button>
      <span className="min-w-0">
        <span className="block text-[13px] text-content">{label}</span>
        {hint && <span className="block text-[11.5px] text-content-faint">{hint}</span>}
      </span>
    </label>
  );
}

/** Save button + status line: "Saved" for a moment, or the error. */
export function useSaver() {
  const [state, setState] = useState<{ busy: boolean; ok: boolean; err: string | null }>({ busy: false, ok: false, err: null });
  const run = async (fn: () => Promise<unknown>) => {
    setState({ busy: true, ok: false, err: null });
    try {
      await fn();
      setState({ busy: false, ok: true, err: null });
      setTimeout(() => setState((s) => (s.ok ? { ...s, ok: false } : s)), 1800);
      return true;
    } catch (e) {
      setState({ busy: false, ok: false, err: (e as Error).message });
      return false;
    }
  };
  return { ...state, run };
}

export function SaveBar({ saver, onSave, dirty, label = "Save", onReset }: { saver: ReturnType<typeof useSaver>; onSave: () => void; dirty: boolean; label?: string; onReset?: () => void }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-3 rounded-xl bg-surface/90 px-1 py-2 backdrop-blur">
      {saver.err && <span className="min-w-0 flex-1 text-[12px] text-danger break-words">{saver.err}</span>}
      {!saver.err && dirty && <span className="min-w-0 flex-1 text-[11.5px] text-content-faint">Unsaved changes</span>}
      {saver.ok && (
        <span className="inline-flex items-center gap-1 text-[12px] text-success">
          <Icon name="check" size={12} /> Saved
        </span>
      )}
      {onReset && dirty && (
        <button className="btn-ghost" onClick={onReset} disabled={saver.busy}>
          Discard
        </button>
      )}
      <button className="btn-primary" onClick={onSave} disabled={saver.busy || !dirty} data-testid="mate-settings-save">
        {saver.busy && <Icon name="spinner" size={14} spin />} {label}
      </button>
    </div>
  );
}

export function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="text-[12px] text-danger break-words">{text}</p>;
}

/** A provider / install state at a glance. */
export type Status = "ok" | "error" | "off" | "checking" | "warn";

export function StatusBadge({ status, children, testId }: { status: Status; children: ReactNode; testId?: string }) {
  const tone: Record<Status, string> = {
    ok: "border-success/30 bg-success/10 text-success",
    error: "border-danger/30 bg-danger/10 text-danger",
    warn: "border-warning/30 bg-warning/10 text-warning",
    off: "border-border bg-surface-3/60 text-content-faint",
    checking: "border-accent/30 bg-accent-soft text-accent",
  };
  const icon: Record<Status, IconName> = { ok: "check", error: "alert-circle", warn: "warning", off: "ban", checking: "spinner" };
  return (
    <span className={`pill shrink-0 border ${tone[status]}`} data-testid={testId} data-status={status}>
      <Icon name={icon[status]} size={11} spin={status === "checking"} />
      {children}
    </span>
  );
}

/** A highlighted note with an optional action ("Set up in Global settings"). */
export function Banner({ tone = "warn", children, action, testId }: { tone?: "warn" | "info" | "error" | "ok"; children: ReactNode; action?: ReactNode; testId?: string }) {
  const cls = {
    warn: "border-warning/30 bg-warning/[0.07] text-warning",
    info: "border-accent/25 bg-accent-soft text-content-dim",
    error: "border-danger/30 bg-danger/[0.07] text-danger",
    ok: "border-success/30 bg-success/[0.07] text-success",
  }[tone];
  const icon: IconName = tone === "ok" ? "check" : tone === "info" ? "info" : tone === "error" ? "alert-circle" : "warning";
  return (
    <div className={`flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed ${cls}`} data-testid={testId}>
      <Icon name={icon} size={14} className="mt-[3px] shrink-0" />
      <div className="min-w-0 flex-1 basis-48">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** A small text link that looks like one (for "Set up in Global settings"). */
export function LinkButton({ onClick, children, testId }: { onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline" data-testid={testId}>
      {children}
    </button>
  );
}

/** Pick one of a few (effort, mode). Wraps on a phone. */
export function Segmented<T extends string>({ value, options, onChange, testId }: { value: T; options: { id: T; label: ReactNode; title?: string; disabled?: boolean }[]; onChange: (v: T) => void; testId?: string }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-surface/60 p-1" role="radiogroup" data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.id)}
          data-value={o.id}
          className={`rounded-md px-2.5 py-1 text-[12.5px] transition disabled:cursor-not-allowed disabled:opacity-40 ${
            value === o.id ? "bg-accent-soft text-content shadow-[inset_0_0_0_1px_#6e8bff66]" : "text-content-dim hover:bg-surface-3 hover:text-content"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ProgressBar({ value, indeterminate, testId }: { value?: number; indeterminate?: boolean; testId?: string }) {
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={indeterminate ? undefined : Math.round((value ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100} data-testid={testId}>
      {indeterminate ? (
        <div className="absolute inset-y-0 w-1/3 animate-[mate-indeterminate_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
      ) : (
        <div className="h-full rounded-full bg-gradient-to-r from-accent to-cyan transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(1, value ?? 0)) * 100}%` }} />
      )}
      <style>{"@keyframes mate-indeterminate{0%{left:-35%}100%{left:100%}}"}</style>
    </div>
  );
}

export interface PickOption {
  value: string;
  label: string;
  /** a second line (description, labels) */
  sub?: string;
  group?: string;
  badges?: string[];
  disabled?: boolean;
  /** extra text the search matches (language, labels…) */
  keywords?: string;
}

/**
 * A select with search for long lists (voices): the list opens inline under the button (no popover to clip in a
 * scrolling panel or off a phone screen). `right` renders per-row extras (a preview button). `allowCustom`: the
 * search text can be used as the value (an id that isn't listed).
 */
export function SearchSelect({
  value,
  options,
  onChange,
  placeholder = "Choose…",
  empty = "Nothing found.",
  right,
  allowCustom,
  loading,
  testId,
  noneLabel,
}: {
  value: string;
  options: PickOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  empty?: string;
  right?: (o: PickOption) => ReactNode;
  allowCustom?: boolean;
  loading?: boolean;
  testId?: string;
  /** an extra first row that picks "" (e.g. "Default (alloy)") */
  noneLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const searchable = options.length > 7 || !!allowCustom;
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", off);
    document.addEventListener("touchstart", off);
    if (searchable) setTimeout(() => input.current?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", off);
      document.removeEventListener("touchstart", off);
    };
  }, [open, searchable]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return options;
    return options.filter((o) => `${o.label} ${o.value} ${o.sub ?? ""} ${o.keywords ?? ""} ${(o.badges ?? []).join(" ")}`.toLowerCase().includes(t));
  }, [options, q]);
  const cur = options.find((o) => o.value === value);
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setQ("");
  };
  const groups: [string, PickOption[]][] = [];
  for (const o of shown) {
    const g = o.group ?? "";
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(o);
    else groups.push([g, [o]]);
  }
  return (
    <div ref={box} className="relative" data-testid={testId}>
      <button
        type="button"
        className="field flex items-center gap-2 text-left"
        onClick={() => setOpen((x) => !x)}
        aria-expanded={open}
        data-testid={testId ? `${testId}-button` : undefined}
      >
        <span className="min-w-0 flex-1">
          {cur ? (
            <>
              <span className="block truncate">{cur.label}</span>
              {cur.sub && <span className="block truncate text-[11px] text-content-faint">{cur.sub}</span>}
            </>
          ) : value ? (
            <span className="block truncate font-mono text-[12.5px]">{value}</span>
          ) : (
            <span className="block truncate text-content-faint">{noneLabel ?? placeholder}</span>
          )}
        </span>
        {loading ? <Icon name="spinner" size={14} spin className="text-content-faint" /> : <Icon name="chevron-down" size={14} className={`text-content-faint transition ${open ? "rotate-180" : ""}`} />}
      </button>
      {open && (
        <div className="mt-1 overflow-hidden rounded-lg border border-border-strong bg-surface shadow-float animate-fade-in" role="listbox">
          {searchable && (
            <div className="flex items-center gap-2 border-b border-border px-2.5">
              <Icon name="search" size={13} className="text-content-faint" />
              <input
                ref={input}
                className="min-w-0 flex-1 bg-transparent py-2 text-[13px] text-content outline-none placeholder:text-content-faint"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const first = shown.find((o) => !o.disabled);
                    if (first) pick(first.value);
                    else if (allowCustom && q.trim()) pick(q.trim());
                  }
                }}
                placeholder={`Search ${options.length} …`}
                data-testid={testId ? `${testId}-search` : undefined}
              />
            </div>
          )}
          <div className="max-h-72 overflow-y-auto overscroll-contain py-1">
            {noneLabel !== undefined && !q && (
              <Row selected={value === ""} onPick={() => pick("")} label={noneLabel} />
            )}
            {groups.map(([g, items]) => (
              <div key={g || "_"}>
                {g && <div className="px-3 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-content-faint">{g}</div>}
                {items.map((o) => (
                  <Row key={o.value} selected={o.value === value} onPick={() => !o.disabled && pick(o.value)} label={o.label} sub={o.sub} badges={o.badges} disabled={o.disabled} right={right?.(o)} />
                ))}
              </div>
            ))}
            {!shown.length && !(allowCustom && q.trim()) && <p className="px-3 py-2 text-[12px] text-content-faint">{loading ? "Loading…" : empty}</p>}
            {allowCustom && q.trim() && !options.some((o) => o.value === q.trim()) && (
              <Row selected={false} onPick={() => pick(q.trim())} label={`Use “${q.trim()}”`} sub="An id that isn't listed" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ selected, onPick, label, sub, badges, disabled, right }: { selected: boolean; onPick: () => void; label: string; sub?: string; badges?: string[]; disabled?: boolean; right?: ReactNode }) {
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={disabled}
      onClick={onPick}
      className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${disabled ? "cursor-not-allowed opacity-40" : "hover:bg-surface-3"} ${selected ? "bg-accent-soft" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-[13px] text-content">{label}</span>
          {badges?.map((b) => (
            <span key={b} className="rounded bg-surface-3 px-1.5 py-px text-[10px] text-content-dim">
              {b}
            </span>
          ))}
        </div>
        {sub && <div className="truncate text-[11px] text-content-faint">{sub}</div>}
      </div>
      {selected && <Icon name="check" size={13} className="shrink-0 text-accent" />}
      {right && (
        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          {right}
        </div>
      )}
    </div>
  );
}

/** "1.2 MB" */
export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
