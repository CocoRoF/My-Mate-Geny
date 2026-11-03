import DeviceCaptureSettings from "./DeviceCaptureSettings";
import { desktopMate, currentSurface } from "../../mate/desktop";
import type { Mate } from "../../api/mates";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  canShareScreen,
  captureBridge,
  grabWithBrowser,
} from "../../mate/screenCapture";
import {
  approvalSnapshot,
  answerApproval,
  beginSharing,
  configureProactive,
  setSharingMode,
  sharingSnapshot,
  stopSharing,
  subscribeSharing,
  type ScreenMode,
} from "../../mate/localScreen";
import ScreenSharePicker from "../mate/ScreenSharePicker";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";

export function useLocalScreenControls(
  sid: string,
  name: string,
  addFiles: (files: File[]) => void,
  mate?: Mate,
) {
  const t = useT();
  const sharing = useSyncExternalStore(subscribeSharing, sharingSnapshot);
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<"once" | "ongoing" | "choose" | null>(
    null,
  );
  useEffect(() => {
    const m = desktopMate();
    if (!m || currentSurface() !== "mate-chat") return;
    const open = () => {
      setOpen(true);
      void m.screenHandled?.();
    };
    void m.getState().then((s) => {
      if ((s as typeof s & { screenPicker?: boolean }).screenPicker) open();
    });
    return m.onCommand((cmd) => {
      if (cmd.type === "screen.open") open();
    });
  }, []);
  const [mode, setMode] = useState<ScreenMode>("ask");
  const [interval, setIntervalValue] = useState(180);
  const p = mate?.prefs?.proactive;
  useEffect(() => {
    configureProactive(sid, !!p?.enabled, p?.interval || 180);
  }, [sid, p?.enabled, p?.interval]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const supported = canShareScreen();
  const active = sharing?.sid === sid;
  const failed = (e: unknown) => {
    if (!["NotAllowedError", "AbortError"].includes((e as DOMException)?.name))
      setError(String((e as Error)?.message || t("mate.shareFailed")));
  };
  const start = async (ongoing: boolean) => {
    setError("");
    if (captureBridge()) {
      setPicker(ongoing ? "ongoing" : "once");
      return;
    }
    setBusy(true);
    try {
      if (ongoing) {
        await beginSharing(sid, name);
        setSharingMode(mode, interval);
      } else addFiles([await grabWithBrowser()]);
      setOpen(false);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const ui = (
    <>
      {(supported || sharing) && (
        <div
          className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs"
          data-screen-proactive={p?.enabled ? p.interval : 0} data-testid="local-screen-controls"
        >
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2 text-content-dim"
            data-testid="screen-setup-open"
          >
            <Icon
              name="monitor"
              size={14}
              className={active ? "text-danger" : "text-content-faint"}
            />
            <span className="truncate">
              {active
                ? t("screen.sharing", { source: sharing.source })
                : t("composer.shareScreen")}
            </span>
          </button>
          {active && (
            <button
              type="button"
              onClick={stopSharing}
              className="shrink-0 text-danger"
              data-testid="screen-stop"
            >
              {t("screen.stop")}
            </button>
          )}
          {(error || (active && sharing.error)) && (
            <span
              role="alert"
              className="text-danger"
              title={error || sharing?.error}
            >
              <Icon name="warning" size={13} />
            </span>
          )}
        </div>
      )}
      {open && (
        <div
          className="fixed inset-0 z-[105] grid place-items-center bg-black/40 p-3"
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
          data-testid="screen-setup"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("screen.setup")}
            className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface-2 shadow-float"
          >
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Icon name="monitor" size={16} />
              <h2 className="flex-1 text-sm font-semibold">
                {t("screen.setup")}
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="btn-ghost"
                aria-label={t("common.cancel")}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="space-y-3 overflow-y-auto p-4 text-xs">
              <p className="text-content-faint">{t("screen.localHint")}</p>
              <label className="flex items-center justify-between gap-2">
                {t("screen.mode")}
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as ScreenMode)}
                  className="rounded border border-border bg-surface px-2 py-1"
                  data-testid="screen-mode"
                >
                  <option value="ask">{t("screen.whenRequested")}</option>
                  <option value="on_turn">{t("screen.onTurn")}</option>
                  {!mate && (
                    <option value="observe">{t("screen.observe")}</option>
                  )}
                </select>
              </label>
              {!mate && mode === "observe" && (
                <label>
                  {t("screen.interval")}{" "}
                  <select
                    value={interval}
                    onChange={(e) => setIntervalValue(Number(e.target.value))}
                    data-testid="screen-interval"
                  >
                    {[60, 180, 300, 600].map((n) => (
                      <option key={n} value={n}>
                        {t("screen.seconds", { count: n })}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {mate && (
                <p
                  className={p?.enabled ? "text-warning" : "text-content-faint"}
                >
                  {p?.enabled
                    ? t("screen.proactiveActive", { count: p.interval })
                    : t("screen.proactiveSetupHint")}
                </p>
              )}
              <DeviceCaptureSettings />
              <p className="text-content-faint">{t("screen.retention")}</p>
              {mode === "observe" && (
                <p className="text-warning">{t("screen.costHint")}</p>
              )}
              {error && (
                <p role="alert" className="text-danger">
                  {error}
                </p>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border p-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="btn-ghost"
              >
                {t("common.cancel")}
              </button>
              {active ? (
                <button
                  type="button"
                  onClick={() => {
                    setSharingMode(mode, interval);
                    setOpen(false);
                  }}
                  className="btn-primary"
                  data-testid="screen-apply"
                >
                  {t("screen.apply")}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      void start(false);
                    }}
                    className="btn-ghost"
                    data-testid="screen-once"
                  >
                    {t("screen.once")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      void start(true);
                    }}
                    className="btn-primary"
                    data-testid="screen-start"
                  >
                    {t("screen.start")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {picker && (
        <ScreenSharePicker
          mate={mate}
          onClose={() => setPicker(null)}
          onShot={
            picker !== "ongoing"
              ? (f) => {
                  addFiles([f]);
                  setPicker(null);
                  setOpen(false);
                }
              : undefined
          }
          onSelect={
            picker !== "once"
              ? (source) => {
                  setPicker(null);
                  setBusy(true);
                  void beginSharing(sid, name, source)
                    .then(() => {
                      setSharingMode(mode, interval);
                      setOpen(false);
                    }, failed)
                    .finally(() => setBusy(false));
                }
              : undefined
          }
        />
      )}
    </>
  );
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
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        answerApproval(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [approval]);
  if (!sharing) return null;
  return (
    <>
      {approval && (
        <div className="fixed inset-0 z-[110] grid place-items-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("screen.allowRequest", { name: approval.name })}
            className="w-full max-w-sm space-y-3 rounded-2xl border border-border bg-surface-2 p-4 shadow-float"
            data-testid="screen-approval"
          >
            <p className="text-sm">
              {t("screen.allowRequest", { name: approval.name })}
            </p>
            <p className="break-all text-xs text-content-faint">
              {approval.source}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => answerApproval(false)}
                className="btn-ghost"
                data-testid="screen-deny"
              >
                {t("screen.deny")}
              </button>
              <button
                type="button"
                onClick={() => answerApproval(true)}
                className="btn-primary"
                data-testid="screen-allow"
              >
                {t("screen.allowOnce")}
              </button>
            </div>
          </div>
        </div>
      )}
      {currentSurface() !== "mate-chat" && (
        <div
          role="status"
          data-testid="screen-sharing-banner"
          className="fixed left-1/2 top-2 z-[100] flex max-w-[94vw] -translate-x-1/2 items-center gap-2 rounded-xl border border-danger/40 bg-surface-2 px-3 py-2 text-xs shadow-float"
        >
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger" />
          <span
            className="min-w-0 truncate"
            title={`${sharing.name}: ${sharing.source}`}
          >
            {sharing.capturing
              ? t("screen.capturing")
              : t("screen.sharing", {
                  source: `${sharing.name} · ${sharing.source}`,
                })}
          </span>
          <button
            type="button"
            onClick={stopSharing}
            className="shrink-0 text-danger underline"
          >
            {t("screen.stop")}
          </button>
        </div>
      )}
    </>
  );
}
