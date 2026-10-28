import { useState } from "react";
import { useChatStore } from "../../stores/chatStore";

export default function InputBar({ onSend }: { onSend: (text: string) => void }) {
  const [input, setInput] = useState("");
  const isStreaming = useChatStore((s) => s.isStreaming);
  const cost = useChatStore((s) => s.runningCostUsd);

  const submit = () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    onSend(text);
    setInput("");
  };

  return (
    <div className="border-t border-border bg-panel p-3">
      <div className="flex items-end gap-2">
        <div className="text-xs text-gray-500 w-16 shrink-0">
          {isStreaming ? (
            <span className="text-accent animate-pulse">●  working</span>
          ) : (
            <span>${cost.toFixed(4)}</span>
          )}
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Type a message…  (Enter to send, Shift+Enter for newline)"
          className="flex-1 resize-none bg-black/40 border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent"
        />
        <button
          onClick={submit}
          disabled={isStreaming || !input.trim()}
          className="px-4 py-2 rounded bg-accent text-black font-medium text-sm disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
