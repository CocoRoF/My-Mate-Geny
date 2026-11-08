/**
 * How she feels right now (docs/mate-memory-affinity.md §5.4), in the Relationship tab and panel: the one state her feelings
 * make together and why, every emotion with its own value and reason, how good and how lively it all feels, and what moved
 * them lately. Every mate has this, with the relationship on or off.
 */
import { useEffect, useState } from "react";
import { getMateState, type Mate, type MateState, type StateEmotion, type StateLabel, type StateLogEntry, type StateView } from "../../api/mates";
import { useT, type MsgKey, type TFunction } from "../../i18n";
import { fmtTime } from "../../i18n/format";
import { STATE_EMOJI } from "../../mate/relationJournal";
import { stateWhy } from "../../mate/reasons";
import { useMateStore } from "../../stores/mateStore";

export { stateWhy };

export const STATE_LABEL: Record<StateLabel, MsgKey> = {
  happy: "mate.stateHappy",
  excited: "mate.stateExcited",
  shy: "mate.stateShy",
  angry: "mate.stateAngry",
  sad: "mate.stateSad",
  lonely: "mate.stateLonely",
  worried: "mate.stateWorried",
  sleepy: "mate.stateSleepy",
  calm: "mate.stateCalm",
};

/** the one state her feelings make together: what the two strongest make, or the strongest */
export function stateName(t: TFunction, s: MateState): string {
  return s.blend ? t(`mate.blend_${s.blend}` as MsgKey) : t(STATE_LABEL[s.label]);
}


export function stateLine(t: TFunction, mate: Mate): string {
  const s = mate.state;
  if (!s) return "";
  const why = stateWhy(t, s.top[0]?.why);
  return t("mate.relMood", { mood: stateName(t, s) }) + (why ? ` (${why})` : "");
}

function LogLine({ e }: { e: StateLogEntry }) {
  const t = useT();
  const why = stateWhy(t, e.why);
  const what = e.emotion
    ? `${t(STATE_LABEL[e.emotion])} ${(e.to ?? 0) >= (e.from ?? 0) ? "↑" : "↓"}`
    : e.clothes
      ? t("mate.stateLogClothes", { name: e.clothes })
      : t("mate.stateLogUsualClothes");
  return (
    <li className="flex gap-2 text-[11.5px] leading-relaxed" data-testid="mate-state-log-line">
      <span className="shrink-0 tabular-nums text-content-faint">{fmtTime(e.at)}</span>
      <span className="min-w-0 text-content-dim">
        <span className="text-content">{what}</span>
        {why ? ` · ${why}` : ""}
      </span>
    </li>
  );
}

function FeelingRow({ emotion, v, why }: { emotion: StateEmotion; v: number; why: string }) {
  const t = useT();
  const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
  return (
    <li data-testid="mate-state-feeling" data-emotion={emotion} data-value={pct}>
      <div className="flex items-center gap-2">
        <span className="flex w-[4.75rem] shrink-0 items-center gap-1 truncate text-[12px] text-content-dim">
          <span aria-hidden>{STATE_EMOJI[emotion]}</span> {t(STATE_LABEL[emotion])}
        </span>
        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </span>
        <span className="w-7 shrink-0 text-right text-[11.5px] tabular-nums text-content-dim">{pct}</span>
      </div>
      {why && <p className="mt-0.5 pl-[5.25rem] text-[11px] leading-snug text-content-faint">{why}</p>}
    </li>
  );
}

export function StateCard({ mate }: { mate: Mate }) {
  const t = useT();
  const rev = useMateStore((s) => s.relationRev[mate.id] ?? 0);
  const pushed = JSON.stringify(mate.state ?? null);
  const [v, setV] = useState<StateView | null>(null);
  useEffect(() => {
    let alive = true;
    getMateState(mate.id)
      .then((x) => alive && setV(x))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mate.id, rev, pushed]);
  if (!v) return null;
  const felt = [...v.feelings].sort((a, b) => b.v - a.v);
  const why = stateWhy(t, v.top[0]?.why);
  const valence = Math.round(v.valence * 100);
  return (
    <section className="rounded-xl border border-border bg-surface-2/50 p-4" data-testid="mate-state-card">
      <h3 className="mb-2 text-[13.5px] font-semibold text-content">{t("mate.stateTitle")}</h3>
      <p className="flex items-baseline gap-1.5 text-[14px] font-medium text-content" data-testid="mate-state-now" data-state={v.label} data-blend={v.blend ?? ""}>
        <span aria-hidden>{STATE_EMOJI[v.label]}</span> {stateName(t, v)}
      </p>
      {why && (
        <p className="mt-0.5 text-[12px] leading-relaxed text-content-dim" data-testid="mate-state-why">
          {why}
        </p>
      )}
      <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11.5px] tabular-nums text-content-faint" data-testid="mate-state-mix">
        <span>{t("mate.stateValence", { n: `${valence > 0 ? "+" : ""}${valence}` })}</span>
        <span>{t("mate.stateArousal", { n: Math.round(v.arousal * 100) })}</span>
      </p>
      <ul className="mt-3 space-y-2" aria-label={t("mate.stateFeelings")}>
        {felt.map((f) => (
          <FeelingRow key={f.emotion} emotion={f.emotion} v={f.v} why={f.v >= 0.05 && f.why.code !== "nature" ? stateWhy(t, f.why) : ""} />
        ))}
      </ul>
      {v.log.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[12px] text-content-dim">{t("mate.stateLog")}</summary>
          <ul className="mt-2 space-y-1">
            {v.log.slice(0, 12).map((e, i) => (
              <LogLine key={`${e.at}-${i}`} e={e} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
