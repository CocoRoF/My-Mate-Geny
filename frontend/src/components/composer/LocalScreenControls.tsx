import type { Mate } from "../../api/mates";
import { useEffect, useState, useSyncExternalStore } from "react";
import { canShareScreen, captureBridge, grabWithBrowser } from "../../mate/screenCapture";
import { approvalSnapshot, answerApproval, beginSharing, setSharingMode, sharingSnapshot, stopSharing, subscribeSharing, type ScreenMode } from "../../mate/localScreen";
import ScreenSharePicker from "../mate/ScreenSharePicker";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";

export function useLocalScreenControls(sid: string, name: string, addFiles: (files: File[]) => void, mate?: Mate) {
  const t = useT();
  const sharing = useSyncExternalStore(subscribeSharing, sharingSnapshot);
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<"once" | "ongoing" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const supported = canShareScreen();
  const active = sharing?.sid === sid;
  const failed = (e: unknown) => {
    if (!["NotAllowedError", "AbortError"].includes((e as DOMException)?.name)) setError(String((e as Error)?.message || t("mate.shareFailed")));
  };
  const start = async (ongoing: boolean) => {
    setError("");
    if (captureBridge()) { setPicker(ongoing ? "ongoing" : "once"); return; }
    setBusy(true);
    try {
      if (ongoing) await beginSharing(sid, name);
      else addFiles([await grabWithBrowser()]);
      setOpen(ongoing);
    } catch (e) { failed(e); } finally { setBusy(false); }
  };
  const ui = <>
    {(supported || sharing) && <div className="border-b border-border/60 px-3 py-2 text-xs" data-testid="local-screen-controls">
      <button type="button" onClick={() => setOpen(!open)} className="flex max-w-full items-center gap-2 text-content-dim" aria-expanded={open}>
        <Icon name="monitor" size={14} className={active ? "text-danger" : "text-content-faint"} />
        <span className="truncate">{active ? t("screen.sharing", { source: sharing.source }) : t("composer.shareScreen")}</span>
        <Icon name={open ? "chevron-down" : "chevron"} size={11} />
      </button>
      {open && <div className="mt-2 space-y-2">
        <p className="text-content-faint">{t("screen.localHint")}</p>
        <div className="flex flex-wrap gap-2">
          {supported && <button type="button" disabled={busy} onClick={() => void start(false)} className="btn-ghost !px-2 !py-1" data-testid="screen-once">{t("screen.once")}</button>}
          {supported && !active && <button type="button" disabled={busy} onClick={() => void start(true)} className="btn-ghost !px-2 !py-1" data-testid="screen-start">{t("screen.start")}</button>}
          {sharing && <button type="button" onClick={stopSharing} className="btn-ghost !px-2 !py-1 text-danger" data-testid="screen-stop">{t("screen.stop")}</button>}
        </div>
        {active && <>
          <label className="flex flex-wrap items-center gap-2">{t("screen.mode")}
            <select value={sharing.mode} onChange={e => setSharingMode(e.target.value as ScreenMode, sharing.interval)} className="min-w-0 max-w-full rounded border border-border bg-surface px-2 py-1" data-testid="screen-mode">
              <option value="ask">{t("screen.ask")}</option>
              <option value="on_turn">{t("screen.onTurn")}</option>
              <option value="observe">{t("screen.observe")}</option>
            </select>
          </label>
          {sharing.mode === "observe" && <label className="flex flex-wrap items-center gap-2">{t("screen.interval")}
            <select value={sharing.interval} onChange={e => setSharingMode("observe", Number(e.target.value))} className="rounded border border-border bg-surface px-2 py-1" data-testid="screen-interval">
              {[60, 180, 300, 600].map(n => <option key={n} value={n}>{t("screen.seconds", { count: n })}</option>)}
            </select>
          </label>}
          <p className="text-content-faint">{t("screen.retention")}</p>
          {sharing.mode === "observe" && <p className="text-warning">{t("screen.costHint")}</p>}
        </>}
        {(error || (active && sharing.error)) && <p role="alert" className="text-danger">{error || sharing?.error}</p>}
      </div>}
    </div>}
    {picker && <ScreenSharePicker mate={mate} onClose={() => setPicker(null)}
      onShot={picker === "once" ? f => { addFiles([f]); setPicker(null); setOpen(false); } : undefined}
      onSelect={picker === "ongoing" ? source => {
        setPicker(null); setBusy(true);
        void beginSharing(sid, name, source).then(() => setOpen(true), failed).finally(() => setBusy(false));
      } : undefined} />}
  </>;
  return { open: supported ? () => setOpen(true) : undefined, ui };
}

/** Always visible even when the user navigates away from the sharing conversation. */
export function ScreenSharingBanner() {
  const t = useT();
  const sharing = useSyncExternalStore(subscribeSharing, sharingSnapshot);
  const approval = useSyncExternalStore(subscribeSharing, approvalSnapshot);
  useEffect(() => {
    if (!approval) return;
    const previous = document.activeElement;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); answerApproval(false); } };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [approval]);
  if (!sharing) return null;
  return <>
    {approval && <div className="fixed inset-0 z-[110] grid place-items-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-label={t("screen.allowRequest", { name: approval.name })} className="w-full max-w-sm space-y-3 rounded-2xl border border-border bg-surface-2 p-4 shadow-float" data-testid="screen-approval">
        <p className="text-sm">{t("screen.allowRequest", { name: approval.name })}</p>
        <p className="break-all text-xs text-content-faint">{approval.source}</p>
        <div className="flex justify-end gap-2">
          <button type="button" autoFocus onClick={() => answerApproval(false)} className="btn-ghost" data-testid="screen-deny">{t("screen.deny")}</button>
          <button type="button" onClick={() => answerApproval(true)} className="btn-primary" data-testid="screen-allow">{t("screen.allowOnce")}</button>
        </div>
      </div>
    </div>}
    <div role="status" data-testid="screen-sharing-banner" className="fixed left-1/2 top-2 z-[100] flex max-w-[94vw] -translate-x-1/2 items-center gap-2 rounded-xl border border-danger/40 bg-surface-2 px-3 py-2 text-xs shadow-float">
    <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger" />
    <span className="min-w-0 truncate" title={`${sharing.name}: ${sharing.source}`}>{sharing.capturing ? t("screen.capturing") : t("screen.sharing", { source: `${sharing.name} · ${sharing.source}` })}</span>
    <button type="button" onClick={stopSharing} className="shrink-0 text-danger underline">{t("screen.stop")}</button>
  </div></>;
}
