/**
 * Her face for the phone's call screen (docs/mate-calls.md "On Android"): the Android app rings with her calls when the
 * page is gone, so it keeps a small round-able picture of each mate — her icon, else her avatar's face (the same crop as
 * her thumbnail) — handed over by the page (GenyCallPlugin.link). Made once per picture.
 */
import type { Mate } from "../../api/mates";
import { faceCrop } from "../../lib/iconCrop";

const SIZE = 160;
const made = new Map<string, string>(); // what it was made of → the picture

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error("")); // (no picture: no face)
    img.src = src;
  });
}

/** her face as a PNG data URL (null: nothing to make it of — Live2D without an icon, no avatar) */
export async function faceOf(mate: Mate): Promise<string | null> {
  const { avatarPicture } = await import("../../components/mate/MateStage");
  const pic = mate.icon ? { src: mate.icon, icon: true as const } : avatarPicture(mate);
  if (!pic) return null;
  const key = JSON.stringify(pic);
  const had = made.get(key);
  if (had) return had;
  try {
    const img = await load(pic.src);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const g = canvas.getContext("2d");
    if (!g || !img.naturalWidth || !img.naturalHeight) return null;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if ("icon" in pic) {
      // (her icon is square already: covered)
      const s = Math.min(nw, nh);
      g.drawImage(img, (nw - s) / 2, (nh - s) / 2, s, s, 0, 0, SIZE, SIZE);
    } else {
      const [w, h] = pic.aspect?.[0] && pic.aspect[1] ? pic.aspect : [nw, nh];
      const c = pic.centre ? { x: (w - Math.min(w, h)) / 2, y: (h - Math.min(w, h)) / 2, size: Math.min(w, h) } : faceCrop(w, h, pic.face);
      const kx = nw / w;
      const ky = nh / h;
      g.drawImage(img, c.x * kx, c.y * ky, c.size * kx, c.size * ky, 0, 0, SIZE, SIZE);
    }
    const url = canvas.toDataURL("image/png");
    made.set(key, url);
    return url;
  } catch {
    return null;
  }
}

/** every mate's face, by id (the ones that can be made) */
export async function facesOf(mates: Mate[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    mates.map(async (m) => {
      const f = await faceOf(m);
      if (f) out[m.id] = f;
    }),
  );
  return out;
}
