/**
 * What the two of you are, in her own view (app/mate/gss/ties.py), in the ♥ status window: beside how close you are (the stage,
 * affinity), never the same thing. Only what is — hers to decide: the label and since when, her own words for it, how she has
 * felt about it lately, how settled it is, and how it came to be.
 */
import { useEffect, useRef, useState } from "react";
import type { Mate } from "../../../api/mates";
import { getTies, type Tie, type TiesView } from "../../../api/ties";
import { useT } from "../../../i18n";
import { fmtDate } from "../../../i18n/format";
import { TIE_BY, TIE_DESC, TIE_EMOJI, TIE_LABEL, TONE_CLASS, tieChangeText, tieTone } from "../../../mate/ties";
import { useMateStore } from "../../../stores/mateStore";
import { Meter, When } from "../gss/bits";
import { Block } from "../gss/StateView";

/** what she sees you as, refetched whenever the server says it moved (``ties`` pushes) or the relationship did */
export function useTie(mate: Mate): { v: TiesView | null; err: string | null } {
  const [v, setV] = useState<TiesView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rev = useMateStore((s) => s.tiesRev[mate.id] ?? 0);
  const relRev = useMateStore((s) => s.relationRev[mate.id] ?? 0);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    getTies(mate.id)
      .then((x) => n === seq.current && (setV(x), setErr(null)))
      .catch((e) => n === seq.current && setErr((e as Error).message));
  }, [mate.id, rev, relRev]);
  return { v, err };
}

/** the label as a pill: 💞 썸 */
export function TieChip({ tie, className = "", testId = "tie-chip" }: { tie: Pick<Tie, "label">; className?: string; testId?: string }) {
  const t = useT();
  return (
    <span className={`pill inline-flex shrink-0 items-center gap-1 ${TONE_CLASS[tieTone(tie.label)]} ${className}`} data-testid={testId} data-tie={tie.label}>
      <span aria-hidden>{TIE_EMOJI[tie.label]}</span>
      {t(TIE_LABEL[tie.label])}
    </span>
  );
}

const days = (since: string) => Math.max(0, Math.round((new Date(new Date().toDateString()).getTime() - new Date(new Date(since).toDateString()).getTime()) / 86400000));

/** the 관계 tab's card: what you two are, in full */
export default function TieCard({ mate }: { mate: Mate }) {
  const t = useT();
  const { v, err } = useTie(mate);
  const tie = v?.tie ?? null;
  const known = tie && tie.label !== "stranger" ? tie : null;
  const steady = tie?.steadiness ?? "steady";
  return (
    <Block title={t("ties.title")} help={t("ties.help", { name: mate.name })} testId="tie-card">
      {err && <p className="text-[12px] text-danger">{err}</p>}
      {!v ? (
        !err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
      ) : !known ? (
        <p className="text-[12.5px] leading-relaxed text-content-dim" data-testid="tie-none">
          {tie?.pending ? t("ties.pending") : t("ties.none", { name: mate.name })}
        </p>
      ) : (
        <>
          <div className="flex items-start gap-3" data-testid="tie-now" data-tie={known.label}>
            <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-[22px] ${TONE_CLASS[tieTone(known.label)]}`} aria-hidden>
              {TIE_EMOJI[known.label]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-[17px] font-semibold text-content" data-testid="tie-label">
                {t(TIE_LABEL[known.label])}
                <span className="text-[11.5px] font-normal text-content-faint" title={fmtDate(known.since)}>
                  {days(known.since) === 0 ? t("ties.sinceToday") : `${t("ties.since", { date: fmtDate(known.since, { month: "short", day: "numeric" }) })} · ${t("ties.forDays", { count: days(known.since) + 1 })}`}
                </span>
              </p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-content-dim">{t(TIE_DESC[known.label])}</p>
            </div>
          </div>
          {known.why && (
            <figure className="rounded-xl bg-content/[0.04] px-3 py-2" data-testid="tie-why">
              <figcaption className="text-[10.5px] font-medium text-content-faint">{t("ties.herWords")}</figcaption>
              <blockquote className="text-[12.5px] leading-relaxed text-content">“{known.why}”</blockquote>
            </figure>
          )}
          {known.thought && (
            <p className="text-[12px] leading-relaxed text-content-dim" data-testid="tie-thought">
              <span className="mr-1.5 text-[10.5px] font-medium text-content-faint">{t("ties.thought")}</span>“{known.thought}”
            </p>
          )}
          <div className="flex items-center gap-2" data-testid="tie-steadiness" data-steadiness={steady} title={t("ties.steadyHelp")}>
            <span className="w-[4.75rem] shrink-0 text-[12px] text-content-dim">{t("ties.steadiness")}</span>
            <Meter ratio={known.pressure} color={steady === "shaken" ? "rgb(var(--c-warning))" : undefined} label={t("ties.steadiness")} />
            <span className={`shrink-0 text-[11.5px] ${steady === "steady" ? "text-content-faint" : "text-warning"}`}>{t(`ties.steady_${steady}`)}</span>
          </div>
        </>
      )}
      {tie && tie.history.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11.5px] font-medium text-content-faint">{t("ties.history")}</p>
          <ol className="space-y-1.5" data-testid="tie-history">
            {tie.history.slice(0, 8).map((c, i) => (
              <li key={`${c.at}-${i}`} className="text-[12px] leading-relaxed" data-testid="tie-change" data-to={c.to}>
                <span className="flex flex-wrap items-center gap-x-1.5">
                  <span className="font-medium text-content">{tieChangeText(t, c)}</span>
                  <span className="text-[11px] text-content-faint">
                    <When at={c.at} />
                    {t(TIE_BY[c.by]) ? ` · ${t(TIE_BY[c.by])}` : ""}
                  </span>
                </span>
                {/* (the latest one's words are hers now, shown above) */}
                {c.why && !(i === 0 && known && c.why === known.why) && <span className="block text-content-dim">“{c.why}”</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Block>
  );
}
