import { useState } from "react";
import Icon from "../../ui/Icon";
import { fmtMs } from "./toolMeta";

export default function ThinkingBlock({
  text,
  startedAt,
  endedAt,
  live,
}: {
  text: string;
  startedAt: number;
  endedAt?: number;
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const thinking = live && !endedAt;
  const label = thinking ? "Thinking…" : endedAt ? `Thought for ${fmtMs(endedAt - startedAt)}` : "Thought";
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 text-[12.5px] text-content-faint hover:text-content-dim transition"
      >
        <Icon name={open ? "chevron-down" : "chevron"} size={12} />
        <span className={thinking ? "animate-pulse-dot" : ""}>{label}</span>
      </button>
      {open && text.trim() && (
        <div className="mt-1.5 ml-[5px] max-h-80 overflow-y-auto border-l-2 border-border pl-3 text-[12.5px] italic leading-relaxed text-content-faint whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
