/**
 * <MateAvatar> — the one avatar component (docs/mate.md §2). Picks the body for the avatar kind:
 *
 * - video  → VideoBody (stacked-alpha WebGL or plain <video>); without WebGL, with reduced motion or with no clips it
 *            falls back to the photo body on the rig's stills
 * - photo  → PhotoBody (stills: blink, level-driven mouths, emotion stills; a single photo breathes)
 * - live2d → Live2DBody (lazy chunk; pixi is not in the main bundle)
 * - none   → the portrait, else the name's initial
 *
 * The speaking level comes from the shared voice bridge (src/mate/voiceBridge.ts), not from props.
 */
import { lazy, memo, Suspense, useState, useSyncExternalStore } from "react";
import { useLiveAvatar } from "../livePreview";
import type { Avatar, MateAvatarProps } from "../types";
import { StackedPlayer } from "./player";
import { reducedMotion } from "./shared";
import VideoBody from "./VideoBody";
import { viewTransform, type AvatarViewT } from "./view";
import PhotoBody from "./PhotoBody";
import "./mateAvatar.css";

const Live2DBody = lazy(() => import("./Live2DBody"));

export { setLive2DCoreUrl, getLive2DCoreUrl } from "./live2dCore";

/** can this browser play the motion clips (WebGL, motion allowed)? Asked once. */
let videoOk: boolean | null = null;
const canVideo = () => (videoOk ??= !reducedMotion() && StackedPlayer.supported());
const canPlainVideo = () => !reducedMotion();
const noSubscribe = () => () => {};

export interface MateAvatarExtraProps {
  /** Live2D: Cubism Core script URL (default `/api/mates/live2d/core.js`, or setLive2DCoreUrl) */
  live2dCoreUrl?: string;
  /** Live2D: a tap on the model (hit area Id/Name, or null) */
  onTap?: (area: string | null) => void;
  /** Live2D: pointer focus + tap motions (default true) */
  interactive?: boolean;
  /** the user's pan / zoom inside the box (mate/avatar/view.ts; the desktop overlay) */
  view?: AvatarViewT;
}

export const MateAvatar = memo(function MateAvatar({
  avatar,
  name,
  portrait = null,
  size = "lg",
  mood = "idle",
  react = null,
  className,
  live2dCoreUrl,
  onTap,
  interactive,
  view,
}: MateAvatarProps & MateAvatarExtraProps) {
  const webgl = useSyncExternalStore(noSubscribe, canVideo, () => false);
  const plainOk = useSyncExternalStore(noSubscribe, canPlainVideo, () => false);
  /** the video player could not start: show the stills instead */
  const [videoFailed, setVideoFailed] = useState(false);
  const cls = `mate-avatar mate-avatar-${size}${className ? " " + className : ""}`;

  if (avatar.kind === "live2d") {
    return (
      <div className={cls} style={{ aspectRatio: "3 / 4" }} data-mate-kind="live2d">
        <Suspense fallback={null}>
          <Live2DBody
            key={`l|${avatar.live2d.model}`}
            live2d={avatar.live2d}
            mood={mood}
            react={react}
            name={name}
            size={size}
            coreUrl={live2dCoreUrl}
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
    const video =
      avatar.kind === "video" &&
      rig.clips.some((c) => !c.disabled) &&
      !videoFailed &&
      (packing === "plain" ? plainOk : webgl);
    return (
      <div className={cls} style={style} data-mate-kind={avatar.kind}>
        {/* (always this layer: adding it later would restart the body's player) */}
        <div className="mate-layer" style={{ transform: view && viewTransform(view), transformOrigin: "0 0" }} data-mate-view="">
        {video ? (
          <VideoBody
            // one player per rig and size: another avatar never reuses this one's player, canvas, videos or clips
            key={`v|${size}|${packing}|${rig.clips.map((c) => c.src).join(",")}`}
            rig={rig}
            size={size}
            mood={mood}
            react={react}
            poster={home}
            name={name}
            onFail={() => setVideoFailed(true)}
          />
        ) : home ? (
          <PhotoBody key={`p|${home}`} stills={rig.stills} emotionStills={rig.emotion_stills} home={home} mood={mood} react={react} name={name} />
        ) : (
          <Initial name={name} />
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
  ...rest
}: Omit<MateAvatarProps, "avatar" | "name"> & MateAvatarExtraProps & { mate: { id: string; name: string; avatar: Avatar } }) {
  const avatar = useLiveAvatar(mate) ?? mate.avatar;
  return <MateAvatar avatar={avatar} name={mate.name} {...rest} />;
}

export default MateAvatar;
