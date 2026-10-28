import { useState } from "react";
import type { Turn } from "../../stores/chatStore";

function ToolRow({
  name,
  input,
  output,
  isError,
}: {
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 text-xs border border-border rounded bg-black/30">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-2 py-1 text-left"
      >
        <span className="text-cyan-400">⚙ {name}</span>
        {isError && <span className="text-red-400">error</span>}
        <span className="ml-auto text-gray-500">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <pre className="px-2 py-1 overflow-x-auto text-gray-400 border-t border-border whitespace-pre-wrap">
          {JSON.stringify(input, null, 2)}
          {output ? `\n\n→ ${output.slice(0, 2000)}` : ""}
        </pre>
      )}
    </div>
  );
}

export default function MessageItem({ turn }: { turn: Turn }) {
  const isUser = turn.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 ${
          isUser ? "bg-accent/20" : "bg-panel border border-border"
        }`}
      >
        {!isUser && turn.thinking && (
          <details className="mb-1 text-xs text-gray-500">
            <summary className="cursor-pointer">thinking…</summary>
            <pre className="whitespace-pre-wrap mt-1">{turn.thinking}</pre>
          </details>
        )}
        {!isUser && turn.tools.map((t) => <ToolRow key={t.id} {...t} />)}
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {turn.text}
          {!turn.complete && <span className="animate-pulse">▋</span>}
        </div>
        {!isUser && turn.complete && turn.costUsd ? (
          <div className="mt-1 text-[10px] text-gray-500">
            {turn.model} · ${turn.costUsd.toFixed(4)}
          </div>
        ) : null}
      </div>
    </div>
  );
}
