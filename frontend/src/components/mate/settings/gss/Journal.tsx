/**
 * The State tab's journal: every event of the Geny-State-System, newest first, filtered by layer — what she heard in
 * their message (a model's reading), how her feelings, the grudge and the relationship moved, promises, episodes, exactly
 * what she was told each turn (her <context>), what she said, and the judgements of her replies (eval). "Load more"
 * fetches the next page (`before`).
 */
import { useMemo, useState } from "react";
import type { GssEntry, GssLayer, GssPromise, GssReading } from "../../../../api/mates";
import { useT } from "../../../../i18n";
import Icon from "../../../ui/Icon";
import { entryText, evalReport, filterEntries, kindText, LAYER_LABEL, LAYERS, promiseStatusText, promiseTone, promiseWhen, readingChips } from "../../../../mate/gss";
import { ErrorLine, Section } from "../ui";
import { Exact, ToneChip, When } from "./bits";
import { EvalReportView } from "./Evaluate";

function Reading({ r, name }: { r: GssReading; name: string }) {
  const t = useT();
  const chips = readingChips(t, r, name);
  return (
    <div className="space-y-1">
      {r.message && <p className="break-words text-content">“{r.message}”</p>}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="mate-gss-reading-chips">
          {chips.map((c, i) => (
            <ToneChip key={i} tone={c.tone}>
              {c.text}
            </ToneChip>
          ))}
        </div>
      )}
      {r.note && <p className="break-words text-[11.5px] leading-snug text-content-faint">{r.note}</p>}
      {r.by && <p className="text-[10.5px] text-content-faint">{t("gss.readBy", { by: r.by })}</p>}
    </div>
  );
}

function Told({ data }: { data: Record<string, unknown> }) {
  const t = useT();
  const block = typeof data.block === "string" ? data.block : "";
  return (
    <div>
      <p>{entryText(t, { layer: "told", kind: "", data })}</p>
      {block && (
        <details className="mt-1">
          <summary className="cursor-pointer select-none text-[11.5px] text-content-faint hover:text-content-dim">{t("gss.toldShow")}</summary>
          <Exact text={block} className="mt-1.5 max-h-80" testId="mate-gss-told-block" />
        </details>
      )}
    </div>
  );
}

function PromiseBody({ p }: { p: Partial<GssPromise> }) {
  const t = useT();
  const when = p.status && p.made_at ? promiseWhen(t, p as GssPromise) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {p.what && <span className="min-w-0 break-words text-content">“{p.what}”</span>}
      {p.status && <ToneChip tone={promiseTone(p.status)}>{promiseStatusText(t, p.status)}</ToneChip>}
      {when && <span className="text-[11px] text-content-faint">{when.key ? t.rich(when.key, { when: <When at={when.at} /> }) : <When at={when.at} />}</span>}
    </div>
  );
}

function Judged({ data }: { data: Record<string, unknown> }) {
  const t = useT();
  const r = evalReport(data);
  if (!r) return null;
  return (
    <div>
      <p className="break-words">{entryText(t, { layer: "eval", kind: "", data })}</p>
      <details className="mt-1">
        <summary className="cursor-pointer select-none text-[11.5px] text-content-faint hover:text-content-dim">{t("gss.evalShow")}</summary>
        <div className="mt-2">
          <EvalReportView r={r} />
        </div>
      </details>
    </div>
  );
}

function Body({ e, name }: { e: GssEntry; name: string }) {
  const t = useT();
  const d = e.data ?? {};
  if (e.layer === "heard") return <Reading r={d as GssReading} name={name} />;
  if (e.layer === "told") return <Told data={d} />;
  if (e.layer === "promise") return <PromiseBody p={d as Partial<GssPromise>} />;
  if (e.layer === "eval" && evalReport(d)) return <Judged data={d} />;
  const text = entryText(t, e);
  if (e.layer === "said" && text) return <p className="break-words text-content">“{text}”</p>;
  if (text) return <p className="break-words">{text}</p>;
  // (something this screen has no words for yet: as it came)
  return <Exact text={JSON.stringify(d, null, 2)} className="max-h-40" />;
}

export default function Journal({ entries, name, more, onMore }: { entries: GssEntry[]; name: string; more: { busy: boolean; end: boolean; err: string | null }; onMore: () => void }) {
  const t = useT();
  const [layer, setLayer] = useState<GssLayer | "all">("all");
  const shown = useMemo(() => filterEntries(entries, layer), [entries, layer]);
  const counts = useMemo(() => {
    const c: Partial<Record<GssLayer, number>> = {};
    for (const e of entries) c[e.layer] = (c[e.layer] ?? 0) + 1;
    return c;
  }, [entries]);
  return (
    <Section title={t("gss.journalTitle")} hint={t("gss.journalHint", { name })} right={<span className="text-[11px] tabular-nums text-content-faint">{shown.length}</span>} testId="mate-gss-journal">
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t("gss.journalTitle")}>
        {(["all", ...LAYERS] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={layer === f}
            onClick={() => setLayer(f)}
            className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition ${layer === f ? "border-accent/50 bg-accent-soft text-content" : "border-border text-content-dim hover:bg-surface-3 hover:text-content"}`}
            data-testid={`mate-gss-filter-${f}`}
          >
            {f === "all" ? t("gss.layerAll") : t(LAYER_LABEL[f])}
            {f !== "all" && counts[f] ? <span className="ml-1 tabular-nums text-content-faint">{counts[f]}</span> : null}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-[12px] text-content-faint">{entries.length ? t("gss.journalNoneHere") : t("gss.journalEmpty", { name })}</p>
      ) : (
        <ul className="divide-y divide-border/50 rounded-lg border border-border text-[12px] text-content-dim">
          {shown.map((e) => {
            const kind = kindText(t, e.kind);
            return (
              <li key={String(e.id)} className="flex items-start gap-2 px-2.5 py-2" data-testid="mate-gss-entry" data-layer={e.layer}>
                <span className="mt-px flex w-[4.5rem] shrink-0 flex-col items-start gap-0.5">
                  <ToneChip tone="muted">{LAYER_LABEL[e.layer] ? t(LAYER_LABEL[e.layer]) : e.layer}</ToneChip>
                  {kind && <span className="text-[10.5px] leading-tight text-content-faint">{kind}</span>}
                </span>
                <div className="min-w-0 flex-1">
                  <Body e={e} name={name} />
                </div>
                <When at={e.at} className="shrink-0 text-[11px] text-content-faint" />
              </li>
            );
          })}
        </ul>
      )}
      <ErrorLine text={more.err} />
      {!more.end && entries.length > 0 && (
        <button className="btn-ghost w-full !py-1 text-[12px]" disabled={more.busy} onClick={onMore} data-testid="mate-gss-journal-more">
          {more.busy && <Icon name="spinner" size={13} spin />} {t("gss.journalMore")}
        </button>
      )}
    </Section>
  );
}
