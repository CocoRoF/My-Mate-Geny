/** Where she is, behind her: the picture of the place in the light of the hour, dissolving when it changes, in today's weather and
 * the season's light. All of it painted once: nothing here moves while she is on it. */
import { useEffect, useRef, useState } from "react";
import type { MateLifeSummary } from "../../../api/mates";
import "./life.css";

export default function LifeBackdrop({ life }: { life: MateLifeSummary }) {
  const art = life.art ?? "";
  const [shown, setShown] = useState({ now: art, before: "" });
  const latest = useRef(art);
  useEffect(() => {
    latest.current = art;
    if (art === shown.now) return;
    // (it comes in once it is there: never a blank moment on a slow connection)
    const next = new Image();
    const go = () => {
      if (latest.current === art) setShown((s) => ({ now: art, before: s.now }));
    };
    next.onload = go;
    next.onerror = go;
    next.src = art;
    return () => {
      next.onload = null;
      next.onerror = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [art]);
  // (out in it she has the whole sky; indoors only its light comes in through the windows)
  const sky = life.weather && life.weather !== "clear" ? life.weather : undefined;
  const where = life.outdoor ? "out" : "in";
  return (
    <div className="life-backdrop" data-testid="mate-life-backdrop" data-art={shown.now} data-weather={life.weather ?? ""} data-season={life.season ?? ""} aria-hidden="true">
      {shown.before && <img src={shown.before} alt="" className="life-backdrop-pic" draggable={false} />}
      <img
        key={shown.now}
        src={shown.now}
        alt=""
        className={`life-backdrop-pic ${shown.before ? "incoming" : ""}`}
        draggable={false}
        onAnimationEnd={() => setShown((s) => ({ now: s.now, before: "" }))}
      />
      {life.outdoor && life.season && <div className={`life-season life-season-${life.season}`} />}
      {sky && <div className={`life-sky life-sky-${sky} ${where}`} data-testid={`mate-life-${sky}`} data-where={where} />}
      <div className="life-backdrop-shade" />
      {life.asleep && <div className="life-asleep" data-testid="mate-life-asleep"><span>z</span><span>z</span><span>z</span></div>}
    </div>
  );
}
