import { useEffect, useMemo, useState } from "react";
import type { ToolActivity } from "../../../stores/chatStore";
import Icon from "../../ui/Icon";
import ToolDetail from "./ToolDetail";
import { useSessionStore } from "../../../stores/sessionStore";
import { fmtMs, summarize, toolMeta } from "./toolMeta";

const useRoot = () =>
  useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId)?.workspace_path || null);

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function ToolRow({ tool, now }: { tool: ToolActivity; now: number }) {
  const [open, setOpen] = useState(false);
  const root = useRoot();
  const m = toolMeta(tool.name, tool.input, root);
  const running = tool.durationMs === undefined;
  const dur = running ? now - tool.startedAt : tool.durationMs!;
  return (
    <div className={`rounded-lg ${open ? "bg-surface-2/60" : ""}`}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2/70 transition"
      >
        <span className={`grid place-items-center w-5 h-5 shrink-0 rounded-md ${m.tone}`}>
          <Icon name={m.icon} size={11} />
        </span>
        <span className="shrink-0 text-[12.5px] font-medium text-content/90">{m.label}</span>
        <span className="min-w-0 truncate font-mono text-[11.5px] text-content-faint">{m.target}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {tool.isError && <span className="pill bg-danger/15 text-danger">failed</span>}
          {running ? (
            <span className="flex items-center gap-1 text-[11px] text-accent tabular-nums">
              <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-accent border-t-transparent animate-spin" />
              {fmtMs(dur)}
            </span>
          ) : (
            <span className={`font-mono text-[10.5px] tabular-nums ${dur > 10000 ? "text-warning" : "text-content-faint"}`}>
              {fmtMs(dur)}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 pt-0.5">
          <ToolDetail tool={tool} root={root} />
        </div>
      )}
    </div>
  );
}

const LIVE_TAIL = 3;

/** A run of consecutive tool calls: one summary line, expandable. */
export default function ToolGroup({ tools }: { tools: ToolActivity[]; turnLive?: boolean }) {
  const running = tools.find((t) => t.durationMs === undefined);
  const now = useNow(!!running);
  const [open, setOpen] = useState<boolean | null>(null);
  const root = useRoot();
  const metas = useMemo(() => tools.map((t) => toolMeta(t.name, t.input, root)), [tools, root]);
  const failed = tools.filter((t) => t.isError).length;
  const start = Math.min(...tools.map((t) => t.startedAt));
  const end = running ? now : Math.max(...tools.map((t) => t.startedAt + (t.durationMs || 0)));
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
        ) : (
          <Icon name="check" size={14} className="shrink-0 text-success" />
        )}
        <span className="min-w-0 truncate text-[13px] text-content-dim">
          {running ? (
            <>
              <span className="text-content">{toolMeta(running.name, running.input, root).running}</span>
              {tools.length > 1 && <span className="text-content-faint"> · {summarize(metas)}</span>}
            </>
          ) : (
            summarize(metas)
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {failed > 0 && <span className="pill bg-warning/15 text-warning">{failed} failed</span>}
          <span className="font-mono text-[10.5px] text-content-faint tabular-nums">{fmtMs(end - start)}</span>
          <Icon name={expanded ? "chevron-down" : "chevron"} size={13} className="text-content-faint" />
        </span>
      </button>
      {visible.length > 0 && (
        <div className="space-y-0.5 border-t border-border/60 p-1">
          {!expanded && hidden > 0 && (
            <button onClick={() => setOpen(true)} className="px-2 py-1 text-[11px] text-content-faint hover:text-content-dim">
              + {hidden} earlier
            </button>
          )}
          {visible.map((t) => (
            <ToolRow key={t.id} tool={t} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
