import { useEffect, useState } from "react";
import Icon from "../../ui/Icon";
import { fmtMs } from "./toolMeta";
import { useT } from "../../../i18n";

export default function ThinkingBlock({
  text,
  startedAt,
  endedAt,
  live,
  timingKnown = false,
  scope,
}: {
  text: string;
  startedAt: number;
  endedAt?: number;
  live: boolean;
  timingKnown?: boolean;
  scope?: "response";
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const thinking = live && endedAt === undefined;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!thinking || !timingKnown) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [thinking, timingKnown, startedAt]);
  const elapsed = fmtMs(Math.max(0, (endedAt ?? now) - startedAt));
  const label = scope === "response" ? t(thinking ? "turn.generatingFor" : "turn.generatedFor", {d: elapsed})
    : thinking ? timingKnown ? t("turn.thinkingFor", { d: elapsed }) : t("turn.thinking")
    : endedAt !== undefined && timingKnown ? t("turn.thoughtFor", { d: elapsed }) : t("turn.thought");
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={text.trim() ? open : undefined}
        disabled={!text.trim()}
        title={scope === "response" ? t("turn.responseTiming") : undefined}
        className={`inline-flex items-center gap-1.5 text-[12.5px] transition ${thinking ? "font-medium text-accent" : "text-content-faint hover:text-content-dim"}`}
      >
        <Icon name={thinking ? "spinner" : open ? "chevron-down" : "chevron"} spin={thinking} size={12} />
        <span>{label}</span>
      </button>
      {open && text.trim() && (
        <div className="mt-1.5 ml-[5px] max-h-80 overflow-y-auto border-l-2 border-border pl-3 text-[12.5px] italic leading-relaxed text-content-faint whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
