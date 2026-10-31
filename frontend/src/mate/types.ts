/**
 * Mate avatar types — the contract in docs/mate.md §2 (keep in sync with it).
 *
 * All asset URLs are server-relative (`/api/mates/{id}/assets/<path>`); the renderers load whatever URL they get.
 */

export type Avatar =
  | { kind: "none" }
  | { kind: "video"; rig: Rig } // clip state machine (ailism-mate body)
  | { kind: "photo"; rig: Rig } // stills only (clips: [])
  | { kind: "live2d"; live2d: Live2D }; // Cubism 4/5 model (Geny)

export type AvatarKind = Avatar["kind"];

export type ClipKind = "idle" | "talk" | "listen" | "think" | "react" | "away";

export interface RigClip {
  id: string;
  kind: ClipKind;
  /** the emotion a `react` clip plays (matched with the aliases in emotion.ts) */
  emotion?: string;
  /** the big clip (size "lg") */
  src: string;
  /** the small clip (size "sm"; falls back to `src`) */
  small?: string;
  loop?: boolean;
}

export interface Rig {
  /** w, h of one frame */
  aspect: [number, number];
  /** video only; stacked-alpha = colour top / alpha bottom (H.264). Default "stacked-alpha". */
  packing?: "stacked-alpha" | "plain";
  /** still of the shared home frame (poster / fallback) */
  home: string;
  /**
   * neutral, smile, laugh, shy, surprised, sad, thinking, sleepy,
   * + mechanics: blink, mouth_half, mouth_open, mouth_o
   */
  stills: Record<string, string>;
  clips: RigClip[];
  /** emotion -> clip ids (react) */
  emotions?: Record<string, string[]>;
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
  react?: MateReact;
  className?: string;
}
