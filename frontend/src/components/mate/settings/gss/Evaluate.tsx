/**
 * The State tab's judgement of her replies (docs/geny-state-system.md, Roadmap 3): a model reads her last exchanges and
 * scores them 1 – 5 — how true to her persona, how varied, how she took hurt and apologies, how she used their name and
 * her address for them, her own will, the screen, the lines that never move — with an overall score, a summary and what
 * stood out (her own words, and why). The report also goes into the journal (layer "eval"), shown there the same way.
 */
import { useState } from "react";
import { evaluateGss } from "../../../../api/mates";
import { useT } from "../../../../i18n";
import Icon from "../../../ui/Icon";
import { criterionText, evalReport, scoreText, scoreTone } from "../../../../mate/gss";
import { ErrorLine, Section } from "../ui";
import { Meter, ToneChip } from "./bits";

type Report = NonNullable<ReturnType<typeof evalReport>>;

/** a report: the scores as small bars, the overall, the summary, what stood out */
export function EvalReportView({ r }: { r: Report }) {
  const t = useT();
  return (
    <div className="space-y-2.5" data-testid="mate-gss-eval-report">
      {r.error && <p className="break-words text-[12px] text-danger">{t("gss.evalError", { error: r.error })}</p>}
      {(r.overall !== null || r.exchanges > 0) && (
        <p className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-content-dim">
          {r.overall !== null && (
            <span className="text-[14px] font-semibold tabular-nums text-content" data-testid="mate-gss-eval-overall">
              {t("gss.evalOverall", { n: scoreText(r.overall) })}
            </span>
          )}
          {r.exchanges > 0 && <span className="text-[11.5px] text-content-faint">{t("gss.evalExchanges", { count: r.exchanges })}</span>}
        </p>
      )}
      {r.order.length > 0 && (
        <ul className="space-y-1.5">
          {r.order.map((c) => {
            const v = r.scores[c as keyof Report["scores"]] ?? 0;
            return (
              <li key={c} className="flex items-center gap-2" data-testid="mate-gss-eval-score" data-criterion={c} data-value={v}>
                <span className="w-[6.5rem] shrink-0 truncate text-[12px] text-content-dim">{criterionText(t, c)}</span>
                <Meter ratio={v / 5} label={criterionText(t, c)} />
                <span className="w-7 shrink-0 text-right text-[11.5px] tabular-nums text-content-dim">{scoreText(v)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {r.summary && <p className="break-words text-[12px] leading-relaxed text-content-dim">{r.summary}</p>}
      <div>
        <h4 className="mb-1.5 text-[12px] font-medium text-content-dim">{t("gss.evalFindings")}</h4>
        {r.findings.length === 0 ? (
          <p className="text-[11.5px] text-content-faint">{t("gss.evalNoFindings")}</p>
        ) : (
          <ul className="divide-y divide-border/50 rounded-lg border border-border text-[12px]">
            {r.findings.map((f, i) => (
              <li key={i} className="space-y-1 px-2.5 py-2" data-testid="mate-gss-eval-finding">
                <div className="flex flex-wrap items-center gap-1.5">
                  {f.criterion && <ToneChip tone={scoreTone(r.scores[f.criterion as keyof Report["scores"]] ?? 3)}>{criterionText(t, f.criterion)}</ToneChip>}
                  {f.turn > 0 && <span className="text-[10.5px] tabular-nums text-content-faint">{t("gss.evalTurn", { turn: f.turn })}</span>}
                </div>
                {f.quote && <p className="break-words text-content">“{f.quote}”</p>}
                {f.issue && <p className="break-words text-[11.5px] leading-snug text-content-faint">{f.issue}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function Evaluate({ mateId, name, onDone }: { mateId: string; name: string; onDone: () => void }) {
  const t = useT();
  const [last, setLast] = useState("20");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const n = Math.max(2, Math.min(100, Number(last) || 20));
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = evalReport(await evaluateGss(mateId, n));
      setReport(r);
      if (!r) setErr(t("gss.evalEmpty"));
      onDone(); // (the report is in the journal now)
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("gss.evalTitle")} hint={t("gss.evalHint", { name })} testId="mate-gss-eval">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[12px] text-content-dim">
          {t("gss.evalLast")}
          <input
            className="field !w-[4.5rem] !py-1 text-right tabular-nums"
            inputMode="numeric"
            value={last}
            onChange={(e) => setLast(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
            onBlur={() => setLast(String(n))}
            data-testid="mate-gss-eval-last"
          />
        </label>
        <button type="button" className="btn-primary !py-1.5 text-[12.5px]" disabled={busy} onClick={() => void run()} data-testid="mate-gss-eval-run">
          <Icon name={busy ? "spinner" : "sparkles"} size={13} spin={busy} /> {t("gss.evalRun", { n })}
        </button>
      </div>
      {busy && <p className="text-[11.5px] text-content-faint">{t("gss.evalRunning", { name })}</p>}
      <ErrorLine text={err} />
      {report && <EvalReportView r={report} />}
    </Section>
  );
}
