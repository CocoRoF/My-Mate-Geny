import { useState } from "react";
import type { Turn, ToolActivity } from "../../stores/chatStore";
import Icon from "../ui/Icon";
import Markdown from "../ui/Markdown";

function ToolCard({ tool }: { tool: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const remote = tool.name.startsWith("mcp__remote__");
  const label = tool.name.replace("mcp__remote__", "").replace("mcp__", "");
  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-border bg-surface/60">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-3/50"
      >
        <Icon name={remote ? "server" : "terminal"} size={13} className="text-cyan" />
        <span className="font-mono text-[12px] text-content/90">{label}</span>
        {remote && <span className="pill bg-cyan/10 text-cyan">remote</span>}
        {tool.isError && <span className="pill bg-danger/15 text-danger">error</span>}
        {!tool.output && !tool.isError && (
          <Icon name="spinner" size={12} spin className="text-content-faint" />
        )}
        <Icon
          name="chevron"
          size={13}
          className={`ml-auto text-content-faint transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border px-2.5 py-2 space-y-2">
          {tool.input !== undefined && (
            <pre className="overflow-x-auto rounded bg-bg/60 p-2 text-[11px] text-content-dim font-mono">
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          )}
          {tool.output && (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-bg/60 p-2 text-[11px] text-content-dim font-mono max-h-64">
              {tool.output.slice(0, 4000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default function MessageItem({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end animate-fade-in">
        <div className="max-w-[78%] rounded-2xl rounded-br-md bg-accent-soft border border-accent/25 px-3.5 py-2 text-sm text-content whitespace-pre-wrap">
          {turn.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 animate-fade-in">
      <div className="mt-0.5 grid place-items-center w-7 h-7 shrink-0 rounded-lg bg-gradient-to-br from-accent to-cyan shadow-glow">
        <Icon name="bolt" size={14} className="text-white" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        {turn.thinking && (
          <details className="text-xs text-content-faint">
            <summary className="cursor-pointer select-none hover:text-content-dim">thinking</summary>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{turn.thinking}</pre>
          </details>
        )}
        {turn.tools.map((t) => (
          <ToolCard key={t.id} tool={t} />
        ))}
        {turn.text ? (
          <Markdown>{turn.text}</Markdown>
        ) : (
          !turn.complete &&
          turn.tools.length === 0 && (
            <div className="flex items-center gap-1.5 text-content-faint text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot" />
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot [animation-delay:0.2s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot [animation-delay:0.4s]" />
            </div>
          )
        )}
        {!turn.complete && turn.text && (
          <span className="inline-block w-1.5 h-4 translate-y-0.5 bg-accent animate-pulse-dot" />
        )}
        {turn.complete && (turn.costUsd || turn.model) ? (
          <div className="flex items-center gap-2 pt-0.5 text-[10px] text-content-faint">
            {turn.model && <span className="font-mono">{turn.model}</span>}
            {turn.costUsd ? <span>· ${turn.costUsd.toFixed(4)}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
