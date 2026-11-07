/** Her status on the stage: who and where she is and how she is doing. A tap opens the Life panel. */
import type { Mate, MateLifeSummary } from "../../../api/mates";
import type { BodyMood } from "../../../mate/types";
import { useLang, useT } from "../../../i18n";
import Icon from "../../ui/Icon";
import { lifeName, needTone, NEEDS } from "./needs";

export default function LifeHud({ mate, life, mood, moodText, onOpen }: { mate: Mate; life: MateLifeSummary; mood: BodyMood; moodText: string; onOpen?: () => void }) {
  const t = useT();
  const locale = useLang();
  const place = lifeName(life.place_name, locale, life.place);
  const doing = lifeName(life.activity_name, locale);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="absolute inset-x-2 bottom-2 z-10 flex items-end justify-between gap-2 text-left"
      title={t("life.openTitle", { name: mate.name })}
      data-testid="mate-life-hud"
    >
      <span className="life-chip min-w-0 max-w-[68%] rounded-xl px-2.5 py-1.5">
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
      <span className="life-chip flex shrink-0 items-center gap-1.5 rounded-xl px-2 py-1.5" data-testid="mate-life-needs">
        {NEEDS.map(({ need, icon, label }) => {
          const v = life.needs?.[need] ?? 0;
          return (
            <span key={need} className="flex flex-col items-center gap-[3px]" title={t(label)}>
              <Icon name={icon} size={10} className="opacity-85" />
              <span className="h-[3px] w-3.5 overflow-hidden rounded-full bg-white/20">
                <span className={`block h-full rounded-full ${needTone(v)}`} style={{ width: `${Math.max(8, Math.round((1 - v) * 100))}%` }} />
              </span>
            </span>
          );
        })}
      </span>
    </button>
  );
}
