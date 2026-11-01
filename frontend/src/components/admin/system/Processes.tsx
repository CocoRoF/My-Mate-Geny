// Process view: the backend, every Claude/Codex engine (with its chat), other
// child processes — sorted by memory (the whole process tree), with an RSS
// trend, CPU, state and uptime.
import { useState } from "react";
import type { MonProc, Snapshot, Thresholds } from "../../../api/system";
import { useSessionStore } from "../../../stores/sessionStore";
import { useUIStore } from "../../../stores/uiStore";
import Icon, { type IconName } from "../../ui/Icon";
import { useFeed } from "./feed";
import { bytes, C1, C2, dur, WARN } from "./fmt";
import { Sparkline } from "./Spark";
import { ChartCard } from "./Charts";
import { tr, useT, type MsgKey } from "../../../i18n";

const KIND_ICON: Record<MonProc["kind"], IconName> = { backend: "server", engine: "cpu", run: "bolt", child: "terminal" };
const STATE: Record<string, MsgKey> = {
  R: "admin.stateRunning", S: "admin.stateSleeping", D: "admin.stateDiskWait", T: "admin.stateStopped", I: "admin.stateIdle", Z: "admin.stateZombie",
};

function useOpen() {
  const setActive = useSessionStore((s) => s.setActive);
  const setView = useUIStore((s) => s.setView);
  return (sid: string) => {
    setActive(sid);
    setView("chat");
  };
}

function status(p: MonProc): { text: string; working: boolean } {
  if (p.kind === "engine") {
    const tasks = p.tasks ? tr("admin.tasksSuffix", { count: p.tasks }) : "";
    return p.working ? { text: tr("admin.procWorking", { tasks }), working: true } : { text: tr("admin.procIdle", { dur: dur(p.idle_s ?? 0), tasks }), working: false };
  }
  if (p.kind === "run") return { text: tr("admin.procWorking", { tasks: p.tools ? tr("admin.toolsSuffix", { n: p.tools }) : "" }), working: true };
  return { text: STATE[p.state] ? tr(STATE[p.state]) : p.state, working: p.state === "R" };
}

function Row({ p, hist, limit, open }: { p: MonProc; hist: number[]; limit: number; open: (sid: string) => void }) {
  const t = useT();
  const st = status(p);
  const over = (p.kind === "engine" || p.kind === "run") && p.rss_tree >= limit;
  const meta = [
    p.model,
    p.account,
    p.session_kind === "mate" ? t("admin.procMate") : null,
    `pid ${p.pid}`,
    p.nprocs > 1 ? t("admin.procs", { n: p.nprocs }) : null,
  ].filter(Boolean).join(" · ");
  const title = p.title || p.name;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-border/50 px-1 py-2 last:border-0 sm:grid-cols-[minmax(0,1fr)_150px_56px_84px_96px_56px] sm:items-center">
      <div className="min-w-0 flex items-center gap-2.5">
        <Icon name={KIND_ICON[p.kind]} size={14} className={p.kind === "engine" || p.kind === "run" ? "text-accent shrink-0" : "text-content-faint shrink-0"} />
        <div className="min-w-0">
          {p.session_id ? (
            <button onClick={() => open(p.session_id!)} className="block max-w-full truncate text-left text-[13px] text-content hover:text-accent hover:underline underline-offset-2" title={t("admin.openTitle", { title })}>
              {title}
            </button>
          ) : (
            <div className="truncate text-[13px] text-content" title={p.cmd}>{title}</div>
          )}
          <div className="truncate font-mono text-[10.5px] text-content-faint" title={p.cmd}>{meta}</div>
        </div>
      </div>
      <div className="row-start-1 col-start-2 text-right sm:row-auto sm:col-auto sm:text-left">
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-content-dim whitespace-nowrap">
          <span className={`h-2 w-2 rounded-full ${st.working ? "bg-accent animate-pulse-dot" : "bg-success/70"}`} />
          {st.text}
        </span>
      </div>
      <div className="col-span-2 flex items-center gap-3 pl-6 text-[11.5px] sm:contents">
        <span className="tabular-nums text-content-dim sm:text-right" title={t("admin.cpuTitle")}>
          <span className="sm:hidden text-content-faint">{t("admin.colCpu")} </span>{p.cpu_tree.toFixed(0)}%
        </span>
        <span className="tabular-nums text-content sm:text-right" title={p.rss_tree !== p.rss ? t("admin.rssTitle", { own: bytes(p.rss), tree: bytes(p.rss_tree) }) : undefined}>
          {over && <span className="mr-1 inline-flex align-[-2px]" style={{ color: WARN }} title={t("admin.overAlert")}><Icon name="warning" size={12} /></span>}
          {bytes(p.rss_tree)}
        </span>
        <span className="min-w-[60px] flex-1 sm:flex-none">
          <Sparkline values={hist} height={20} color={p.kind === "backend" ? C1 : C2} />
        </span>
        <span className="tabular-nums text-content-faint sm:text-right" title={t("admin.uptimeTitle")}>{dur(p.uptime_s)}</span>
      </div>
    </div>
  );
}

export default function Processes({ now, th }: { now: Snapshot | null; th: Thresholds | null }) {
  const t = useT();
  const procHist = useFeed((s) => s.procHist);
  const open = useOpen();
  const [all, setAll] = useState(false);
  if (!now) return null;
  const procs = [...now.procs].sort((a, b) => b.rss_tree - a.rss_tree);
  const shown = all ? procs : procs.slice(0, 10);
  const engines = procs.filter((p) => p.kind === "engine").length;
  const total = now.m.tree_rss ?? procs.reduce((a, p) => a + p.rss_tree, 0);
  return (
    <ChartCard title={t("admin.processes", { n: procs.length })} icon="cpu"
      right={t("admin.procsRight", { count: engines, total: bytes(total) })}>
      <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_150px_56px_84px_96px_56px] gap-x-3 border-b border-border px-1 pb-1.5 text-[10.5px] uppercase tracking-wide text-content-faint">
        <span>{t("admin.colProcess")}</span>
        <span>{t("admin.colState")}</span>
        <span className="text-right">{t("admin.colCpu")}</span>
        <span className="text-right">{t("admin.colMemory")}</span>
        <span>{t("admin.colLast5")}</span>
        <span className="text-right">{t("admin.colUp")}</span>
      </div>
      {shown.map((p) => (
        <Row key={p.key} p={p} hist={procHist[p.key] || []} limit={th?.engine_rss ?? 2 * 1024 ** 3} open={open} />
      ))}
      {procs.length > 10 && (
        <button onClick={() => setAll(!all)} className="mt-1 text-[11.5px] text-accent hover:underline">
          {all ? t("admin.showFewer") : t("admin.showAll", { n: procs.length })}
        </button>
      )}
      {now.zombies > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-surface-3/60 px-3 py-2 text-[11.5px] text-content-dim">
          <span className="mt-[1px] inline-flex" style={{ color: WARN }}><Icon name="warning" size={13} /></span>
          <span>{t.rich("admin.zombies", { count: now.zombies, code: <code className="font-mono">init: true</code> })}</span>
        </div>
      )}
      <p className="mt-2 text-[10.5px] text-content-faint">
        {t("admin.procNote")}
      </p>
    </ChartCard>
  );
}
