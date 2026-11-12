/** A box the shape of her default set, fitted whole at the bottom centre, with one set placed in it (framing.ts). */
import type { CSSProperties, ReactNode } from "react";
import { frameBox, type FramedSet } from "./framing";
import "./mateAvatar.css";

export default function AlignedBox({ set, to, children }: { set: FramedSet; to: FramedSet; children: ReactNode }) {
  // (a set wider than her default box widens it: fitted to a narrow stage, it is never cut off at the sides)
  const { shape, place } = frameBox(set, to);
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
