import { useRef, useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import Icon from "../ui/Icon";

export default function InputBar({ onSend }: { onSend: (text: string) => void }) {
  const [input, setInput] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const cost = useChatStore((s) => s.runningCostUsd);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };

  const submit = () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    onSend(text);
    setInput("");
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
  };

  return (
    <div className="px-5 pb-5">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface-2/80 p-2 shadow-card backdrop-blur-sm focus-within:border-accent/50 transition">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              grow();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Message the agent…   (Enter to send · Shift+Enter for newline)"
            className="flex-1 resize-none bg-transparent px-2.5 py-1.5 text-sm text-content placeholder:text-content-faint outline-none max-h-[200px]"
          />
          <button
            onClick={submit}
            disabled={isStreaming || !input.trim()}
            className="grid place-items-center w-9 h-9 rounded-xl text-white transition disabled:opacity-30"
            style={{ background: "linear-gradient(135deg,#6e8bff,#5b7cff)" }}
            title="Send"
          >
            {isStreaming ? <Icon name="spinner" size={16} spin /> : <Icon name="arrow-up" size={17} />}
          </button>
        </div>
        <div className="flex items-center justify-between px-1.5 pt-1.5 text-[10px] text-content-faint">
          <span>
            {isStreaming ? (
              <span className="inline-flex items-center gap-1.5 text-accent">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot" /> working…
              </span>
            ) : (
              "ready"
            )}
          </span>
          <span className="font-mono">session cost ${cost.toFixed(4)}</span>
        </div>
      </div>
    </div>
  );
}
