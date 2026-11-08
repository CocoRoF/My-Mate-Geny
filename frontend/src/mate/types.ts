/**
 * Mate avatar types — the contract in docs/mate.md §2 (keep in sync with it).
 *
 * All asset URLs are server-relative (`/api/mates/{id}/assets/<path>`); the renderers load whatever URL they get.
 */

export type Avatar =
  | { kind: "none" }
  | { kind: "video"; rig: Rig } // clip state machine (ailism-mate body)
  | { kind: "photo"; rig: Rig } // stills only (clips: [])
  | { kind: "live2d"; live2d: Live2D } // Cubism 4/5 model (Geny)
  | { kind: "livliv"; livliv: LivLiv }; // a 2.5D character in layers, played by LivLiv Player (avatar/LivLivBody.tsx)

export type AvatarKind = Avatar["kind"];

export type ClipKind = "idle" | "talk" | "listen" | "think" | "react" | "away" | "life";

export interface RigClip {
  id: string;
  kind: ClipKind;
  /** the emotion a `react` clip plays (matched with the aliases in emotion.ts) */
  emotion?: string;
  /** what she is doing in a `life` clip (a mate's own day: eat, game, read …) */
  doing?: string;
  /** the big clip (size "lg") */
  src: string;
  /** the small clip (size "sm"; falls back to `src`) */
  small?: string;
  /** a small still of it, made with the set (the clip library shows it instead of decoding the clip) */
  thumb?: string;
  loop?: boolean;
  /** switched off in the clip editor: the renderer never plays (or preloads) it */
  disabled?: boolean;
}

/** where her face sits in a set's pictures, in fractions of the picture: every set of a mate is lined up by it (avatar/framing.ts) */
export interface RigFrame {
  /** centre x, centre y, height */
  face: number[];
  /** the same, estimated from the outline, for comparing with a set that has only that */
  outline?: number[];
  /** where her figure starts from the top */
  top?: number;
  /** "outline": estimated from the outline, no face was found */
  how?: "face" | "outline";
}

export interface Rig {
  /** w, h of one frame */
  aspect: [number, number];
  frame?: RigFrame | null;
  /** video only; stacked-alpha = colour top / alpha bottom (H.264). Default "stacked-alpha". */
  packing?: "stacked-alpha" | "plain";
  /** still of the shared home frame (poster / fallback) */
  home: string;
  /**
   * neutral, smile, laugh, shy, surprised, sad, worried, thinking, sleepy,
   * + mechanics: blink, mouth_half, mouth_open, mouth_o
   */
  stills: Record<string, string>;
  clips: RigClip[];
  /**
   * emotion -> clip ids (react). Several ids: one of them, at random. An empty list: no clip for that emotion (the
   * aliases are not tried). A missing key: the clips whose `emotion` / id names it (with the aliases in emotion.ts).
   */
  emotions?: Record<string, string[]>;
  /**
   * emotion (or the moods "thinking" / "away") -> the name of a still in `stills`; "" = no still for it. A missing key:
   * the still named like the emotion (or one of its aliases). Mechanic stills (blink, mouth_*) are never used here.
   */
  emotion_stills?: Record<string, string>;
}

export interface Live2D {
  /** URL of *.model3.json */
  model: string;
  /** kScale (multiplies the fit-to-box scale; default 0.85) */
  scale?: number;
  /** initial shift in CSS px */
  x?: number;
  y?: number;
  /** idle motion group (default "Idle") */
  idle_group?: string;
  /** emotion -> expression name or index */
  emotions?: Record<string, string | number>;
  /** emotion -> motion group */
  emotion_motions?: Record<string, string>;
  /** hit area (Id or Name) -> motion */
  tap_motions?: Record<string, { group: string; index?: number }>;
  hidden_parts?: string[];
}

/** A LivLiv package (a ``.livliv`` imported into the mate's assets; backend files.build_livliv_avatar). */
export interface LivLiv {
  /** URL of its ``model.json`` (or of the ``.livliv`` itself) */
  model: string;
  /** what the package says about itself */
  name?: string;
  canvas?: [number, number];
  /** its expression ids: standard ones (smile, shy, angry, sad, surprised, laugh, smirk…) mean the same on every model */
  expressions?: string[];
  cover?: string;
  avatar?: string;
  author?: string;
  license?: { id?: string; url?: string };
  /** the mark the package asks the player to draw ("livliv", "text", "none"): part of its licence, never hidden */
  watermark?: string;
  /** the user's choice per emotion of hers: an expression id, or "" for none (unset: the standard id of that name) */
  emotions?: Record<string, string>;
  /** her eyes follow the pointer over her (default) or not */
  follow?: "canvas" | "off";
}

/** What the mate is doing now. A one-shot emotion (`react`) plays over it. */
export type BodyMood = "idle" | "listening" | "thinking" | "talking" | "away";

/** A one-shot emotion: a new `at` (e.g. Date.now()) replays the same name. */
export type MateReact = { name: string; at: number } | null;

export type AvatarSize = "lg" | "sm";

export interface MateAvatarProps {
  avatar: Avatar;
  name: string;
  /** picture used when the avatar has nothing better to show (kind "none", or a rig without stills) */
  portrait?: string | null;
  size?: AvatarSize;
  mood?: BodyMood;
  /** separate activity-only mood for video bodies; no audio playback state */
  videoMood?: BodyMood;
  react?: MateReact;
  /** how she feels, as a face to rest on (mate/stateLook.ts) */
  look?: string;
  className?: string;
}
