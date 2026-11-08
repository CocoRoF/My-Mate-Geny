import { useEffect, useState } from "react";
import type { Mate } from "../../api/mates";
import { LiveMateAvatar } from "../../mate/avatar/MateAvatar";
import type { BodyMood, MateReact } from "../../mate/types";
import type { Caption } from "../../mate/useMateConversation";
import { useT, type MsgKey, type TFunction } from "../../i18n";
import type { ReactNode } from "react";
import LifeBackdrop from "./life/LifeBackdrop";
import LifeHud from "./life/LifeHud";
import StageMenu, { type StageWindowKind } from "./stage/StageMenu";

const MOOD_KEY: Record<BodyMood, MsgKey | null> = {
  idle: null,
  listening: "mate.moodListening",
  thinking: "mate.moodThinking",
  talking: "mate.moodTalking",
  away: "mate.moodAway",
};

/** "listening…", "thinking…" … ("" while idle) */
export const moodLabel = (t: TFunction, mood: BodyMood): string => {
  const k = MOOD_KEY[mood];
  return k ? t(k) : "";
};

/** a caption that fades `ms` after it last changed */
export function useFadingCaption(caption: Caption | null, ms = 6500): string | null {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!caption) return;
    setShown(caption.text);
    const t = setTimeout(() => setShown(null), ms);
    return () => clearTimeout(t);
  }, [caption, ms]);
  return shown;
}

/** "Built-in" (shipped with the app) + "Edited" once the user changed its persona/avatar */
export function BuiltinBadge({ mate }: { mate: Mate }) {
  const t = useT();
  if (!mate.builtin) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-testid="mate-builtin-badge">
      <span className="pill bg-violet/12 text-violet" title={t("mate.builtinTitle")}>
        {t("mate.builtin")}
      </span>
      {mate.customized && (
        <span className="pill bg-surface-3 text-content-faint" title={t("mate.editedTitle")}>
          {t("mate.edited")}
        </span>
      )}
    </span>
  );
}

/** a small round picture of a mate: its home still when it has one, else its initial */
export function MateThumb({ mate, className = "h-7 w-7" }: { mate: Mate; className?: string }) {
  const a = mate.avatar;
  const src = a.kind === "video" || a.kind === "photo" ? a.rig.home || a.rig.stills?.neutral || "" : a.kind === "livliv" ? a.livliv.avatar || a.livliv.cover || "" : "";
  const ch = [...(mate.name.trim() || "?")][0].toUpperCase();
  return (
    <span className={`relative shrink-0 overflow-hidden rounded-full bg-gradient-to-br from-accent to-violet ${className}`}>
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover object-top" draggable={false} />
      ) : (
        <span className="grid h-full w-full place-items-center text-[12px] font-semibold text-white">{ch}</span>
      )}
    </span>
  );
}

export default function MateStage({
  mate,
  mood,
  videoMood,
  react,
  caption,
  size = "lg",
  onTap,
  showName = true,
  className = "",
  onLife,
  menu,
  window: overlay,
}: {
  mate: Mate;
  mood: BodyMood;
  videoMood: BodyMood;
  react: MateReact;
  caption?: Caption | null;
  size?: "lg" | "sm";
  onTap?: (area: string | null) => void;
  showName?: boolean;
  className?: string;
  /** her status on the stage was tapped */
  onLife?: () => void;
  /** her menu on the stage (Status, Places, Outfits), and which of its windows is open */
  menu?: { open: StageWindowKind | null; onOpen: (k: StageWindowKind) => void; compact?: boolean };
  /** the open window, drawn over her */
  window?: ReactNode;
}) {
  const t = useT();
  const life = mate.life?.enabled && mate.life.art ? mate.life : null;
  const line = useFadingCaption(caption ?? null);
  const ml = moodLabel(t, mood);
  return (
    <div className={`relative flex min-h-0 flex-col items-center ${life ? "overflow-hidden" : ""} ${className}`} data-testid="mate-stage" data-mood={mood}>
      {life && <LifeBackdrop life={life} />}
      {line && (
        <div className={`pointer-events-none absolute left-3 top-2 z-10 flex justify-center ${menu ? (menu.compact ? "right-[60px]" : "right-[76px]") : "right-3"}`}>
          <div
            key={line}
            className="max-w-[min(92%,380px)] rounded-2xl border border-border bg-surface-2/95 px-3 py-1.5 text-center text-[13px] text-content shadow-float animate-fade-in"
            data-testid="mate-caption"
          >
            {line}
          </div>
        </div>
      )}
      <div className="relative min-h-0 w-full flex-1">
        {/* keyed by the mate: switching mates never shows (or keeps playing) the previous mate's body */}
        <LiveMateAvatar key={mate.id} mate={mate} size={size} mood={mood} videoMood={videoMood} react={react} onTap={onTap} />
      </div>
      {menu && (
        <div className={`absolute z-20 ${menu.compact ? "right-2 top-2" : "right-3 top-3"}`}>
          <StageMenu open={menu.open} onOpen={menu.onOpen} compact={menu.compact} />
        </div>
      )}
      {overlay}
      {life ? (
        showName && <LifeHud mate={mate} life={life} mood={mood} moodText={ml} onOpen={onLife} />
      ) : showName && (
        <div className="flex shrink-0 items-center gap-2 pb-2 pt-1 text-[12.5px]">
          <span className="font-semibold text-content">{mate.name}</span>
          {ml && (
            <span className="inline-flex items-center gap-1 text-content-faint" data-testid="mate-mood">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  mood === "talking" ? "bg-success" : mood === "thinking" ? "bg-accent animate-pulse-dot" : mood === "listening" ? "bg-cyan" : "bg-content-faint"
                }`}
              />
              {ml}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
