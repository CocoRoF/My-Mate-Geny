/**
 * The app's own "are you sure?" (instead of window.confirm: the app's look and language, a phone too).
 *   if (!(await confirmDialog({ body: t("…"), confirmLabel: t("common.delete"), danger: true }))) return;
 * One host (<ConfirmHost />, main.tsx) shows them one at a time: Esc or a tap outside cancels, Enter confirms (Enter on
 * Cancel cancels), Tab stays on its two buttons, and focus goes back where it was. (Without a host: window.confirm.)
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useT } from "../../i18n";
import Icon from "./Icon";

export interface ConfirmOptions {
  title?: string;
  body: string;
  /** the confirm button (default: OK) */
  confirmLabel?: string;
  cancelLabel?: string;
  /** a destructive action: a red button */
  danger?: boolean;
}

interface Ask extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

const useAsks = create<{ asks: Ask[] }>(() => ({ asks: [] }));
let seq = 0;
let hosts = 0;

export function confirmDialog(o: ConfirmOptions | string): Promise<boolean> {
  const opts = typeof o === "string" ? { body: o } : o;
  if (!hosts) return Promise.resolve(window.confirm(opts.title ? `${opts.title}\n\n${opts.body}` : opts.body));
  return new Promise((resolve) => useAsks.setState((s) => ({ asks: [...s.asks, { ...opts, id: ++seq, resolve }] })));
}

/** `action` once the user confirms (a click handler's one-liner) */
export function ifConfirmed(o: ConfirmOptions | string, action: () => unknown): void {
  void confirmDialog(o).then((ok) => {
    if (ok) void action();
  });
}

function answer(id: number, ok: boolean) {
  const ask = useAsks.getState().asks.find((a) => a.id === id);
  if (!ask) return;
  useAsks.setState((s) => ({ asks: s.asks.filter((a) => a.id !== id) }));
  ask.resolve(ok);
}

export function ConfirmHost() {
  useEffect(() => {
    hosts++;
    return () => {
      hosts--;
      if (!hosts) for (const a of useAsks.getState().asks) answer(a.id, false);
    };
  }, []);
  const ask = useAsks((s) => s.asks[0]);
  return ask ? <Dialog key={ask.id} ask={ask} /> : null;
}

function Dialog({ ask }: { ask: Ask }) {
  const t = useT();
  const ok = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const pressedOutside = useRef(false);

  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ok.current?.focus();
    // (capture: before the screen's own Esc / Enter — a panel under the dialog never closes with it)
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        answer(ask.id, e.key === "Enter" && document.activeElement !== cancel.current);
      } else if (e.key === "Tab") {
        const els = [cancel.current, ok.current].filter((x): x is HTMLButtonElement => !!x);
        const i = els.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length]?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [ask.id]);

  return (
    <div
      className="fixed inset-0 top-[var(--window-chrome-height,0px)] z-[120] flex items-end justify-center bg-scrim/60 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm animate-fade-in sm:items-center sm:p-4"
      onPointerDown={(e) => (pressedOutside.current = e.target === e.currentTarget)}
      onClick={(e) => e.target === e.currentTarget && pressedOutside.current && answer(ask.id, false)}
      data-testid="confirm-dialog"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={ask.title ? "confirm-dialog-title" : "confirm-dialog-body"}
        aria-describedby={ask.title ? "confirm-dialog-body" : undefined}
        className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-border bg-surface-2 p-5 shadow-xl"
      >
        {ask.title && (
          <h2 id="confirm-dialog-title" className="flex items-center gap-2 text-[15px] font-semibold">
            {ask.danger && <Icon name="warning" size={16} className="shrink-0 text-danger" />}
            {ask.title}
          </h2>
        )}
        <p id="confirm-dialog-body" className={`whitespace-pre-line break-words leading-relaxed ${ask.title ? "text-[13px] text-content-dim" : "text-[14px] text-content"}`}>
          {ask.body}
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button ref={cancel} type="button" className="btn-ghost flex-1 sm:flex-none" onClick={() => answer(ask.id, false)} data-testid="confirm-cancel">
            {ask.cancelLabel || t("common.cancel")}
          </button>
          <button
            ref={ok}
            type="button"
            className={`flex-1 sm:flex-none ${ask.danger ? "btn bg-danger/15 text-danger hover:bg-danger/25" : "btn-primary"}`}
            onClick={() => answer(ask.id, true)}
            data-testid="confirm-ok"
          >
            {ask.confirmLabel || t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
