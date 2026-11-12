/**
 * Every set of one mate stands in the same place at the same size (docs/mate.md "Outfits"). Sets are cut separately, so each
 * picture has its own shape and margins and her face sits somewhere else in it: fitted as they are, she would jump and shrink
 * with each change of clothes. So the box is always her default set's shape, and any other set is placed in it so that its
 * face lands on her default face (`rig.frame`, measured when the set is made).
 */
import type { Avatar, RigFrame } from "../types";
import type { FigureShape } from "./view";

export interface FramedSet {
  aspect: number[];
  frame?: RigFrame | null;
}

/** where a set goes, in fractions of the box */
export interface Placement {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** a set scaled further than this has a wrong measurement behind it, not a very different picture */
const MOST_SCALE = 1.6;

const shape = (aspect: number[]): number => (aspect?.[0] > 0 && aspect?.[1] > 0 ? aspect[0] / aspect[1] : 3 / 4);

const usable = (v?: number[] | null): v is number[] => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n)) && v[2] > 0;

/** two measurements can be compared only when they were made the same way: the faces found, else their outlines */
function matching(a?: RigFrame | null, b?: RigFrame | null): [number[], number[]] | null {
  if (!a || !b) return null;
  const outlineOf = (f: RigFrame) => (f.how === "outline" ? f.face : f.outline);
  if (a.how !== "outline" && b.how !== "outline" && usable(a.face) && usable(b.face)) return [a.face, b.face];
  const x = outlineOf(a);
  const y = outlineOf(b);
  return usable(x) && usable(y) ? [x, y] : null;
}

/**
 * The box fitted to the stage: her default set's, widened evenly on both sides when the set placed in it reaches past
 * them (a wider picture). Fitted whole, a narrow stage then makes her a little smaller instead of cutting her off at
 * its sides; her default set stays centred. → how much wider than her default box (≥ 1), and the set in the widened box.
 * (Above and below stay as placeSet decided: her head is on the page, her feet on its bottom edge.)
 */
export function widenFor(place: Placement): { span: number; place: Placement } {
  const reach = Math.max(0.5, 0.5 - place.left, place.left + place.width - 0.5);
  const span = 2 * reach;
  if (span <= 1 + 1e-6) return { span: 1, place };
  return { span, place: { ...place, left: (place.left - (0.5 - reach)) / span, width: place.width / span } };
}

/** the box `set` stands in, her default set being `to` (AlignedBox): its shape (width : height — her default set's,
 *  widened for this one) and where the set goes in it */
export function frameBox(set: FramedSet, to: FramedSet): { shape: number; place: Placement } {
  const { span, place } = widenFor(placeSet(set, to));
  return { shape: shape(to.aspect) * span, place };
}

/**
 * What a body of `avatar` fits in its box (MateAvatar → the stage's pan / zoom, view.ts): a picture or her framed box
 * contained at the bottom centre, a LivLiv drawing in the middle. undefined: Live2D (its body says, once its model is
 * in); null: nothing to say (the initial).
 */
export function figureOf(avatar: Avatar, frameTo?: FramedSet): FigureShape | null | undefined {
  if (avatar.kind === "video" || avatar.kind === "photo") {
    const a = avatar.rig.aspect;
    const aspect = a?.length === 2 && a[0] > 0 && a[1] > 0 ? a : [3, 4];
    return { aspect: frameTo ? frameBox({ aspect, frame: avatar.rig.frame }, frameTo).shape : aspect[0] / aspect[1] };
  }
  if (avatar.kind === "livliv") {
    const c = avatar.livliv.canvas;
    return { aspect: c && c[0] > 0 && c[1] > 0 ? c[0] / c[1] : 2 / 3, anchorY: 0.5 };
  }
  return avatar.kind === "live2d" ? undefined : null;
}

/** `set`, placed in a box the shape of `to` */
export function placeSet(set: FramedSet, to: FramedSet): Placement {
  const own = shape(set.aspect);
  const box = shape(to.aspect);
  const pair = matching(set.frame, to.frame);
  const scale = pair ? pair[1][2] / pair[0][2] : null;
  if (!pair || scale === null || scale > MOST_SCALE || scale < 1 / MOST_SCALE) {
    // nothing to line up: at least the same height, standing on the same spot
    const width = own / box;
    return { left: (1 - width) / 2, top: 0, width, height: 1 };
  }
  const height = scale;
  const width = (height * own) / box;
  const [a, b] = pair;
  let top = b[1] - a[1] * height;
  // her head stays on the page, and she stands on its bottom edge rather than floating above it
  top -= Math.min(0, top + (set.frame?.top ?? 0) * height);
  if (top + height < 1) top = 1 - height;
  return { left: b[0] - a[0] * width, top, width, height };
}
