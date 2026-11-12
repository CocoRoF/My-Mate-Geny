import {useDevicePreferences} from "../../stores/devicePreferences";
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
  sharingSnapshot,
  subscribeSharing,
} from "../../mate/localScreen";
import ScreenSharePicker from "../mate/ScreenSharePicker";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";

export function useLocalScreenControls(
  sid: string,
  name: string,
  addFiles: (files: File[]) => void,
  mate?: Mate,
  options: {listenToolbar?:boolean;allowOnce?:boolean} = {},
) {
  const t = useT();
  const device = useDevicePreferences();
  const sharing = useSyncExternalStore(subscribeSharing, sharingSnapshot);
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<"once" | "ongoing" | "choose" | null>(
    null,
  );
  useEffect(() => {
    const m = desktopMate();
    if (options.listenToolbar === false || !m || currentSurface() !== "mate-chat") return;
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
  const mode = device.sharing.mode;
  const fallback = mate?.prefs?.proactive;
  const p = fallback ? {...fallback,enabled:device.screen.proactive_enabled ?? fallback.enabled,interval:device.screen.proactive_enabled === null ? fallback.interval : device.screen.proactive_interval} : undefined;
  useEffect(() => {
    if (mate) configureProactive(sid, !!p?.enabled, p?.interval || 180);
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
        await beginSharing(sid, name,undefined,false,mate?.id);
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
                aria-label={t("common.close")}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="space-y-3 overflow-y-auto p-4 text-xs">
              <p className="text-content-faint">{t("screen.localHint")}</p>
              {captureBridge() && !captureBridge()?.resume && <p className="text-warning">{t("screen.updateApp")}</p>}
              <DeviceCaptureSettings mate={mate} part="share"/>
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
              {!active && <button
                type="button"
                onClick={() => setOpen(false)}
                className="btn-ghost"
              >
                {t("common.close")}
              </button>}
              {active ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                  }}
                  className="btn-primary"
                  data-testid="screen-apply"
                >
                  {t("common.done")}
                </button>
              ) : (
                <>
                  {options.allowOnce !== false && <button
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
                  </button>}
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
              ? (files) => {
                  addFiles(files);
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
                  void beginSharing(sid, name, source,false,mate?.id)
                    .then(() => {
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

/** Render only a pending capture-consent dialog; never reserve composer space. */
export function ScreenCaptureApproval() {
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
  if (!sharing || !approval) return null;
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

    </>
  );
}
