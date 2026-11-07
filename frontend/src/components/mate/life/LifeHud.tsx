/** Her status on the stage: who and where she is. A tap opens her Status window (how she is doing is there). */
import type { Mate, MateLifeSummary } from "../../../api/mates";
import type { BodyMood } from "../../../mate/types";
import { useLang, useT } from "../../../i18n";
import Icon from "../../ui/Icon";
import { lifeName } from "./needs";

export default function LifeHud({ mate, life, mood, moodText, onOpen }: { mate: Mate; life: MateLifeSummary; mood: BodyMood; moodText: string; onOpen?: () => void }) {
  const t = useT();
  const locale = useLang();
  const place = lifeName(life.place_name, locale, life.place);
  const doing = lifeName(life.activity_name, locale);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="absolute bottom-2 left-2 z-10 flex max-w-[calc(100%-1rem)] items-end text-left"
      title={t("life.openTitle", { name: mate.name })}
      data-testid="mate-life-hud"
    >
      <span className="life-chip min-w-0 max-w-full rounded-xl px-2.5 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-tight">
          <span className="truncate font-semibold">{mate.name}</span>
          {moodText && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] opacity-80" data-testid="mate-mood">
              <span className={`h-1.5 w-1.5 rounded-full ${mood === "talking" ? "bg-success" : mood === "thinking" ? "bg-accent animate-pulse-dot" : mood === "listening" ? "bg-cyan" : "bg-white/60"}`} />
              {moodText}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-tight opacity-85" data-testid="mate-life-where">
          <Icon name="map-pin" size={10} className="shrink-0" />
          <span className="truncate">{doing ? `${place} · ${doing}` : place}</span>
        </span>
      </span>
    </button>
  );
}
