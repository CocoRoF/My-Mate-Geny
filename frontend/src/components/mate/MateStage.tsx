import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Mate } from "../../api/mates";
import { LiveMateAvatar } from "../../mate/avatar/MateAvatar";
import { isHome, useAvatarView, type Bleed } from "../../mate/avatar/view";
import Icon from "../ui/Icon";
import type { BodyMood, MateReact } from "../../mate/types";
import type { Caption } from "../../mate/useMateConversation";
import { useT, type MsgKey, type TFunction } from "../../i18n";
import { cropBoxStyle, faceCrop } from "../../lib/iconCrop";
import type { IconPicture } from "../ui/IconCropDialog";
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

/** her avatar's picture to make an icon of (the set she has on): a still's face (its rig says where), a LivLiv
 *  package's own portrait or cover; null: none (no avatar, Live2D) */
export function avatarPicture(mate: Mate): (IconPicture & { aspect?: number[] }) | null {
  const a = mate.avatar;
  if (a.kind === "video" || a.kind === "photo") {
    const src = a.rig.home || a.rig.stills?.neutral || "";
    return src ? { src, face: a.rig.frame?.face ?? null, aspect: a.rig.aspect } : null;
  }
  if (a.kind === "livliv") {
    if (a.livliv.avatar) return { src: a.livliv.avatar, centre: true };
    return a.livliv.cover ? { src: a.livliv.cover } : null;
  }
  return null;
}

/** a small round picture of a mate: her icon (her Profile tab), else her avatar's face, else her initial */
export function MateThumb({ mate, className = "h-7 w-7" }: { mate: Mate; className?: string }) {
  const [failed, setFailed] = useState("");
  const icon = mate.icon && failed !== mate.icon ? mate.icon : "";
  const pic = icon ? null : avatarPicture(mate);
  const [w, h] = pic?.aspect?.[0] && pic.aspect[1] ? pic.aspect : [0, 0];
  const ch = [...(mate.name.trim() || "?")][0].toUpperCase();
  return (
    <span className={`relative shrink-0 overflow-hidden rounded-full bg-gradient-to-br from-accent to-violet ${className}`} data-testid="mate-thumb">
      {icon ? (
        <img src={icon} alt="" className="h-full w-full object-cover" draggable={false} onError={() => setFailed(icon)} />
      ) : pic && w ? (
        // (her face, by the rig's frame: the same crop the icon dialog starts on)
        <img src={pic.src} alt="" className="absolute max-w-none" style={cropBoxStyle(faceCrop(w, h, pic.face), w, h)} draggable={false} />
      ) : pic ? (
        <img src={pic.src} alt="" className={`h-full w-full object-cover ${pic.centre ? "" : "object-top"}`} draggable={false} />
      ) : (
        <span className="grid h-full w-full place-items-center text-[12px] font-semibold text-white">{ch}</span>
      )}
    </span>
  );
}

/**
 * How far the stage reaches past the box she is fitted in (its padding, the name under her): she is drawn that far, so
 * the only edge that cuts her is the stage's own — the edge of the place behind her — never a line inside it.
 */
function useStageBleed(stage: React.RefObject<HTMLElement | null>, area: React.RefObject<HTMLElement | null>): Bleed | undefined {
  const [bleed, setBleed] = useState<Bleed | undefined>(undefined);
  useLayoutEffect(() => {
    const s = stage.current;
    const a = area.current;
    if (!s || !a) return;
    const take = () => {
      const sr = s.getBoundingClientRect();
      const ar = a.getBoundingClientRect();
      if (!sr.width || !ar.width) return;
      // (the stage's padding box: it clips at the inside of its border)
      const left = sr.left + s.clientLeft;
      const top = sr.top + s.clientTop;
      const px = (n: number) => Math.max(0, Math.round(n));
      const next = { l: px(ar.left - left), r: px(left + s.clientWidth - ar.right), t: px(ar.top - top), b: px(top + s.clientHeight - ar.bottom) };
      setBleed((was) => (was && was.l === next.l && was.r === next.r && was.t === next.t && was.b === next.b ? was : next));
    };
    take();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(take);
    ro.observe(s);
    ro.observe(a);
    return () => ro.disconnect();
  }, [stage, area]);
  return bleed;
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
  layout,
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
  /** the view's layout (side by side, stacked): another one is another shape of stage, and she is fitted whole again */
  layout?: string;
}) {
  const t = useT();
  const life = mate.life?.enabled && mate.life.art ? mate.life : null;
  const line = useFadingCaption(caption ?? null);
  const ml = moodLabel(t, mood);
  // her pan / zoom on the stage: the wheel at the pointer, a mouse drag, a double click back to her whole figure — per
  // mate, apart from the desktop overlay's (mate/avatar/view.ts). A finger is left alone: a phone scrolls and pokes her
  // as before; a tap is still a poke. Kept against her fitted figure; she goes wherever she is put (only never all the
  // way out of sight); a stage of quite another shape than the one it was made on (a window turned tall, a reload in
  // another size) shows her whole again.
  const area = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const bleed = useStageBleed(stage, area);
  const { view, reset, dragging, setFigure } = useAvatarView(area, `hrh.mate.stageView.${mate.id}`, true, { touch: false, doubleClickReset: true, refit: true });
  // (a pan / zoom made for the other layout is let go: she is fitted whole in this one)
  // (undefined: not measured yet — the first layout it gets is where it starts, the user's view kept)
  const shapedFor = useRef(layout);
  useEffect(() => {
    if (layout === undefined || shapedFor.current === layout) return;
    const first = shapedFor.current === undefined;
    shapedFor.current = layout;
    if (!first) reset();
  }, [layout, reset]);
  return (
    // (she is fitted in the stage's padded box but drawn to its own edges — the place behind her — and cut only there)
    <div ref={stage} className={`relative flex min-h-0 flex-col items-center overflow-hidden ${className}`} data-testid="mate-stage" data-mood={mood}>
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
      <div
        ref={area}
        className="group/stage relative min-h-0 w-full flex-1"
        style={{ cursor: dragging ? "grabbing" : "grab" }}
        data-testid="mate-stage-area"
        data-view={`${view.x.toFixed(4)},${view.y.toFixed(4)},${view.z.toFixed(4)}`}
      >
        {/* keyed by the mate: switching mates never shows (or keeps playing) the previous mate's body */}
        <LiveMateAvatar key={mate.id} mate={mate} size={size} mood={mood} videoMood={videoMood} react={react} onTap={onTap} view={view} onFigure={setFigure} bleed={bleed} />
        {!isHome(view) && (
          <button
            className="absolute bottom-2 right-2 z-10 grid h-7 w-7 place-items-center rounded-full border border-border bg-surface-2/90 text-content-dim opacity-0 shadow-float transition hover:text-content focus-visible:opacity-100 group-hover/stage:opacity-100 touch:opacity-100"
            onClick={reset}
            title={t("mate.resetViewTitle")}
            aria-label={t("mate.resetViewTitle")}
            data-testid="mate-stage-view-reset"
          >
            <Icon name="refresh" size={13} />
          </button>
        )}
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
