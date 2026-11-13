/**
 * <MateAvatar> — the one avatar component (docs/mate.md §2). Picks the body for the avatar kind:
 *
 * - video  → VideoBody (stacked-alpha WebGL or plain <video>); without WebGL, with reduced motion or with no clips it
 *            falls back to the photo body on the rig's stills
 * - photo  → PhotoBody (stills: blink, level-driven mouths, emotion stills; a single photo breathes)
 * - live2d → Live2DBody (lazy chunk; pixi is not in the main bundle)
 * - livliv → LivLivBody (lazy chunk: LivLiv Player, a 2.5D character in layers; WebGL2)
 * - none   → the portrait, else the name's initial
 *
 * Photo/Live2D mouths follow the voice bridge. Video receives conversation activity separately from audio.
 */
import { lazy, memo, Suspense, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLiveAvatar } from "../livePreview";
import type { Avatar, BodyMood, MateAvatarProps } from "../types";
import { DEFAULT_OUTFIT, type MateState, type OutfitCard } from "../../api/mates";
import { restingLook } from "../stateLook";
import AlignedBox from "./AlignedBox";
import { figureOf, type FramedSet } from "./framing";
import { useOutfitFade } from "./outfitFade";
import { StackedPlayer } from "./player";
import { reducedMotion } from "./shared";
import VideoBody from "./VideoBody";
import { viewTransform, type AvatarViewT, type Bleed, type FigureShape } from "./view";
import PhotoBody from "./PhotoBody";
import "./mateAvatar.css";

const Live2DBody = lazy(() => import("./Live2DBody"));
const LivLivBody = lazy(() => import("./LivLivBody"));

export { setLive2DCoreUrl, getLive2DCoreUrl } from "./live2dCore";

/** can this browser play the motion clips (WebGL, motion allowed)? Asked once. */
let videoOk: boolean | null = null;
const canVideo = () => (videoOk ??= !reducedMotion() && StackedPlayer.supported());
const canPlainVideo = () => !reducedMotion();
const noSubscribe = () => () => {};

export interface MateAvatarExtraProps {
  /** drawn this far past its box (the console's stage: to the stage's edges, not its padding — view.ts Bleed) */
  bleed?: Bleed;
  /** Live2D: Cubism Core script URL (default `/api/mates/live2d/core.js`, or setLive2DCoreUrl) */
  live2dCoreUrl?: string;
  /** Live2D: a tap on the model (hit area Id/Name, or null) */
  onTap?: (area: string | null) => void;
  /** Live2D: pointer focus + tap motions (default true) */
  interactive?: boolean;
  /** the user's pan / zoom inside the box (mate/avatar/view.ts; the desktop overlay) */
  view?: AvatarViewT;
  /** video: what she is up to in her own day (app/mate/life) */
  doing?: string;
  /** her default set: this one stands where that one stands (framing.ts) */
  frameTo?: FramedSet;
  /** what the body fits in the box, for a pan / zoom kept against her figure (view.ts useAvatarView's setFigure).
   *  Live2D says once its model is in; null: not known (the initial) */
  onFigure?: (figure: FigureShape | null) => void;
}

export const MateAvatar = memo(function MateAvatar({
  avatar,
  name,
  portrait = null,
  size = "lg",
  mood = "idle",
  videoMood,
  react = null,
  look,
  frameTo,
  className,
  live2dCoreUrl,
  onTap,
  interactive,
  view,
  doing,
  onFigure,
  bleed,
}: MateAvatarProps & MateAvatarExtraProps) {
  const webgl = useSyncExternalStore(noSubscribe, canVideo, () => false);
  const plainOk = useSyncExternalStore(noSubscribe, canPlainVideo, () => false);
  /** the video player could not start: show the stills instead */
  const [videoFailed, setVideoFailed] = useState(false);
  const cls = `mate-avatar mate-avatar-${size}${bleed ? " mate-avatar-bleed" : ""}${className ? " " + className : ""}`;
  const figure = figureOf(avatar, frameTo);
  const figureKey = figure ? `${figure.aspect}|${figure.anchorY ?? 1}` : String(figure);
  // (before the first paint, as the stage measures its box: a kept view is never drawn against the wrong figure)
  useLayoutEffect(() => {
    if (figure !== undefined) onFigure?.(figure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [figureKey, onFigure]);

  if (avatar.kind === "live2d") {
    return (
      <div className={cls} style={{ aspectRatio: "3 / 4" }} data-mate-kind="live2d">
        <Suspense fallback={null}>
          <Live2DBody
            key={`l|${avatar.live2d.model}`}
            live2d={avatar.live2d}
            mood={mood}
            look={look}
            react={react}
            name={name}
            size={size}
            coreUrl={live2dCoreUrl}
            onTap={onTap}
            interactive={interactive}
            view={view}
            onFigure={onFigure}
            bleed={bleed}
          />
        </Suspense>
      </div>
    );
  }

  if (avatar.kind === "livliv") {
    const c = avatar.livliv.canvas;
    return (
      <div className={cls} style={{ aspectRatio: c && c[0] > 0 && c[1] > 0 ? `${c[0]} / ${c[1]}` : "2 / 3" }} data-mate-kind="livliv">
        <Suspense fallback={null}>
          <LivLivBody
            key={`lv|${avatar.livliv.model}`}
            livliv={avatar.livliv}
            mood={mood}
            look={look}
            react={react}
            name={name}
            size={size}
            onTap={onTap}
            interactive={interactive}
            view={view}
          />
        </Suspense>
      </div>
    );
  }

  if (avatar.kind === "video" || avatar.kind === "photo") {
    const rig = avatar.rig;
    const home = rig.home || rig.stills.neutral || portrait || null;
    const aspect = rig.aspect?.length === 2 && rig.aspect[0] > 0 && rig.aspect[1] > 0 ? rig.aspect : [3, 4];
    const style = { aspectRatio: `${aspect[0]} / ${aspect[1]}` };
    const packing = rig.packing ?? "stacked-alpha";
    const aligned = (body: ReactNode) => (frameTo ? <AlignedBox set={{ aspect, frame: rig.frame }} to={frameTo}>{body}</AlignedBox> : body);
    const video =
      avatar.kind === "video" &&
      rig.clips.some((c) => !c.disabled) &&
      !videoFailed &&
      (packing === "plain" ? plainOk : webgl);
    return (
      <div className={cls} style={style} data-mate-kind={avatar.kind}>
        {/* (always this layer: adding it later would restart the body's player) */}
        <div className="mate-layer" style={{ transform: view && viewTransform(view), transformOrigin: "0 0" }} data-mate-view="">
        {aligned(
          video ? (
          <VideoBody
            // one player per rig and size: another avatar never reuses this one's player, canvas, videos or clips
            key={`v|${size}|${packing}|${rig.clips.map((c) => c.src).join(",")}`}
            rig={rig}
            size={size}
            mood={videoMood ?? mood}
            doing={doing}
            react={react}
            look={look}
            poster={home}
            name={name}
            onFail={() => setVideoFailed(true)}
          />
        ) : home ? (
          <PhotoBody key={`p|${home}`} stills={rig.stills} emotionStills={rig.emotion_stills} home={home} mood={mood} react={react} look={look} name={name} />
        ) : (
          <Initial name={name} />
          ),
        )}
        </div>
      </div>
    );
  }

  return (
    <div className={cls} data-mate-kind="none">
      {portrait ? (
        <PhotoBody stills={{}} home={portrait} mood={mood} react={react} name={name} />
      ) : (
        <Initial name={name} />
      )}
    </div>
  );
});

function Initial({ name }: { name: string }) {
  const ch = [...(name.trim() || "?")][0].toUpperCase();
  return (
    <div className="mate-initial" role="img" aria-label={name}>
      <span>{ch}</span>
    </div>
  );
}

/**
 * A mate's avatar as it is now: the saved one, or the Settings → Avatar draft being edited in any window of this
 * browser (clips switched on/off show at once — mate/livePreview). Saved changes reach every window by the server's
 * `mates.changed` push (stores/mateStore).
 */
export function LiveMateAvatar({
  mate,
  className,
  ...rest
}: Omit<MateAvatarProps, "avatar" | "name"> &
  MateAvatarExtraProps & {
    videoMood: BodyMood;
    mate: { id: string; name: string; avatar: Avatar; state?: MateState; relation?: { avatar_mood?: boolean }; outfits?: { worn: string; items: OutfitCard[] }; life?: { enabled: boolean; body?: string; asleep?: boolean } };
  }) {
  const avatar = useLiveAvatar(mate) ?? mate.avatar;
  const { shown, phase } = useOutfitFade(mate.outfits?.worn ?? DEFAULT_OUTFIT, avatar);
  const fading = phase === "idle" ? "" : `mate-outfit-${phase}`;
  const base = mate.outfits?.items.find((c) => c.id === DEFAULT_OUTFIT);
  const wide = base?.aspect?.[0];
  const high = base?.aspect?.[1];
  const measured = JSON.stringify(base?.frame ?? null);
  const hasBody = base?.kind === "video" || base?.kind === "photo";
  const frameTo = useMemo<FramedSet | undefined>(
    () => (hasBody && wide && high ? { aspect: [wide, high], frame: JSON.parse(measured) } : undefined),
    [hasBody, wide, high, measured],
  );
  // (awake in bed because of a message: she is herself. The body names only what she is doing right now)
  const life = mate.life;
  const doing = life?.enabled ? (life.body === "sleep" && !life.asleep ? undefined : life.body || undefined) : undefined;
  return <MateAvatar avatar={shown} name={mate.name} look={restingLook(mate)} frameTo={frameTo} doing={doing} className={[className, fading].filter(Boolean).join(" ") || undefined} {...rest} />;
}

export default MateAvatar;
