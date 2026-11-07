/**
 * The desktop app's own update, on the Download page (desktop/src/updater.js through `hrhNative.updates`): check,
 * download with progress (percent, speed, time left, Cancel), then Restart & install. The state lives in the app:
 * a reloaded page (or another window) shows the same download.
 */
import { useEffect, useState } from "react";
import { fmtEta, fmtSpeed } from "../../lib/downloadProgress";
import { formatBytes } from "../attachments/fileMeta";
import Icon from "../ui/Icon";
import { tr, useT } from "../../i18n";
import { updateErrorText, type UpdateErrorCode } from "../../lib/updateError";

export interface UpdateState {
  status: "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "installing" | "unsupported" | "error";
  current: string;
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  eta?: number | null;
  error?: string;
  /** why, as a code the console words in its language (older apps send only `error`, in English) */
  errorCode?: UpdateErrorCode;
  errorDetail?: string;
  during?: "check" | "download" | "install";
  cancelled?: boolean;
  supported?: boolean;
  reason?: string;
  how?: "installer" | "appimage" | "deb" | "mac" | null;
}

export interface UpdatesBridge {
  getState(): Promise<UpdateState | null>;
  check(): Promise<UpdateState | null>;
  download(): Promise<UpdateState | null>;
  cancel(): Promise<UpdateState | null>;
  install(): Promise<UpdateState | null>;
  retry(): Promise<UpdateState | null>;
  onState(cb: (s: UpdateState) => void): () => void;
}

export const updatesBridge = (): UpdatesBridge | null => (window.hrhNative as any)?.updates || null;

export function useUpdateState(): UpdateState | null {
  const b = updatesBridge();
  const [s, setS] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!b) return;
    let alive = true;
    b.getState()
      .then((x) => {
        if (!alive || !x) return;
        setS(x);
        // first look on this page: find out (a download in progress is simply shown)
        if (x.supported && (x.status === "idle" || x.status === "latest")) void b.check();
      })
      .catch(() => {});
    const off = b.onState((x) => setS(x));
    return () => {
      alive = false;
      off();
    };
  }, [b]);
  return s;
}

export function ProgressBar({ percent, indeterminate }: { percent: number; indeterminate?: boolean }) {
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      {indeterminate ? (
        <div className="absolute inset-y-0 w-1/3 animate-[hrh-indeterminate_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
      ) : (
        <div className="h-full rounded-full bg-gradient-to-r from-accent to-cyan transition-[width] duration-300 ease-out" style={{ width: `${Math.max(2, Math.min(100, percent))}%` }} />
      )}
    </div>
  );
}

export function progressLine(transferred: number, total: number, bps: number, eta: number | null | undefined): string {
  return [total ? tr("downloads.progressOf", { done: formatBytes(transferred), total: formatBytes(total) }) : transferred ? formatBytes(transferred) : "", fmtSpeed(bps), fmtEta(eta)]
    .filter(Boolean)
    .join(" · ");
}

export default function UpdateCard({ s }: { s: UpdateState }) {
  const t = useT();
  const b = updatesBridge()!;
  const pct = Math.round(s.percent || 0);
  const box = "mt-4 rounded-xl border px-4 py-3 text-[13px] animate-fade-in";
  if (s.status === "unsupported" || s.supported === false) {
    return (
      <div className={`${box} border-border bg-surface-2/60 text-content-dim`} data-testid="update-card" data-status="unsupported">
        <div className="flex items-start gap-2">
          <Icon name="info" size={14} className="mt-0.5 shrink-0 text-content-faint" />
          <span>
            {t.rich("downloads.usingAppVersion", { version: <b className="font-mono text-content">{s.current}</b> })} {s.reason}
          </span>
        </div>
      </div>
    );
  }
  if (s.status === "downloading") {
    return (
      <div className={`${box} border-accent/30 bg-accent-soft`} data-testid="update-card" data-status="downloading">
        <div className="flex items-center gap-2 text-content">
          <Icon name="download" size={14} className="text-accent" />
          <span className="min-w-0 flex-1 font-medium">
            {t("downloads.downloadingVersion", { version: s.version })} <span className="font-mono text-accent" data-testid="update-percent">{pct}%</span>
          </span>
          <button className="btn-ghost !px-2.5 !py-1 text-[12px]" onClick={() => void b.cancel()} data-testid="update-cancel">
            {t("common.cancel")}
          </button>
        </div>
        <div className="mt-2.5">
          <ProgressBar percent={pct} indeterminate={!s.transferred} />
        </div>
        <div className="mt-1.5 text-[11.5px] text-content-faint" data-testid="update-progress">
          {s.transferred ? progressLine(s.transferred, s.total || 0, s.bytesPerSecond || 0, s.eta) : t("downloads.preparing")}
        </div>
      </div>
    );
  }
  if (s.status === "ready" || s.status === "installing") {
    return (
      <div className={`${box} border-success/30 bg-success/10`} data-testid="update-card" data-status={s.status}>
        <div className="flex flex-wrap items-center gap-2 text-success">
          <Icon name={s.status === "installing" ? "spinner" : "check"} size={14} spin={s.status === "installing"} />
          <span className="min-w-0 flex-1">
            {s.status === "installing" ? t("downloads.installing", { version: s.version }) : t("downloads.readyToRestart", { version: s.version })}
          </span>
          {s.status === "ready" && (
            <button className="btn-primary !py-1.5" onClick={() => void b.install()} data-testid="update-install">
              <Icon name="refresh" size={13} /> {t("downloads.restartInstall")}
            </button>
          )}
        </div>
        {s.status === "ready" && s.how === "deb" && <p className="mt-1.5 text-[11.5px] text-content-faint">{t("downloads.debNote")}</p>}
      </div>
    );
  }
  if (s.status === "available") {
    return (
      <div className={`${box} border-warning/30 bg-warning/10`} data-testid="update-card" data-status="available">
        <div className="flex flex-wrap items-center gap-2 text-warning">
          <Icon name="sparkles" size={14} />
          <span className="min-w-0 flex-1">
            {t.rich("downloads.versionAvailable", { version: <b className="font-mono">{s.version}</b>, current: s.current, size: s.total ? ` · ${formatBytes(s.total)}` : "" })}
            {s.cancelled && <span className="text-content-faint">{t("downloads.cancelled")}</span>}
          </span>
          <button className="btn-primary !py-1.5" onClick={() => void b.download()} data-testid="update-download">
            <Icon name="download" size={13} /> {s.cancelled ? t("downloads.downloadAgain") : t("downloads.downloadInstall")}
          </button>
        </div>
      </div>
    );
  }
  if (s.status === "error") {
    return (
      <div className={`${box} border-danger/30 bg-danger/10`} data-testid="update-card" data-status="error">
        <div className="flex flex-wrap items-center gap-2 text-danger">
          <Icon name="warning" size={14} />
          <span className="min-w-0 flex-1 break-words" data-testid="update-error">
            {updateErrorText(t, s)}
          </span>
          <button className="btn-ghost !py-1.5" onClick={() => void b.retry()} data-testid="update-retry">
            <Icon name="refresh" size={13} /> {t("common.retry")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={`${box} border-success/25 bg-success/10`} data-testid="update-card" data-status={s.status}>
      <div className="flex flex-wrap items-center gap-2 text-success">
        <Icon name={s.status === "checking" ? "spinner" : "check"} size={14} spin={s.status === "checking"} />
        <span className="min-w-0 flex-1">
          {s.status === "checking" ? t("downloads.checking") : t("downloads.upToDateApp", { version: s.current })}
        </span>
        {s.status !== "checking" && (
          <button className="btn-ghost !px-2.5 !py-1 text-[12px]" onClick={() => void b.check()} data-testid="update-check">
            {t("downloads.checkAgain")}
          </button>
        )}
      </div>
    </div>
  );
}
