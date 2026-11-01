/**
 * Live2D runtime (Global settings): Live2D's Cubism Core isn't shipped with the app (Live2D licence) — the server
 * downloads it once the user accepts the licence. Real progress from the install stream (bytes / percent →
 * verifying → done / error); Live2D avatars pick it up right away (no reload).
 */
import { useEffect, useRef, useState } from "react";
import { coreStatus, installCore, type CoreEvent, type CoreStatus } from "../../../../api/mates";
import Icon from "../../../ui/Icon";
import { Banner, bytes, ProgressBar, Section, StatusBadge } from "../ui";
import { useT } from "../../../../i18n";

export const LIVE2D_LICENCE_URL = "https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html";

// The Live2D renderer's loader may export markLive2DCoreInstalled() (it re-tries loading the core). Picked up when
// present (either location), else the event it listens to is dispatched directly.
const coreModules = import.meta.glob<{ markLive2DCoreInstalled?: () => void }>(["../../../../mate/live2dCore.ts", "../../../../mate/avatar/live2dCore.ts"]);

export async function markCoreInstalled(): Promise<void> {
  let marked = false;
  for (const load of Object.values(coreModules)) {
    try {
      const m = await load();
      if (typeof m.markLive2DCoreInstalled === "function") {
        m.markLive2DCoreInstalled();
        marked = true;
      }
    } catch {
      /* not there */
    }
  }
  if (!marked) window.dispatchEvent(new Event("hrh:live2d-core-installed"));
}

type Run =
  | { phase: "idle" }
  | { phase: "downloading"; received: number; total: number | null }
  | { phase: "verifying" }
  | { phase: "done"; size?: number }
  | { phase: "error"; error: string };

export default function Live2DPanel() {
  const t = useT();
  const [st, setSt] = useState<CoreStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const abort = useRef<AbortController | null>(null);
  const poll = useRef<number | null>(null);

  const refresh = () =>
    coreStatus()
      .then((s) => {
        setSt(s);
        setLoadErr(null);
        return s;
      })
      .catch((e) => {
        setLoadErr((e as Error).message);
        return null;
      });

  // another window / tab is installing: follow it from the status endpoint
  const follow = () => {
    if (poll.current) return;
    const tick = async () => {
      const s = await refresh();
      if (s?.installing) {
        setRun({ phase: "downloading", received: s.received ?? 0, total: s.total ?? null });
        poll.current = window.setTimeout(tick, 700);
      } else {
        poll.current = null;
        if (s?.installed) {
          setRun({ phase: "done", size: s.size });
          void markCoreInstalled();
        } else if (s?.error) setRun({ phase: "error", error: s.error });
        else setRun({ phase: "idle" });
      }
    };
    void tick();
  };

  useEffect(() => {
    void refresh().then((s) => s?.installing && follow());
    return () => {
      abort.current?.abort();
      if (poll.current) clearTimeout(poll.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async () => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setRun({ phase: "downloading", received: 0, total: null });
    const onEvent = (e: CoreEvent) => {
      if (ctl.signal.aborted) return;
      if (e.phase === "downloading") setRun({ phase: "downloading", received: e.received, total: e.total });
      else if (e.phase === "verifying") setRun({ phase: "verifying" });
      else if (e.phase === "done") setRun({ phase: "done", size: e.size });
      else setRun({ phase: "error", error: e.error });
    };
    try {
      const end = await installCore(onEvent, ctl.signal);
      if (end.phase === "done") {
        await markCoreInstalled();
        const s = await refresh();
        if (s?.size) setRun({ phase: "done", size: s.size });
      } else if (/already|in progress|installing/i.test(end.phase === "error" ? end.error : "")) {
        follow(); // someone else's install is running
      }
    } catch {
      /* aborted (left the panel) */
    }
  };

  const installed = !!st?.installed;
  const busy = run.phase === "downloading" || run.phase === "verifying";
  const status = busy
    ? { s: "checking" as const, l: run.phase === "verifying" ? t("mateSettings.l2dVerifying") : t("mateSettings.l2dInstalling") }
    : run.phase === "error"
      ? { s: "error" as const, l: t("mateSettings.l2dInstallFailed") }
      : installed
        ? { s: "ok" as const, l: t("mateSettings.l2dInstalled") }
        : st === null
          ? { s: "checking" as const, l: t("mateSettings.provChecking") }
          : { s: "off" as const, l: t("mateSettings.l2dNotInstalled") };

  return (
    <Section
      testId="mate-core"
      title={t("mateSettings.l2dTitle")}
      hint={t("mateSettings.l2dHint")}
      right={
        <StatusBadge status={status.s} testId="mate-core-status">
          {status.l}
        </StatusBadge>
      }
    >
      {loadErr && <Banner tone="error">{t("mateSettings.l2dStateErr", { error: loadErr })}</Banner>}
      {busy && <Progress run={run} />}
      {run.phase === "done" && (
        <Banner tone="ok" testId="mate-core-done">
          {t(run.size ? "mateSettings.l2dDoneSize" : "mateSettings.l2dDone", { size: run.size ? bytes(run.size) : "" })}
        </Banner>
      )}
      {run.phase === "error" && (
        <Banner tone="error" testId="mate-core-error">
          {run.error}
        </Banner>
      )}
      {installed && run.phase === "idle" && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-content-dim">
          <Icon name="check" size={13} className="text-success" />
          {t("mateSettings.l2dInstalled")}{st?.size ? ` · ${bytes(st.size)}` : ""}
          {st?.source && (
            <span className="min-w-0 truncate text-[11px] text-content-faint" title={st.source}>
              · {t("mateSettings.l2dFrom", { host: new URL(st.source, location.href).host })}
            </span>
          )}
        </p>
      )}
      {!busy && (
        <>
          {!installed && (
            <label className="flex items-start gap-2 text-[12.5px] text-content-dim">
              <input type="checkbox" className="mt-0.5 accent-[#6e8bff]" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} data-testid="mate-core-accept" />
              <span>
                {t.rich("mateSettings.l2dAccept", {
                  a: (s) => (
                    <a href={LIVE2D_LICENCE_URL} target="_blank" rel="noreferrer" className="text-accent underline">
                      {s}
                    </a>
                  ),
                })}
              </span>
            </label>
          )}
          <div className="flex justify-end gap-2">
            {installed ? (
              <button className="btn-ghost border border-border" onClick={install} data-testid="mate-core-reinstall" title={t("mateSettings.l2dReinstallTitle")}>
                <Icon name="rotate" size={13} /> {t("mateSettings.l2dReinstall")}
              </button>
            ) : (
              <button className="btn-primary" disabled={!accepted || st === null} onClick={install} data-testid="mate-core-install">
                <Icon name="download" size={14} /> {run.phase === "error" ? t("common.tryAgain") : t("mateSettings.l2dInstall")}
              </button>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

function Progress({ run }: { run: Run }) {
  const t = useT();
  if (run.phase === "verifying") {
    return (
      <div className="space-y-1.5" data-testid="mate-core-progress" data-phase="verifying">
        <ProgressBar indeterminate />
        <p className="text-[12px] text-content-dim">{t("mateSettings.l2dVerifyingDownload")}</p>
      </div>
    );
  }
  if (run.phase !== "downloading") return null;
  const pct = run.total ? Math.min(1, run.received / run.total) : null;
  return (
    <div className="space-y-1.5" data-testid="mate-core-progress" data-phase="downloading">
      <ProgressBar value={pct ?? undefined} indeterminate={pct === null} />
      <p className="flex justify-between gap-2 text-[12px] tabular-nums text-content-dim">
        <span>
          {run.total
            ? t("mateSettings.l2dDownloadingOf", { got: bytes(run.received), total: bytes(run.total) })
            : t("mateSettings.l2dDownloading", { got: bytes(run.received) })}
        </span>
        {pct !== null && <span>{Math.round(pct * 100)}%</span>}
      </p>
    </div>
  );
}
