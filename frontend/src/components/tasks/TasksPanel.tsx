import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { stopTask, taskOutput } from "../../api/sessions";
import { useSessionStore } from "../../stores/sessionStore";
import { isRunning, useTaskStore } from "../../stores/taskStore";
import type { TaskInfo } from "../../types";
import Icon from "../ui/Icon";
import { fmtMs } from "../chat/turn/toolMeta";

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const TYPE: Record<string, string> = { local_bash: "command", local_agent: "subagent", remote_agent: "agent" };

function Output({ sid, task }: { sid: string; task: TaskInfo }) {
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
      {text === null ? "Loading…" : text ? (truncated ? "… (earlier output trimmed)\n" : "") + text : "(no output captured)"}
    </pre>
  );
}

function Row({ task, now, showChat }: { task: TaskInfo; now: number; showChat: boolean }) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const sessions = useSessionStore((s) => s.sessions);
  const running = isRunning(task);
  const start = (task.started_at || 0) * 1000;
  const end = task.ended_at ? task.ended_at * 1000 : now;
  const icon = running ? null : task.status === "completed" ? "check" : task.status === "failed" ? "x" : "ban";
  const tone = task.status === "completed" ? "text-success" : task.status === "failed" ? "text-danger" : "text-content-faint";
  const chat = showChat ? sessions.find((s) => s.id === task.session_id)?.title : null;
  return (
    <div className={`rounded-xl border border-border/70 ${open ? "bg-surface-2/60" : "bg-surface/60"}`}>
      <div className="flex items-center gap-2.5 px-3 py-2">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
          <Icon name={open ? "chevron-down" : "chevron"} size={12} className="shrink-0 text-content-faint" />
          {running ? (
            <span className="w-3.5 h-3.5 shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          ) : (
            <Icon name={icon as any} size={14} className={`shrink-0 ${tone}`} />
          )}
          <span className="min-w-0">
            <span className="block truncate text-[13px] text-content">{task.description || task.task_id}</span>
            <span className="block truncate text-[11px] text-content-faint">
              {TYPE[task.task_type || ""] || task.task_type || "task"}
              {task.is_backgrounded ? " · background" : ""}
              {!running ? ` · ${task.status}` : ""}
              {chat ? ` · ${chat}` : ""}
            </span>
          </span>
        </button>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-content-faint">{start ? fmtMs(Math.max(0, end - start)) : ""}</span>
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
            title="Stop this task"
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
  const [scope, setScope] = useState<"chat" | "all">("chat");
  const bySession = useTaskStore((s) => s.bySession[sid]);
  const all = useTaskStore((s) => s.all);
  const loadSession = useTaskStore((s) => s.loadSession);
  const loadAll = useTaskStore((s) => s.loadAll);
  const tasks = useMemo(() => (scope === "chat" ? (bySession || []).map((t) => ({ ...t, session_id: sid })) : all), [scope, bySession, all, sid]);
  const running = tasks.filter(isRunning);
  const done = tasks.filter((t) => !isRunning(t));
  const now = useNow(running.length > 0);

  useEffect(() => {
    if (scope === "chat") loadSession(sid).catch(() => {});
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
    <div className="fixed inset-0 z-[80] flex justify-end bg-black/40 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-[520px] flex-col border-l border-border bg-surface shadow-float animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
          <Icon name="activity" size={16} className="text-accent" />
          <span className="text-sm font-semibold">Background tasks</span>
          <div className="ml-3 flex rounded-lg border border-border p-0.5">
            {(["chat", "all"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`rounded-md px-2 py-0.5 text-[11.5px] ${scope === s ? "bg-surface-3 text-content" : "text-content-faint"}`}
              >
                {s === "chat" ? "This chat" : "All chats"}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="ml-auto rounded-md p-1 text-content-faint hover:bg-surface-3 hover:text-content">
            <Icon name="x" size={17} />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {tasks.length === 0 && (
            <div className="grid place-items-center py-16 text-center">
              <Icon name="activity" size={24} className="mb-3 text-content-faint" />
              <p className="max-w-xs text-[13px] text-content-dim">
                Commands and subagents the agent runs in the background show up here — e.g. ask it to start a dev
                server or a long build “in the background”.
              </p>
            </div>
          )}
          {running.length > 0 && (
            <section>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-content-faint">Running {running.length}</div>
              <div className="space-y-1.5">
                {running.map((t) => (
                  <Row key={`${t.session_id}:${t.task_id}`} task={t} now={now} showChat={scope === "all"} />
                ))}
              </div>
            </section>
          )}
          {done.length > 0 && (
            <section>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-content-faint">Finished {done.length}</div>
              <div className="space-y-1.5">
                {done.map((t) => (
                  <Row key={`${t.session_id}:${t.task_id}`} task={t} now={now} showChat={scope === "all"} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
