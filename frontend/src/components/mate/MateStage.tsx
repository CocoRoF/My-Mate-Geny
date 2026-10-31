import { useEffect, useState } from "react";
import type { Mate } from "../../api/mates";
import { MateAvatar } from "../../mate/avatar/MateAvatar";
import type { BodyMood, MateReact } from "../../mate/types";
import type { Caption } from "../../mate/useMateConversation";

export const MOOD_LABEL: Record<BodyMood, string> = {
  idle: "",
  listening: "listening…",
  thinking: "thinking…",
  talking: "talking",
  away: "away",
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
  if (!mate.builtin) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-testid="mate-builtin-badge">
      <span className="pill bg-violet/12 text-violet" title="Ships with My Mate Geny">
        Built-in
      </span>
      {mate.customized && (
        <span className="pill bg-surface-3 text-content-faint" title="You edited it — app updates leave it as it is">
          Edited
        </span>
      )}
    </span>
  );
}

/** a small round picture of a mate: its home still when it has one, else its initial */
export function MateThumb({ mate, className = "h-7 w-7" }: { mate: Mate; className?: string }) {
  const a = mate.avatar;
  const src = a.kind === "video" || a.kind === "photo" ? a.rig.home || a.rig.stills?.neutral || "" : "";
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
  react,
  caption,
  size = "lg",
  onTap,
  showName = true,
  className = "",
}: {
  mate: Mate;
  mood: BodyMood;
  react: MateReact;
  caption?: Caption | null;
  size?: "lg" | "sm";
  onTap?: (area: string | null) => void;
  showName?: boolean;
  className?: string;
}) {
  const line = useFadingCaption(caption ?? null);
  return (
    <div className={`relative flex min-h-0 flex-col items-center ${className}`} data-testid="mate-stage" data-mood={mood}>
      {line && (
        <div className="absolute inset-x-3 top-2 z-10 flex justify-center pointer-events-none">
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
        <MateAvatar key={mate.id} avatar={mate.avatar} name={mate.name} size={size} mood={mood} react={react} onTap={onTap} />
      </div>
      {showName && (
        <div className="flex shrink-0 items-center gap-2 pb-2 pt-1 text-[12.5px]">
          <span className="font-semibold text-content">{mate.name}</span>
          {MOOD_LABEL[mood] && (
            <span className="inline-flex items-center gap-1 text-content-faint" data-testid="mate-mood">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  mood === "talking" ? "bg-success" : mood === "thinking" ? "bg-accent animate-pulse-dot" : mood === "listening" ? "bg-cyan" : "bg-content-faint"
                }`}
              />
              {MOOD_LABEL[mood]}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
