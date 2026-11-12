/**
 * The Mate view's layout (components/mate/MateView.tsx), what it decides without React: her stage beside the
 * conversation (split) or on top of it (stacked). The user picks 자동 / 위아래 / 좌우 in the view's header, kept on this
 * device; a phone is always stacked. Automatic goes by the view's own box, its width and its shape: side by side only
 * when both halves fit and the view is not standing up — a narrow, tall window keeps her on top whether the sidebar is
 * folded or not — with a little room either way, so a resize along the line doesn't flip it back and forth.
 */

export type LayoutPref = "auto" | "stacked" | "split";

export const LAYOUT_KEY = "hrh_mate_layout";

/** the stage's and the conversation's least widths, side by side */
export const SPLIT_MIN = 660;
/** automatic: side by side from this width : height on, and from this much past SPLIT_MIN */
const WIDE_IN = 1;
const WIDE_IN_PX = 24;
/** … and back on top only below this width : height */
const WIDE_OUT = 0.9;

export const readLayout = (raw: string | null | undefined): LayoutPref => (raw === "stacked" || raw === "split" ? raw : "auto");

/** can the two halves stand side by side in a view `w` px wide */
export const splitFits = (w: number): boolean => w >= SPLIT_MIN;

/**
 * Side by side now? `w` × `h`: the view's box (0 × 0 before it is measured: on top); `was`: what it is now (the room
 * either way). 좌우 holds while the halves fit; 위아래 always stacks.
 */
export function splitNow(pref: LayoutPref, w: number, h: number, was: boolean): boolean {
  if (pref === "stacked" || !splitFits(w)) return false;
  if (pref === "split") return true;
  const wide = h > 0 ? w / h : Infinity;
  return was ? wide >= WIDE_OUT : w >= SPLIT_MIN + WIDE_IN_PX && wide >= WIDE_IN;
}
