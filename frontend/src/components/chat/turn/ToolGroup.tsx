import { useEffect, useMemo, useState } from "react";
import { fileUrl } from "../../../api/sessions";
import type { ToolActivity } from "../../../stores/chatStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { openPath } from "../../../stores/workbenchStore";
import { isRunning, useTaskStore } from "../../../stores/taskStore";
import type { Attachment, TaskInfo } from "../../../types";
import Lightbox from "../../attachments/Lightbox";
import Icon from "../../ui/Icon";
import ToolDetail from "./ToolDetail";
import { fmtMs, summarize, toolMeta } from "./toolMeta";

const useActive = () => useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId));

/** A call cut off by Stop: the CLI reports it as a rejected (error) result. */
export const wasStopped = (t: ToolActivity) =>
  !!t.isError && /doesn't want to proceed|tool use was rejected|interrupted to apply/i.test(t.output || "");
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Live task state for a tool call (background command / long-running task). */
function useTask(tool: ToolActivity): TaskInfo | undefined {
  const sid = useSessionStore((s) => s.activeId);
  const live = useTaskStore((s) =>
    sid && tool.task ? s.bySession[sid]?.find((t) => t.task_id === tool.task!.task_id) : undefined,
  );
  return live || tool.task;
}

/** Images a group of tools produced or looked at: returned images + image files read/written. */
export function imagesOf(tools: ToolActivity[], sid: string | undefined): Attachment[] {
  const out: Attachment[] = [];
  for (const t of tools) {
    if (t.images?.length) out.push(...t.images);
    const i = (t.input || {}) as Record<string, any>;
    const p = String(i.file_path || i.path || "");
    const n = t.name.replace(/^mcp__remote__/, "").toLowerCase();
    if (
      sid && !t.images?.length && p && IMAGE_RE.test(p) && t.durationMs !== undefined && !t.isError &&
      ["read", "write", "remote_read", "remote_write"].includes(n)
    ) {
      const url = fileUrl(sid, p);
      out.push({
        id: `${t.id}:${p}`, name: p.split("/").pop() || p, mime: "image/*", size: 0, kind: "image",
        width: null, height: null, url, preview_url: url, created_at: "",
      });
    }
  }
  return out;
}

function MediaStrip({ images }: { images: Attachment[] }) {
  const [viewing, setViewing] = useState<number | null>(null);
  if (!images.length) return null;
  const shown = images.slice(0, 6);
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
      {shown.map((img, i) => (
        <button
          key={img.id}
          onClick={(e) => {
            e.stopPropagation();
            setViewing(i);
          }}
          className="group relative h-20 w-28 overflow-hidden rounded-lg border border-border bg-surface-3"
          title={img.name}
        >
          <img src={img.preview_url} alt={img.name} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.04]" />
          {i === shown.length - 1 && images.length > shown.length && (
            <span className="absolute inset-0 grid place-items-center bg-black/55 text-sm font-medium text-white">
              +{images.length - shown.length}
            </span>
          )}
        </button>
      ))}
      {viewing !== null && <Lightbox images={images} start={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function TaskPill({ task, now }: { task: TaskInfo; now: number }) {
  if (isRunning(task)) {
    const since = task.started_at ? now - task.started_at * 1000 : 0;
    return (
      <span className="pill bg-accent-soft text-accent" title={task.description || ""}>
        <span className="w-2 h-2 rounded-full border-[1.5px] border-accent border-t-transparent animate-spin" />
        {task.is_backgrounded ? "background" : "running"} {since > 0 ? fmtMs(since) : ""}
      </span>
    );
  }
  const tone = task.status === "completed" ? "bg-success/12 text-success" : "bg-surface-3 text-content-faint";
  return <span className={`pill ${tone}`}>{task.is_backgrounded ? `background · ${task.status}` : task.status}</span>;
}

function ToolRow({ tool, now, children }: { tool: ToolActivity; now: number; children: ToolActivity[] }) {
  const [open, setOpen] = useState(false);
  const session = useActive();
  const m = toolMeta(tool.name, tool.input, session?.workspace_path);
  const task = useTask(tool);
  const background = !!((tool.input as any)?.run_in_background || task?.is_backgrounded);
  const running = tool.durationMs === undefined;
  const dur = running ? now - tool.startedAt : tool.durationMs!;
  const kidsRunning = children.filter((c) => c.durationMs === undefined);
  // Read / Edit / Write / List targets open in the workbench (file tab / explorer).
  const inp = (tool.input || {}) as Record<string, any>;
  const filePath =
    !children.length && (m.category === "read" || m.category === "edit") && !Array.isArray(inp.changes)
      ? String(inp.file_path || inp.path || inp.notebook_path || "")
      : "";
  return (
    <div className={`rounded-lg ${open ? "bg-surface-2/60" : ""}`}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2/70 transition"
      >
        <span className={`grid place-items-center w-5 h-5 shrink-0 rounded-md ${m.tone}`}>
          <Icon name={m.icon} size={11} />
        </span>
        <span className={`shrink-0 max-w-[60%] truncate text-[12.5px] ${m.descriptive ? "text-content/90" : "font-medium text-content/90"}`}>
          {m.label}
        </span>
        <span className="min-w-0 truncate font-mono text-[11.5px] text-content-faint">
          {filePath && session ? (
            <span
              role="link"
              onClick={(e) => {
                e.stopPropagation();
                openPath(session, filePath);
              }}
              className="underline decoration-dotted decoration-content-faint/60 underline-offset-[3px] hover:text-accent hover:decoration-accent"
              title={`Open ${filePath}`}
            >
              {m.target}
            </span>
          ) : children.length ? (
            `${children.length} tool${children.length > 1 ? "s" : ""}`
          ) : (
            m.target
          )}
          {kidsRunning.length ? ` · ${toolMeta(kidsRunning[0].name, kidsRunning[0].input, session?.workspace_path).running}` : ""}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {tool.isError && (wasStopped(tool) ? (
            <span className="pill bg-surface-3 text-content-dim">stopped</span>
          ) : (
            <span className="pill bg-danger/15 text-danger">failed</span>
          ))}
          {task && (background || isRunning(task)) && <TaskPill task={task} now={now} />}
          {running && !(task && isRunning(task)) ? (
            <span className="flex items-center gap-1 text-[11px] text-accent tabular-nums">
              <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-accent border-t-transparent animate-spin" />
              {fmtMs(dur)}
            </span>
          ) : !running ? (
            <span className={`font-mono text-[10.5px] tabular-nums ${dur > 10000 ? "text-warning" : "text-content-faint"}`}>
              {fmtMs(dur)}
            </span>
          ) : null}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2 pt-0.5">
          {m.descriptive && m.category === "command" && (
            <div className="text-[11px] text-content-faint">{tool.name === "shell" ? "Codex shell" : "Command"}</div>
          )}
          <ToolDetail tool={tool} root={session?.workspace_path} />
          {children.length > 0 && (
            <div className="rounded-lg border border-border/70 bg-surface/60 p-1">
              {children.map((c) => (
                <ToolRow key={c.id} tool={c} now={now} children={[]} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const LIVE_TAIL = 3;

/** A run of consecutive tool calls: one summary line, expandable. */
export default function ToolGroup({
  tools,
  allTools,
  defaultOpen = false,
}: {
  tools: ToolActivity[];
  allTools?: ToolActivity[];
  defaultOpen?: boolean; // list every call from the start (subagent detail)
}) {
  const session = useActive();
  const kids = useMemo(() => {
    const map = new Map<string, ToolActivity[]>();
    for (const t of allTools || []) if (t.parent) map.set(t.parent, [...(map.get(t.parent) || []), t]);
    return map;
  }, [allTools]);
  const everything = useMemo(() => [...tools, ...tools.flatMap((t) => kids.get(t.id) || [])], [tools, kids]);
  const running = tools.find((t) => t.durationMs === undefined);
  const now = useNow(!!running || everything.some((t) => t.task && isRunning(t.task)));
  const [open, setOpen] = useState<boolean | null>(defaultOpen ? true : null);
  const metas = useMemo(() => tools.map((t) => toolMeta(t.name, t.input, session?.workspace_path)), [tools, session?.workspace_path]);
  const failed = tools.filter((t) => t.isError && !wasStopped(t)).length;
  const stopped = tools.filter(wasStopped).length;
  const start = Math.min(...tools.map((t) => t.startedAt));
  const end = running ? now : Math.max(...tools.map((t) => t.startedAt + (t.durationMs || 0)));
  const images = useMemo(() => imagesOf(everything, session?.id), [everything, session?.id]);
  const bgRunning = everything.filter((t) => t.task && isRunning(t.task) && t.task.is_backgrounded).length;
  // While a call is running the group shows its latest calls; once done it
  // folds to one summary line (expand for everything).
  const live = !!running;
  const expanded = open ?? false;
  const visible = expanded ? tools : live ? tools.slice(-LIVE_TAIL) : [];
  const hidden = tools.length - visible.length;

  return (
    <div className="rounded-xl border border-border/80 bg-surface/50">
      <button
        onClick={() => setOpen(!expanded)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2/50 rounded-xl transition"
      >
        {running ? (
          <span className="w-3.5 h-3.5 shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        ) : failed ? (
          <Icon name="alert-circle" size={14} className="shrink-0 text-warning" />
        ) : stopped ? (
          <Icon name="ban" size={14} className="shrink-0 text-content-faint" />
        ) : (
          <Icon name="check" size={14} className="shrink-0 text-success" />
        )}
        <span className="min-w-0 truncate text-[13px] text-content-dim">
          {running ? (
            <>
              <span className="text-content">{toolMeta(running.name, running.input, session?.workspace_path).running}</span>
              {tools.length > 1 && <span className="text-content-faint"> · {summarize(metas)}</span>}
            </>
          ) : (
            summarize(metas)
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {bgRunning > 0 && <span className="pill bg-accent-soft text-accent">{bgRunning} in background</span>}
          {failed > 0 && <span className="pill bg-warning/15 text-warning">{failed} failed</span>}
          <span className="font-mono text-[10.5px] text-content-faint tabular-nums">{fmtMs(end - start)}</span>
          <Icon name={expanded ? "chevron-down" : "chevron"} size={13} className="text-content-faint" />
        </span>
      </button>
      <MediaStrip images={images} />
      {visible.length > 0 && (
        <div className="space-y-0.5 border-t border-border/60 p-1">
          {!expanded && hidden > 0 && (
            <button onClick={() => setOpen(true)} className="px-2 py-1 text-[11px] text-content-faint hover:text-content-dim">
              + {hidden} earlier
            </button>
          )}
          {visible.map((t) => (
            <ToolRow key={t.id} tool={t} now={now} children={kids.get(t.id) || []} />
          ))}
        </div>
      )}
    </div>
  );
}
