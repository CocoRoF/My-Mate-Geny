/**
 * The ♥ status window's 기록: what happened, newest first, filtered by kind — what she heard in their message (a
 * model's reading), how her feelings, what is still with her and the relationship moved, promises, episodes, what she
 * said. Never what she is told each turn, nor a model's judgement of her replies (the server leaves those out).
 * "Load more" fetches the next page (`before`).
 */
import { useMemo, useState } from "react";
import type { GssEntry, GssLayer, GssPromise, GssReading } from "../../../api/mates";
import { useT } from "../../../i18n";
import Icon from "../../ui/Icon";
import { entryText, filterEntries, kindText, LAYER_LABEL, LAYERS, promiseStatusText, promiseTone, promiseWhen, readingChips } from "../../../mate/gss";
import { ErrorLine } from "../settings/ui";
import { Block } from "./StateView";
import { ToneChip, When } from "./bits";

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

function Body({ e, name }: { e: GssEntry; name: string }) {
  const t = useT();
  const d = e.data ?? {};
  if (e.layer === "heard") return <Reading r={d as GssReading} name={name} />;
  if (e.layer === "promise") return <PromiseBody p={d as Partial<GssPromise>} />;
  const text = entryText(t, e);
  if (e.layer === "said" && text) return <p className="break-words text-content">“{text}”</p>;
  return text ? <p className="break-words">{text}</p> : null;
}

export default function Journal({ entries, name, more, onMore }: { entries: GssEntry[]; name: string; more: { busy: boolean; end: boolean; err: string | null }; onMore: () => void }) {
  const t = useT();
  const [layer, setLayer] = useState<GssLayer | "all">("all");
  // (only what this window has words for: the kinds it shows)
  const shown = useMemo(() => filterEntries(entries.filter((e) => LAYERS.includes(e.layer)), layer), [entries, layer]);
  const counts = useMemo(() => {
    const c: Partial<Record<GssLayer, number>> = {};
    for (const e of entries) c[e.layer] = (c[e.layer] ?? 0) + 1;
    return c;
  }, [entries]);
  return (
    <Block title={t("gss.journalTitle")} help={t("gss.journalHint", { name })} right={<span className="text-[11px] tabular-nums text-content-faint">{shown.length}</span>} testId="mate-gss-journal">
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
    </Block>
  );
}
