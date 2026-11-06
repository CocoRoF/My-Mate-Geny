import { useEffect, useRef, useState, type ReactNode } from "react";
import { useConfigStore } from "../../stores/configStore";
import { useInstallations, Dependencies, InstallTool, type Installations } from "./ToolInstallations";
import { useCliToolsStore } from "../../stores/cliToolsStore";
import { CliError, type CliJob, type CliTool } from "../../api/cliTools";
import { useT, type MsgKey } from "../../i18n";
import { relTime } from "../../i18n/format";
import Icon from "../ui/Icon";

/**
 * Settings → Providers → CLI versions: Claude Code, Codex and Higgsfield as the server launches them — installed vs
 * latest, "Check now", an upgrade with its live log (pushed over /ws/sessions: stores/cliToolsStore.ts), "when idle",
 * pin / roll back, automatic upgrades. Backend: app/services/cli_tools.
 */
export default function CliVersionsSection({ ids }: { ids?: string[] } = {}) {
  const t = useT();
  const local=useConfigStore(s=>s.executionMode)==="local";
  const installations=useInstallations();
  const status = useCliToolsStore((s) => s.status);
  const error = useCliToolsStore((s) => s.error);
  const checking = useCliToolsStore((s) => s.checking);
  const load = useCliToolsStore((s) => s.load);
  const check = useCliToolsStore((s) => s.check);

  useEffect(() => {
    load();
  }, [load]);

  const busy = checking || !!status?.checking;
  const checkedAt = status?.tools.map((x) => x.latest.checked_at).filter(Boolean).sort().pop();
  const jobActive = !!status?.tools.some((x) => x.job?.active);

  return (
    <section className="card p-4 mt-6" data-testid="cli-versions">
      <div className="flex items-start gap-3">
        <div className="grid place-items-center w-9 h-9 rounded-lg bg-accent-soft shrink-0">
          <Icon name="terminal" size={17} className="text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium">{t("cliTools.title")}</h3>
            <span className="ml-auto flex items-center gap-2 text-[11px] text-content-faint">
              {checkedAt && !busy && <span>{t("cliTools.checkedAgo", { when: relTime(checkedAt) })}</span>}
              <button onClick={() => check()} disabled={busy} className="btn-ghost py-1 px-2 text-[12px]" data-testid="cli-check-now">
                <Icon name={busy ? "spinner" : "refresh"} size={13} className={busy ? "animate-spin" : ""} />
                {busy ? t("cliTools.checking") : t("cliTools.checkNow")}
              </button>
            </span>
          </div>
          <p className="text-xs text-content-faint mt-0.5">{t(local?"cliTools.introLocal":"cliTools.intro", { hours: status?.ttl_h ?? 6 })}</p>
          {status && !status.check_enabled && <p className="text-[11px] text-content-faint mt-1">{t(local?"cliTools.checksOffLocal":"cliTools.checksOff")}</p>}
        </div>
      </div>

      {error && !status && (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-danger">
          <Icon name="alert-circle" size={14} />
          <span className="min-w-0 flex-1">{t("cliTools.loadFailed", { error })}</span>
          <button onClick={() => load()} className="btn-ghost py-1 px-2 text-[12px]">
            {t("cliTools.retry")}
          </button>
        </div>
      )}
      {!status && !error && (
        <div className="mt-3 text-[12px] text-content-faint flex items-center gap-2">
          <Icon name="spinner" size={13} className="animate-spin" /> {t("cliTools.checking")}
        </div>
      )}

      <Dependencies installations={installations} otherJob={jobActive}/>
      <div className="mt-3 space-y-2.5">
        {status?.tools.filter(tool => !ids || ids.includes(tool.id)).map((tool) => (
          <ToolRow installations={installations} key={tool.id} tool={tool} running={status.running_chats} otherJob={jobActive && !tool.job?.active} memCap={status.mem_cap} prefix={status.managed_prefix} />
        ))}
      </div>
    </section>
  );
}

const METHOD: Record<string, MsgKey> = {
  native: "cliTools.methodNative",
  npm: "cliTools.methodNpm",
  managed: "cliTools.methodManaged",
  unknown: "cliTools.methodUnknown",
  missing: "cliTools.methodMissing",
};

const SELF: Record<string, MsgKey> = {
  read_only: "cliTools.selfUpdate_read_only",
  app_managed: "cliTools.selfUpdate_app_managed",
  settings_env: "cliTools.selfUpdate_settings_env",
  process_env: "cliTools.selfUpdate_process_env",
  global_config: "cliTools.selfUpdate_global_config",
};

const ERR: Record<string, MsgKey> = {
  busy: "cliTools.err_busy",
  up_to_date: "cliTools.err_up_to_date",
  invalid_version: "cliTools.err_invalid_version",
  npm_missing: "cliTools.err_npm_missing",
  latest_unknown: "cliTools.err_latest_unknown",
  no_managed_copy: "cliTools.err_no_managed_copy",
  running: "cliTools.err_running",
};

function errText(t: ReturnType<typeof useT>, e: unknown): string {
  if (e instanceof CliError && ERR[e.code]) return t(ERR[e.code]);
  return String((e as Error)?.message || e);
}

function ToolRow({
  tool,
  running,
  otherJob,
  memCap,
  prefix,
  installations,
}: {
  tool: CliTool;
  running: number;
  otherJob: boolean;
  memCap: { available: boolean; size: string };
  prefix: string;
  installations: Installations;
}) {
  const t = useT();
  const upgrade = useCliToolsStore((s) => s.upgrade);
  const setSettings = useCliToolsStore((s) => s.setSettings);
  const check = useCliToolsStore((s) => s.check);
  const [confirm, setConfirmState] = useState<{ version?: string; to: string } | null>(null);
  const load = useCliToolsStore((s) => s.load);
  // opening the confirmation refetches the status: how many chats are running right now
  const setConfirm = (c: { version?: string; to: string } | null) => {
    setConfirmState(c);
    if (c) {
      setErr("");
      load();
    }
  };
  const [err, setErr] = useState("");
  const [more, setMore] = useState(false);
  const [pin, setPin] = useState("");
  const inst = tool.installed;
  const target = tool.latest.version;
  const missing = inst.method === "missing";
  const job = tool.job;
  const busyHere = !!job?.active;

  const start = async (when: "now" | "idle") => {
    if (!confirm) return;
    setErr("");
    try {
      await upgrade(tool.id, { version: confirm.version, when });
      setConfirm(null);
      setPin("");
    } catch (e) {
      setErr(errText(t, e));
    }
  };
  const save = (patch: Parameters<typeof setSettings>[1]) => setSettings(tool.id, patch).then(() => setErr(""), (e) => setErr(errText(t, e)));

  // the status pill: only a real newer version is "Update available" (the server compares versions)
  let pill: { text: string; cls: string };
  if (missing) pill = { text: t("cliTools.notInstalled"), cls: "bg-surface-3 text-content-faint" };
  else if (!inst.version) pill = { text: t("cliTools.versionUnknown"), cls: "bg-warning/15 text-warning" };
  else if (tool.update_available) pill = { text: t("cliTools.updateAvailable"), cls: "bg-accent-soft text-accent" };
  else if (!target) pill = { text: t("cliTools.latestUnknown"), cls: "bg-surface-3 text-content-faint" };
  else if (target !== inst.version) pill = { text: t("cliTools.aheadOfChannel", { channel: tool.channel }), cls: "bg-success/10 text-success" };
  else pill = { text: t("cliTools.upToDate"), cls: "bg-success/10 text-success" };

  const canStart = tool.upgrade.possible && !busyHere && !otherJob;
  const offer = (tool.update_available || (missing && !!target && !installations.data)) && tool.upgrade.possible;
  const notesCount = tool.notes?.sections.reduce((n, s) => n + s.count, 0) ?? 0;
  const pinExample = target || inst.version || "1.2.3";

  return (
    <div className="rounded-lg border border-border bg-surface/50 p-3" data-testid={`cli-tool-${tool.id}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium">{tool.label}</span>
        <span className="font-mono text-[12px] text-content-dim" data-testid={`cli-installed-${tool.id}`}>
          {inst.version ?? "—"}
        </span>
        {tool.update_available && target && (
          <span className="font-mono text-[12px] text-accent">→ {target}</span>
        )}
        <span className={`pill ${pill.cls}`} data-testid={`cli-pill-${tool.id}`}>
          {pill.text}
        </span>
        {!missing && <span className="pill bg-surface-3 text-content-faint">{t(METHOD[inst.method] ?? "cliTools.methodUnknown")}</span>}
        {!missing && !inst.writable && inst.method !== "unknown" && (
          <span className="pill bg-surface-3 text-content-faint">{t("cliTools.readOnly")}</span>
        )}
      </div>

      <div className="mt-1 space-y-0.5 text-[11px] text-content-faint">
        <p className="truncate" title={inst.realpath || undefined}>
          {inst.path ? t("cliTools.usedBinary", { path: inst.path }) : t("cliTools.usedBinaryMissing", { binary: inst.binary })}
        </p>
        <p>
          {tool.channel !== "latest" ? t("cliTools.latestOn", { channel: tool.channel }) : t("cliTools.latest")}:{" "}
          <span className="font-mono text-content-dim">{target ?? "—"}</span>
          {tool.release_url && (
            <a href={tool.release_url} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-0.5 text-accent hover:underline">
              {t("cliTools.releaseNotes")} <Icon name="external" size={11} />
            </a>
          )}
        </p>
        {inst.error && inst.error !== "not_found" && <p className="text-danger">{t("cliTools.installedError", { error: inst.error })}</p>}
        {tool.latest.error && (
          <p className="text-danger flex items-center gap-2">
            {t("cliTools.latestError", { error: tool.latest.error })}
            <button onClick={() => check(tool.id)} className="underline hover:no-underline">
              {t("cliTools.retry")}
            </button>
          </p>
        )}
        {tool.self_update && (
          <p title={t("cliTools.selfUpdateHint")}>
            {tool.self_update.enabled
              ? t("cliTools.selfUpdateOn", { channel: tool.self_update.channel })
              : `${t("cliTools.selfUpdateOff")} — ${SELF[tool.self_update.source] ? t(SELF[tool.self_update.source]) : tool.self_update.source}`}
          </p>
        )}
      </div>

      {tool.channels.length > 1 && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-content-faint">
          <span className="shrink-0">{t("cliTools.channel")}</span>
          <select value={tool.channel} onChange={(e) => save({ channel: e.target.value })} className="field min-w-0 w-auto max-w-full py-0.5 text-[11px]" data-testid={`cli-channel-${tool.id}`}>
            {tool.channels.map((c) => (
              <option key={c} value={c}>
                {c === "stable" ? t("cliTools.channelStable") : c === "latest" ? t("cliTools.channelLatest") : c}
              </option>
            ))}
          </select>
        </div>
      )}

      {tool.update_available && tool.notes && <Notes notes={tool.notes} count={notesCount} />}

      {offer && !confirm && !busyHere && (
        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setConfirm({ to: target! })}
            disabled={!canStart}
            className="btn-primary py-1.5 text-[13px]"
            data-testid={`cli-upgrade-${tool.id}`}
          >
            <Icon name="download" size={14} />
            {missing ? t("cliTools.installVersion", { version: target! }) : t("cliTools.upgradeTo", { version: target! })}
          </button>
        </div>
      )}
      {installations.data&&<InstallTool tool={tool.id} installations={installations} otherJob={busyHere||otherJob}/>}
      {!tool.upgrade.possible && (tool.update_available || missing) && !installations.data && (
        <p className="mt-2 text-[11px] text-warning">
          {tool.upgrade.code === "npm_missing" ? t("cliTools.cantUpgrade_npm_missing") : t("cliTools.cantUpgrade_default", { code: tool.upgrade.code })}
        </p>
      )}
      {tool.upgrade.possible && tool.upgrade.switch_to_managed && (offer || confirm) && (
        <p className="mt-2 text-[11px] text-content-faint">
          {t(
            tool.upgrade.reason === "missing"
              ? "cliTools.managedHint_missing"
              : tool.upgrade.reason === "unknown_install"
                ? "cliTools.managedHint_unknown_install"
                : "cliTools.managedHint_read_only",
            { path: inst.path || inst.binary, prefix },
          )}
        </p>
      )}

      {confirm && tool.upgrade.possible && (
        <Confirm
          tool={tool}
          to={confirm.to}
          pin={!!confirm.version}
          running={running}
          command={tool.upgrade.command.replace(/(@|\s)[^@\s]+$/, `$1${confirm.to}`)}
          onNow={() => start("now")}
          onIdle={() => start("idle")}
          onCancel={() => setConfirm(null)}
        />
      )}
      {err && <p className="mt-1.5 text-[11px] text-danger" data-testid={`cli-error-${tool.id}`}>{err}</p>}

      {job && <JobView job={job} tool={tool} memCap={memCap} onRetry={() => setConfirm({ version: job.reason === "pin" ? job.target : undefined, to: job.target })} />}

      <div className="mt-2">
        <button onClick={() => setMore((v) => !v)} className="flex items-center gap-1 text-[11px] text-content-faint hover:text-content-dim" data-testid={`cli-more-${tool.id}`}>
          <Icon name={more ? "chevron-down" : "chevron"} size={12} />
          {t("cliTools.moreOptions")}
        </button>
        {more && (
          <div className="mt-2 space-y-2.5 pl-4 text-[12px]">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={tool.auto_upgrade} onChange={(e) => save({ auto_upgrade: e.target.checked })} className="mt-0.5 accent-[rgb(var(--c-accent))]" data-testid={`cli-auto-${tool.id}`} />
              <span>
                <span className="text-content-dim">{t("cliTools.autoUpgrade")}</span>
                <span className="block text-[11px] text-content-faint">{t("cliTools.autoUpgradeHint")}</span>
              </span>
            </label>
            {tool.upgrade.possible && (
              <div>
                <div className="text-content-dim">{t("cliTools.pinTitle")}</div>
                <div className="text-[11px] text-content-faint">
                  {t("cliTools.pinHint")} {tool.self_update?.enabled && inst.method === "native" ? t("cliTools.pinNativeHint") : ""}
                </div>
                <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                  <input
                    value={pin}
                    onChange={(e) => setPin(e.target.value.trim())}
                    placeholder={t("cliTools.pinPlaceholder", { example: pinExample })}
                    className="field py-1 text-[12px] font-mono w-40"
                    data-testid={`cli-pin-${tool.id}`}
                  />
                  <button onClick={() => pin && setConfirm({ version: pin, to: pin })} disabled={!pin || !canStart} className="btn-soft py-1 text-[12px]" data-testid={`cli-pin-install-${tool.id}`}>
                    {t("cliTools.install")}
                  </button>
                  {tool.previous_version && tool.previous_version !== inst.version && (
                    <button onClick={() => setConfirm({ version: tool.previous_version!, to: tool.previous_version! })} disabled={!canStart} className="btn-ghost py-1 text-[12px]" data-testid={`cli-rollback-${tool.id}`}>
                      <Icon name="rotate" size={13} /> {t("cliTools.rollBack", { version: tool.previous_version })}
                    </button>
                  )}
                </div>
              </div>
            )}
            {tool.using_managed && (
              <div className="text-[11px] text-content-faint space-y-1">
                <p className="truncate">{t("cliTools.usingManaged", { path: tool.managed_path })}</p>
                {tool.bundled && (
                  <p className="flex items-center gap-2 flex-wrap">
                    {t("cliTools.bundledCopy", { path: tool.bundled.path || inst.binary, version: tool.bundled.version || "—" })}
                    <button onClick={() => save({ use_managed: false })} disabled={busyHere} className="btn-ghost py-0.5 px-2 text-[11px]">
                      {t("cliTools.useBundled")}
                    </button>
                  </p>
                )}
              </div>
            )}
            {!tool.using_managed && tool.managed_installed && (
              <button onClick={() => save({ use_managed: true })} disabled={busyHere} className="btn-ghost py-0.5 px-2 text-[11px]">
                {t("cliTools.useManaged")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Notes({ notes, count }: { notes: NonNullable<CliTool["notes"]>; count: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const shown = notes.sections.reduce((n, s) => n + s.items.length, 0);
  if (notes.error)
    return <p className="mt-2 text-[11px] text-content-faint">{t("cliTools.notesFailed", { error: notes.error })}</p>;
  if (!count) return null;
  return (
    <div className="mt-2">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-[11px] text-content-dim hover:text-content" data-testid="cli-notes-toggle">
        <Icon name={open ? "chevron-down" : "chevron"} size={12} />
        {t("cliTools.whatsNew", { n: count })}
      </button>
      {open && (
        <div className="mt-1.5 pl-4 space-y-1.5 text-[11.5px] text-content-dim">
          {notes.sections
            .filter((s) => s.items.length)
            .map((s) => (
              <div key={s.version}>
                <div className="font-mono text-[11px] text-content-faint">{s.version}</div>
                <ul className="list-disc pl-4 space-y-0.5">
                  {s.items.map((it, i) => (
                    <li key={i}>{it}</li>
                  ))}
                </ul>
              </div>
            ))}
          {count > shown && <p className="text-[11px] text-content-faint">{t("cliTools.moreChanges", { n: count - shown })}</p>}
        </div>
      )}
    </div>
  );
}

function Confirm({
  tool,
  to,
  pin,
  running,
  command,
  onNow,
  onIdle,
  onCancel,
}: {
  tool: CliTool;
  to: string;
  pin: boolean;
  running: number;
  command: string;
  onNow: () => void;
  onIdle: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const from = tool.installed.version;
  return (
    <div className="mt-2.5 rounded-lg border border-accent/30 bg-accent-soft/40 p-3 text-[12px]" data-testid={`cli-confirm-${tool.id}`}>
      <div className="font-medium text-content">
        {!from
          ? t("cliTools.confirmInstallTitle", { name: tool.label, to })
          : pin
            ? t("cliTools.confirmPinTitle", { name: tool.label, from, to })
            : t("cliTools.confirmTitle", { name: tool.label, from, to })}
      </div>
      <div className="mt-1.5 text-[11px] text-content-faint">{t("cliTools.confirmCommand")}</div>
      <code className="block mt-0.5 font-mono text-[11px] text-content-dim break-all">{command}</code>
      {running > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-warning" data-testid={`cli-running-warn-${tool.id}`}>
          <Icon name="warning" size={13} className="mt-0.5 shrink-0" />
          {t("cliTools.runningWarn", { n: running })}
        </p>
      )}
      <p className="mt-2 text-[11px] text-content-faint">{t(tool.restart === "engine_restart" ? "cliTools.appliesEngines" : "cliTools.appliesNextTurn")}</p>
      <div className="mt-2.5 flex items-center gap-2 flex-wrap">
        {running > 0 ? (
          <>
            <button onClick={onIdle} className="btn-primary py-1.5 text-[12px]" data-testid={`cli-confirm-idle-${tool.id}`}>
              <Icon name="clock" size={13} /> {t("cliTools.upgradeWhenIdle")}
            </button>
            <button onClick={onNow} className="btn-soft py-1.5 text-[12px]" data-testid={`cli-confirm-now-${tool.id}`}>
              {t("cliTools.upgradeNow")}
            </button>
          </>
        ) : (
          <button onClick={onNow} className="btn-primary py-1.5 text-[12px]" data-testid={`cli-confirm-now-${tool.id}`}>
            {from && !pin ? t("cliTools.upgrade") : t("cliTools.install")}
          </button>
        )}
        <button onClick={onCancel} className="btn-ghost py-1.5 text-[12px]">
          {t("cliTools.cancel")}
        </button>
      </div>
    </div>
  );
}

const JOB_ERR: Record<string, MsgKey> = {
  exit_code: "cliTools.err_exit_code",
  killed: "cliTools.err_killed",
  timeout: "cliTools.err_timeout",
};

function JobView({
  job,
  tool,
  memCap,
  onRetry,
}: {
  job: CliJob;
  tool: CliTool;
  memCap: { available: boolean; size: string };
  onRetry: () => void;
}) {
  const t = useT();
  const cancel = useCliToolsStore((s) => s.cancel);
  const [showLog, setShowLog] = useState(job.active);
  const [hidden, setHidden] = useState(false);
  const [err, setErr] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (job.active) {
      setShowLog(true);
      setHidden(false);
    }
  }, [job.active, job.id]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job.log.length, showLog]);
  if (hidden && !job.active) return null;

  const error =
    job.error_code === "verify_failed"
      ? t("cliTools.err_verify_failed", { detail: (job.error || "").replace(/ after the upgrade.*$/, "") })
      : JOB_ERR[job.error_code || ""]
        ? t(JOB_ERR[job.error_code!])
        : job.error || "";
  const secs = job.result.seconds ?? 0;
  let line: ReactNode;
  let tone = "text-content-dim";
  switch (job.state) {
    case "queued":
      line = t("cliTools.stateQueued");
      break;
    case "waiting":
      line = t("cliTools.stateWaiting", { n: job.waiting_for || 1 });
      tone = "text-warning";
      break;
    case "running":
      line = t("cliTools.stateRunning", { version: job.target });
      break;
    case "verifying":
      line = t("cliTools.stateVerifying");
      break;
    case "succeeded": {
      line = !job.from_version
        ? t("cliTools.stateInstalled", { to: job.result.version || job.target, seconds: secs })
        : t(job.reason === "pin" ? "cliTools.stateSwitched" : "cliTools.stateSucceeded", { from: job.from_version, to: job.result.version || job.target, seconds: secs });
      const e = job.result.engines;
      if (e && (e.restarted || e.deferred)) {
        const parts = [e.restarted ? t("cliTools.enginesRestarted", { n: e.restarted }) : "", e.deferred ? t("cliTools.enginesDeferred", { n: e.deferred }) : ""].filter(Boolean);
        line = `${line} ${parts.join(" · ")}`;
      }
      tone = "text-success";
      break;
    }
    case "failed":
      line = t("cliTools.stateFailed", { version: job.target, error });
      tone = "text-danger";
      break;
    case "cancelled":
      line = t("cliTools.stateCancelled", { version: job.target });
      tone = "text-content-faint";
      break;
  }
  const spinning = job.state === "queued" || job.state === "running" || job.state === "verifying";

  return (
    <div className="mt-2.5 rounded-lg border border-border bg-surface-2/60 p-2.5" data-testid={`cli-job-${tool.id}`} data-state={job.state} data-job={job.id}>
      <div className="flex items-start gap-2 text-[12px]">
        {spinning && <span className="mt-0.5 w-3.5 h-3.5 shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />}
        {job.state === "waiting" && <Icon name="clock" size={14} className="mt-0.5 shrink-0 text-warning" />}
        {job.state === "succeeded" && <Icon name="check" size={14} className="mt-0.5 shrink-0 text-success" />}
        {job.state === "failed" && <Icon name="alert-circle" size={14} className="mt-0.5 shrink-0 text-danger" />}
        <span className={`min-w-0 flex-1 ${tone}`} data-testid={`cli-job-line-${tool.id}`}>
          {line}
          {job.reason === "auto" && <span className="pill ml-1.5 bg-surface-3 text-content-faint">{t("cliTools.autoJob")}</span>}
        </span>
        {job.state === "waiting" && (
          <button onClick={() => cancel(tool.id).catch((e) => setErr(errText(t, e)))} className="btn-ghost py-0.5 px-2 text-[11px]" data-testid={`cli-cancel-${tool.id}`}>
            {t("cliTools.cancelWait")}
          </button>
        )}
        {job.state === "failed" && tool.upgrade.possible && (
          <button onClick={onRetry} className="btn-soft py-0.5 px-2 text-[11px]" data-testid={`cli-retry-${tool.id}`}>
            {t("cliTools.retry")}
          </button>
        )}
        {!job.active && (
          <button onClick={() => setHidden(true)} className="btn-ghost py-0.5 px-1.5 text-[11px]" title={t("cliTools.dismiss")} aria-label={t("cliTools.dismiss")}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      {(job.state === "running" || job.state === "verifying") && (
        <div className="mt-1 text-[10.5px] text-content-faint">{job.mem_cap ? t("cliTools.memCap", { size: job.mem_cap }) : memCap.available ? "" : t("cliTools.noMemCap")}</div>
      )}
      {err && <p className="mt-1 text-[11px] text-danger">{err}</p>}
      {job.log.length > 0 && (
        <>
          <button onClick={() => setShowLog((v) => !v)} className="mt-1.5 flex items-center gap-1 text-[11px] text-content-faint hover:text-content-dim">
            <Icon name={showLog ? "chevron-down" : "chevron"} size={12} />
            {showLog ? t("cliTools.hideLog") : t("cliTools.showLog")}
          </button>
          {showLog && (
            <pre ref={logRef} className="mt-1 max-h-56 overflow-auto rounded-md bg-surface p-2 font-mono text-[10.5px] leading-relaxed text-content-dim whitespace-pre-wrap break-all" data-testid={`cli-log-${tool.id}`}>
              {job.log.join("\n")}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
