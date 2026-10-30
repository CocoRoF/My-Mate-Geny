import { useEffect, useMemo, useState } from "react";
import type { FlowItem, ToolActivity, Turn } from "../../stores/chatStore";
import Icon, { type IconName } from "../ui/Icon";
import Markdown from "../ui/Markdown";

type Kind = "terminal" | "file" | "search" | "web" | "remote" | "external";

const KIND_ICON: Record<Kind, IconName> = {
  terminal: "terminal",
  file: "file",
  search: "search",
  web: "external",
  remote: "server",
  external: "bolt",
};
const KIND_COLOR: Record<Kind, string> = {
  terminal: "text-content-dim bg-surface-3",
  file: "text-accent bg-accent/12",
  search: "text-violet bg-violet/12",
  web: "text-cyan bg-cyan/12",
  remote: "text-cyan bg-cyan/12",
  external: "text-success bg-success/12",
};

function toolMeta(name: string): { kind: Kind; label: string } {
  let label = name;
  if (name.startsWith("mcp__remote__")) return { kind: "remote", label: name.slice(13) };
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { kind: "external", label: parts[parts.length - 1] };
  }
  const n = name.toLowerCase();
  if (/(bash|shell|exec)/.test(n)) return { kind: "terminal", label };
  if (/(read|write|edit|file|notebook)/.test(n)) return { kind: "file", label };
  if (/(grep|glob|search|find)/.test(n)) return { kind: "search", label };
  if (/(web|fetch)/.test(n)) return { kind: "web", label };
  return { kind: "external", label };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

interface Step {
  text: string;
  rows: ToolActivity[];
}

function buildSteps(flow: FlowItem[], tools: ToolActivity[]): Step[] {
  const byId = new Map(tools.map((t) => [t.id, t]));
  const steps: Step[] = [];
  let cur: Step = { text: "", rows: [] };
  let sawTool = false;
  for (const item of flow) {
    if (item.kind === "text") {
      if (sawTool && item.text.trim()) {
        steps.push(cur);
        cur = { text: item.text, rows: [] };
        sawTool = false;
      } else {
        cur.text += item.text;
      }
    } else {
      const t = byId.get(item.toolId);
      if (t) {
        cur.rows.push(t);
        sawTool = true;
      }
    }
  }
  steps.push(cur);
  return steps.filter((s) => s.text.trim() || s.rows.length);
}

function useNow(active: boolean): number {
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
  const { kind, label } = toolMeta(tool.name);
  const running = tool.durationMs === undefined;
  const dur = running ? now - tool.startedAt : tool.durationMs!;
  const slow = dur > 10000;

  const preview =
    typeof tool.input === "object" && tool.input
      ? (tool.input as any).command || (tool.input as any).path || (tool.input as any).file_path || ""
      : "";

  return (
    <div className={`rounded-lg transition ${running ? "bg-accent-soft" : ""}`}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 px-2 py-1.5 text-left">
        <span className={`grid place-items-center w-6 h-6 rounded-md ${KIND_COLOR[kind]}`}>
          <Icon name={KIND_ICON[kind]} size={13} />
        </span>
        <span className="font-mono text-[12.5px] text-content/90 truncate">{label}</span>
        {preview && <span className="text-[11px] text-content-faint truncate hidden sm:inline">{String(preview).slice(0, 48)}</span>}
        {tool.isError && <span className="pill bg-danger/15 text-danger">error</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {running ? (
            <span className="flex items-center gap-1 text-[11px] text-accent">
              <span className="w-2 h-2 rounded-full border-[1.5px] border-accent border-t-transparent animate-spin" />
              {fmtMs(dur)}
            </span>
          ) : (
            <span
              className={`font-mono text-[10.5px] px-1.5 py-0.5 rounded-md ${
                tool.isError ? "text-danger bg-danger/10" : slow ? "text-warning bg-warning/10" : "text-content-faint bg-surface-3"
              }`}
            >
              {fmtMs(dur)}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1.5">
          {tool.input !== undefined && (
            <pre className="overflow-x-auto rounded-md bg-bg/60 border border-border p-2 text-[11px] text-content-dim font-mono">
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          )}
          {tool.output && (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-bg/60 border border-border p-2 text-[11px] text-content-dim font-mono max-h-72">
              {tool.output.slice(0, 6000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function ProcessTimeline({ turn }: { turn: Turn }) {
  const now = useNow(!turn.complete);
  const steps = useMemo(() => buildSteps(turn.flow, turn.tools), [turn.flow, turn.tools]);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const expanded = manualOpen ?? !turn.complete;

  const toolCount = turn.tools.length;
  const failCount = turn.tools.filter((t) => t.isError).length;
  const running = turn.tools.find((t) => t.durationMs === undefined);
  const start = turn.tools.length ? Math.min(...turn.tools.map((t) => t.startedAt)) : now;
  const end = turn.complete
    ? Math.max(...turn.tools.map((t) => t.startedAt + (t.durationMs || 0)), start)
    : now;
  const elapsed = fmtMs(end - start);

  const summary = turn.complete
    ? `${steps.length} steps · ${toolCount} tools${failCount ? ` · ${failCount} failed` : ""} · ${elapsed}`
    : `${elapsed} · ${toolCount} tools${running ? ` · ${toolMeta(running.name).label} running` : ""}`;

  return (
    <div>
      <button
        onClick={() => setManualOpen(!expanded)}
        className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[13px] hover:bg-surface-3 transition"
      >
        {!turn.complete ? (
          <span className="w-3.5 h-3.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        ) : failCount ? (
          <Icon name="x" size={14} className="text-danger" />
        ) : (
          <Icon name="check" size={14} className="text-success" />
        )}
        <span className="font-semibold text-content">Process</span>
        <span className="text-content-faint tabular-nums">{summary}</span>
        <Icon name={expanded ? "chevron-down" : "chevron"} size={13} className="text-content-faint" />
      </button>

      {expanded && (
        <div className="mt-2.5">
          {steps.map((step, i) => {
            const stepRunning = step.rows.some((r) => r.durationMs === undefined);
            const stepErr = step.rows.some((r) => r.isError);
            const done = turn.complete || (!stepRunning && i < steps.length - 1);
            return (
              <div key={i} className="relative pl-8 pb-3">
                {/* connector line */}
                {i < steps.length - 1 && (
                  <span className="absolute left-[10px] top-6 bottom-0 w-[2px] rounded bg-border" />
                )}
                {/* node */}
                <span
                  className={`absolute left-0 top-0 grid place-items-center w-[22px] h-[22px] rounded-full text-[11px] font-bold border ${
                    stepRunning
                      ? "text-accent bg-accent-soft border-accent/30"
                      : stepErr
                        ? "text-danger bg-danger/10 border-danger/30"
                        : done
                          ? "text-success bg-success/12 border-transparent"
                          : "text-content-faint bg-surface border-border"
                  }`}
                >
                  {stepRunning ? (
                    <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-accent border-t-transparent animate-spin" />
                  ) : done && !stepErr ? (
                    <Icon name="check" size={12} />
                  ) : (
                    i + 1
                  )}
                </span>
                {step.text.trim() && (
                  <div className="pt-0.5">
                    <Markdown>{step.text}</Markdown>
                  </div>
                )}
                {step.rows.length > 0 && (
                  <div className="mt-1.5 space-y-0.5 rounded-xl border border-border bg-surface/50 p-1">
                    {step.rows.map((t) => (
                      <ToolRow key={t.id} tool={t} now={now} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
