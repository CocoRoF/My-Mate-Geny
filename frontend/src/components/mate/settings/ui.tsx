import { useState, type ReactNode } from "react";
import Icon from "../../ui/Icon";

export function Section({ title, hint, children, right }: { title: string; hint?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface-2/50 p-4">
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

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-content-dim">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-content-faint">{hint}</span>}
    </label>
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

export function SaveBar({ saver, onSave, dirty, label = "Save" }: { saver: ReturnType<typeof useSaver>; onSave: () => void; dirty: boolean; label?: string }) {
  return (
    <div className="flex items-center justify-end gap-3">
      {saver.err && <span className="min-w-0 flex-1 text-[12px] text-danger break-words">{saver.err}</span>}
      {saver.ok && (
        <span className="inline-flex items-center gap-1 text-[12px] text-success">
          <Icon name="check" size={12} /> Saved
        </span>
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
