import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { stopTask, taskOutput } from "../../api/sessions";
import { useSessionStore } from "../../stores/sessionStore";
import { useChatStore } from "../../stores/chatStore";
import { useSubagentUi } from "../../stores/subagentStore";
import { isRunning, useTaskStore, visibleTasks } from "../../stores/taskStore";
import type { TaskInfo } from "../../types";
import Icon from "../ui/Icon";
import { useBackHandler } from "../../lib/back";
import { fmtMs } from "../chat/turn/toolMeta";
import { useT, type MsgKey } from "../../i18n";

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const TYPE: Record<string, MsgKey> = { local_bash: "tasks.typeCommand", remote_bash: "tasks.typeRemote", local_agent: "tasks.typeSubagent", remote_agent: "tasks.typeAgent" };
const STATUS: Record<string, MsgKey> = {
  running: "tasks.stRunning",
  pending: "tasks.stPending",
  completed: "tasks.stCompleted",
  failed: "tasks.stFailed",
  stopped: "tasks.stStopped",
  killed: "tasks.stKilled",
  lost: "tasks.stLost",
};

function Output({ sid, task }: { sid: string; task: TaskInfo }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  const running = isRunning(task);
  useEffect(() => {
    let alive = true;
    const load = () =>
      taskOutput(sid, task.task_id)
        .then((r) => {
          if (!alive) return;
          setText(r.available ? r.output : "");
          setTruncated(r.truncated);
          requestAnimationFrame(() => ref.current && (ref.current.scrollTop = ref.current.scrollHeight));
        })
        .catch(() => alive && setText(""));
    load();
    const t = running ? setInterval(load, 2000) : undefined;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [sid, task.task_id, running]);
  return (
    <pre
      ref={ref}
      className="mx-3 mb-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg/80 p-2.5 font-mono text-[11px] leading-relaxed text-content-dim"
    >
      {text === null ? t("common.loading") : text ? (truncated ? `${t("tasks.earlierTrimmed")}\n` : "") + text : t("tasks.noOutput")}
    </pre>
  );
}

function Row({ task, now, showChat, open, toggle }: { task: TaskInfo; now: number; showChat: boolean; open: boolean; toggle: () => void }) {
  const t = useT();
  const [stopping, setStopping] = useState(false);
  const sessions = useSessionStore((s) => s.sessions);
  const running = isRunning(task);
  const start = (task.started_at || 0) * 1000;
  const end = task.ended_at ? task.ended_at * 1000 : now;
  const icon = running ? null : task.status === "completed" ? "check" : task.status === "failed" ? "x" : "ban";
  const tone = task.status === "completed" ? "text-success" : task.status === "failed" ? "text-danger" : "text-content-faint";
  const chat = showChat ? sessions.find((s) => s.id === task.session_id)?.title : null;
  // A subagent of the open chat: its full detail (steps, report) is one click away.
  const activeId = useSessionStore((s) => s.activeId);
  const inChat = useChatStore(
    (s) =>
      !!task.tool_use_id &&
      task.session_id === activeId &&
      [...s.turns, ...(s.detached ? [s.detached] : [])].some((t) => t.tools.some((x) => x.id === task.tool_use_id)),
  );
  const openAgent = useSubagentUi((s) => s.open);
  return (
    <div data-testid="task-row" className={`rounded-xl border border-border/70 ${open ? "bg-surface-2/60" : "bg-surface/60"}`}>
      <div className="flex items-center gap-2.5 px-3 py-2">
        <button onClick={toggle} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
          <Icon name={open ? "chevron-down" : "chevron"} size={12} className="shrink-0 text-content-faint" />
          {running ? (
            <span className="w-3.5 h-3.5 shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          ) : (
            <Icon name={icon as any} size={14} className={`shrink-0 ${tone}`} />
          )}
          <span className="min-w-0">
            <span className="block truncate text-[13px] text-content">{task.description || task.task_id}</span>
            <span className="block truncate text-[11px] text-content-faint">
              {TYPE[task.task_type || ""] ? t(TYPE[task.task_type || ""]) : task.task_type || t("tasks.typeTask")}
              {task.is_backgrounded ? ` · ${t("tasks.background")}` : ""}
              {!running ? ` · ${STATUS[task.status] ? t(STATUS[task.status]) : task.status}` : ""}
              {chat ? ` · ${chat}` : ""}
            </span>
          </span>
        </button>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-content-faint">{start ? fmtMs(Math.max(0, end - start)) : ""}</span>
        {task.task_type === "local_agent" && inChat && (
          <button
            onClick={() => openAgent(task.tool_use_id!)}
            className="shrink-0 rounded-lg border border-border px-2 py-1 text-[11.5px] text-content-dim transition hover:border-violet/50 hover:text-violet"
            title={t("tasks.showSubagent")}
          >
            {t("common.details")}
          </button>
        )}
        {running && task.session_id && (
          <button
            onClick={async () => {
              setStopping(true);
              try {
                await stopTask(task.session_id!, task.task_id);
              } finally {
                setTimeout(() => setStopping(false), 4000);
              }
            }}
            disabled={stopping}
            className="grid place-items-center w-7 h-7 shrink-0 rounded-lg border border-border text-content-dim hover:text-danger hover:border-danger/50 transition disabled:opacity-40"
            title={t("tasks.stopTask")}
            aria-label={t("tasks.stopTask")}
          >
            {stopping ? <Icon name="spinner" size={12} spin /> : <span className="block w-2.5 h-2.5 rounded-[2px] bg-current" />}
          </button>
        )}
      </div>
      {open && task.summary && !running && <p className="px-3 pb-1.5 text-[11.5px] text-content-faint">{task.summary}</p>}
      {open && task.session_id && <Output sid={task.session_id} task={task} />}
    </div>
  );
}

/** Claude Code-style background tasks: running + completed, live output, stop. */
export default function TasksPanel({ sid, onClose }: { sid: string; onClose: () => void }) {
  const t = useT();
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const rowKey = (task: TaskInfo) => `${task.session_id}:${task.task_id}`;
  const toggleRow = (task: TaskInfo) => setOpened(prev => { const next = new Set(prev), key = rowKey(task); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const [scope, setScope] = useState<"chat" | "all">("chat");
  const bySession = useTaskStore((s) => s.bySession[sid]);
  const all = useTaskStore((s) => s.all);
  const loadSession = useTaskStore((s) => s.loadSession);
  const loadAll = useTaskStore((s) => s.loadAll);
  const paging = useTaskStore(s => s.paging[sid]);
  const loadMore = useTaskStore(s => s.loadMore);
  const tasks = useMemo(() => (scope === "chat" ? visibleTasks(bySession || [], paging?.ids || []).map((t) => ({ ...t, session_id: sid })) : all), [scope, bySession, paging?.ids, all, sid]);
  const running = tasks.filter(isRunning);
  const done = tasks.filter((t) => !isRunning(t));
  const now = useNow(running.length > 0);
  useBackHandler(true, onClose);

  useEffect(() => {
    if (scope === "chat") loadSession(sid, true).catch(() => {});
    else {
      loadAll().catch(() => {});
      const t = setInterval(() => loadAll().catch(() => {}), 5000);
      return () => clearInterval(t);
    }
  }, [scope, sid, loadSession, loadAll]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 top-[var(--window-chrome-height,0px)] z-[80] flex justify-end bg-scrim/40 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-[520px] flex-col border-l border-border bg-surface shadow-float animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
          <Icon name="activity" size={16} className="text-accent" />
          <span className="text-sm font-semibold">{t("tasks.title")}</span>
          <div className="ml-3 flex rounded-lg border border-border p-0.5">
            {(["chat", "all"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`rounded-md px-2 py-0.5 text-[11.5px] ${scope === s ? "bg-surface-3 text-content" : "text-content-faint"}`}
              >
                {s === "chat" ? t("tasks.thisChat") : t("tasks.allChats")}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="ml-auto rounded-md p-1 text-content-faint hover:bg-surface-3 hover:text-content" aria-label={t("common.close")}>
            <Icon name="x" size={17} />
          </button>
        </div>
        <div data-testid="tasks-list" className="flex-1 space-y-4 overflow-y-auto p-4">
          {scope === "chat" && <p className="text-[11.5px] text-content-faint">{t("tasks.recentTurns")}</p>}
          {scope === "chat" && paging?.error && <p role="alert" className="text-[12px] text-danger">{t("tasks.loadError")}</p>}
          {tasks.length === 0 && !(scope === "chat" && paging?.loading) && (
            <div className="grid place-items-center py-16 text-center">
              <Icon name="activity" size={24} className="mb-3 text-content-faint" />
              <p className="max-w-xs text-[13px] text-content-dim">
                {t("tasks.empty")}
              </p>
            </div>
          )}
          {running.length > 0 && (
            <section>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-content-faint">{t("tasks.runningN", { n: running.length })}</div>
              <div className="space-y-1.5">
                {running.map((t) => (
                  <Row key={`${t.session_id}:${t.task_id}`} task={t} now={now} showChat={scope === "all"} open={opened.has(rowKey(t))} toggle={() => toggleRow(t)} />
                ))}
              </div>
            </section>
          )}
          {done.length > 0 && (
            <section>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-content-faint">{t("tasks.finishedN", { n: done.length })}</div>
              <div className="space-y-1.5">
                {done.map((t) => (
                  <Row key={`${t.session_id}:${t.task_id}`} task={t} now={now} showChat={scope === "all"} open={opened.has(rowKey(t))} toggle={() => toggleRow(t)} />
                ))}
              </div>
            </section>
          )}
          {scope === "chat" && (paging?.hasMore || paging?.loading || paging?.error) && (
            <button data-testid="tasks-more" disabled={paging?.loading} className="btn-ghost w-full border border-border text-[12px]" onClick={() => paging?.cursor ? void loadMore(sid) : void loadSession(sid)}>
              {paging?.loading ? t("common.loading") : paging?.error ? t("common.retry") : t("tasks.loadMore")}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
