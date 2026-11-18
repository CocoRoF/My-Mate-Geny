/** The game with her (app/mate/games.py), for the mate view: the 놀이 window and the word on its button. */
import { useEffect, useRef, useState } from "react";
import { getGame, type GameView, type Mate } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";

/** the game with her as the server has it, refetched whenever it moves (``game`` pushes) */
export function useGameView(mate: Mate | null): { v: GameView | null; setV: (v: GameView) => void } {
  const [v, setV] = useState<GameView | null>(null);
  const id = mate?.id ?? "";
  const rev = useMateStore((s) => s.gameRev[id] ?? 0);
  const seq = useRef(0);
  const shown = useRef(id);
  useEffect(() => {
    const n = ++seq.current;
    if (shown.current !== id) {
      shown.current = id;
      setV(null); // (another mate: not the last one's game meanwhile)
    }
    if (!id) return;
    getGame(id)
      .then((x) => n === seq.current && setV(x))
      .catch(() => {});
  }, [id, rev]);
  return { v, setV };
}

/** a word on the 놀이 button while a game is on: what to do next at a glance */
export function gameBadge(v: GameView | null): string {
  const g = v?.game;
  if (!g || g.status !== "on") return "";
  if (g.game === "wordchain") return g.next?.[0] ?? "…";
  if (g.game === "twenty") return g.ready ? `${g.asked ?? 0}/${g.max ?? 20}` : "…";
  if (g.game === "chosung") return g.initials || "…";
  return `${g.score.user}:${g.score.mate}`;
}
