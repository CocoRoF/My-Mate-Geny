import type { Turn } from "../../stores/chatStore";
import Icon from "../ui/Icon";
import Markdown from "../ui/Markdown";
import ProcessTimeline from "./ProcessTimeline";

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

  const usedTools = turn.tools.length > 0;

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

        {usedTools ? (
          <ProcessTimeline turn={turn} />
        ) : turn.text ? (
          <Markdown>{turn.text}</Markdown>
        ) : (
          !turn.complete && (
            <div className="flex items-center gap-1.5 text-content-faint text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot" />
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot [animation-delay:0.2s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot [animation-delay:0.4s]" />
            </div>
          )
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
