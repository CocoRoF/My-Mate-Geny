import { useDevicePreferences } from "../../stores/devicePreferences";
import { desktopMate, currentSurface } from "../../mate/desktop";
import type { Mate } from "../../api/mates";
import { useEffect, useState, useSyncExternalStore } from "react";
import { canShareScreen, captureBridge, type CaptureSource } from "../../mate/screenCapture";
import {
  approvalSnapshot,
  answerApproval,
  beginSharing,
  configureProactive,
  sharingSnapshot,
  stopSharing,
  subscribeSharing,
} from "../../mate/localScreen";
import ScreenSharePicker from "../mate/ScreenSharePicker";
import { toast } from "../../lib/toast";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";

/**
 * Share screen (the composer's + menu; in the desktop app also the avatar toolbar's screen button and the chat
 * window's toolbar, `screen.open`). One press, one choice: the desktop app's picker of screens and windows
 * (ScreenSharePicker), or in a browser its own getDisplayMedia dialog — the pick turns sharing on, and she sees
 * the screen with each message sent ("with each message", docs/screen-capture.md). Pressed again while sharing:
 * the picker with Stop (another pick changes it); a browser: a small card, Change / Stop. Asking first and the
 * picture's size are this device's settings (Settings → 메이트).
 */
export function useLocalScreenControls(sid: string, name: string, mate?: Mate) {
  const t = useT();
  const device = useDevicePreferences();
  const sharing = useSyncExternalStore(subscribeSharing, sharingSnapshot);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const m = desktopMate();
    if (!m || currentSurface() !== "mate-chat") return;
    const show = () => {
      setOpen(true);
      void m.screenHandled?.();
    };
    void m.getState().then((s) => {
      if ((s as typeof s & { screenPicker?: boolean }).screenPicker) show();
    });
    return m.onCommand((cmd) => {
      if (cmd.type === "screen.open") show();
    });
  }, []);
  const fallback = mate?.prefs?.proactive;
  const p = fallback ? {...fallback,enabled:device.screen.proactive_enabled ?? fallback.enabled,interval:device.screen.proactive_enabled === null ? fallback.interval : device.screen.proactive_interval} : undefined;
  useEffect(() => {
    if (mate) configureProactive(sid, !!p?.enabled, p?.interval || 180);
  }, [sid, p?.enabled, p?.interval]);
  const intent = device.sharing;
  // on for this conversation: live, or saved on and waiting to reconnect (a browser: to be picked again)
  const active =
    sharing?.sid === sid ||
    (intent.enabled && intent.sid === sid && typeof location !== "undefined" && intent.origin === location.origin);
  const start = (source?: CaptureSource) => beginSharing(sid, name, source, false, mate?.id);
  const failed = (e: unknown) => {
    if (!["NotAllowedError", "AbortError"].includes((e as DOMException)?.name))
      toast(String((e as Error)?.message || t("mate.shareFailed")), 4000);
  };
  const press = () => {
    // a browser that isn't sharing: its own dialog is the picker
    if (!captureBridge() && !active) void start().catch(failed);
    else setOpen(true);
  };
  const stop = () => {
    setOpen(false);
    stopSharing();
  };
  const ui = !open ? null : captureBridge() ? (
    <ScreenSharePicker
      mate={mate}
      current={sharing?.sid === sid ? sharing.source : ""}
      onSelect={async (source) => {
        await start(source);
        setOpen(false);
      }}
      onStop={active ? stop : undefined}
      onClose={() => setOpen(false)}
    />
  ) : (
    <BrowserSharing
      source={sharing?.sid === sid ? sharing.source : ""}
      onChange={() => {
        setOpen(false);
        void start().catch(failed);
      }}
      onStop={stop}
      onClose={() => setOpen(false)}
    />
  );
  return { open: canShareScreen() ? press : undefined, active, ui };
}

/** A browser while sharing (or waiting to be picked again): what is shared, Change (its dialog again) / Stop. */
function BrowserSharing({ source, onChange, onStop, onClose }: {
  source: string;
  onChange: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const t = useT();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    <div
      className="fixed inset-0 z-[105] grid place-items-center bg-black/40 p-3"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      data-testid="screen-sharing"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("screen.sharingTitle")}
        className="w-full max-w-sm space-y-3 rounded-2xl border border-border bg-surface-2 p-4 shadow-float"
      >
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Icon name="monitor" size={15} className="text-danger" />
          {t("screen.sharingTitle")}
        </p>
        <p className="break-all text-xs text-content-faint">
          {source ? t("screen.sharingNow", { source }) : t("screen.restoreBrowser")}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onStop} className="btn-ghost text-danger" data-testid="share-stop">
            {t("screen.stop")}
          </button>
          <button type="button" onClick={onClose} className="btn-ghost" data-testid="share-cancel">
            {t("common.close")}
          </button>
          <button type="button" autoFocus onClick={onChange} className="btn-primary" data-testid="share-change">
            {t("screen.change")}
          </button>
        </div>
      </div>
    </div>
  );
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
