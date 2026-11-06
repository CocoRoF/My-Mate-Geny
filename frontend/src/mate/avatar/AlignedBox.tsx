/** A box the shape of her default set, fitted at the bottom centre, with one set placed in it (framing.ts). */
import type { CSSProperties, ReactNode } from "react";
import { placeSet, type FramedSet } from "./framing";
import "./mateAvatar.css";

export default function AlignedBox({ set, to, children }: { set: FramedSet; to: FramedSet; children: ReactNode }) {
  const place = placeSet(set, to);
  const shape = to.aspect[0] / to.aspect[1];
  return (
    <div className="mate-frame-box">
      <div className="mate-frame" style={{ "--mate-frame": shape } as CSSProperties} data-mate-frame="">
        <div
          className="mate-set"
          style={{ left: `${place.left * 100}%`, top: `${place.top * 100}%`, width: `${place.width * 100}%`, height: `${place.height * 100}%` }}
          data-mate-set=""
        >
          {children}
        </div>
      </div>
    </div>
  );
}
