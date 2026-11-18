/**
 * Her state as the ♥ status window shows it (stage/StatusWindow.tsx; docs/geny-state-system.md): every feeling with its
 * word and why, what is still with her (지금), what she is to the user and the promises both ways (관계), and the
 * journal of what happened (기록, gss/Journal.tsx). Only what is — the settings of how she is made (her temperament)
 * are in Mate settings → 기질, and what she is told each turn is never shown. It follows the server's pushes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getGss, prefsOf, type GssBonds, type GssEntry, type GssPromise, type GssState, type GssView, type Mate } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import { useT } from "../../../i18n";
import { stateWhy } from "../../../mate/reasons";
import { BOND_AXES, BOND_LABEL, bondPercent, bondScale, EMOTIONS, feelingWord, grudgeParts, mergeEntries, promiseStatusText, promiseTone, promiseWhen, wordText } from "../../../mate/gss";
import HelpTip from "../../ui/HelpTip";
import { FeelingRow } from "../StateCard";
import { STAGE_COLOR, STAGE_LABEL } from "../RelationRing";
import { Meter, NowContext, ToneChip, When } from "./bits";

const PAGE = 100;

/** a card in the window (light and dark alike: the page's own colours, a shade of its text over its surface) */
export function Block({ title, help, right, children, testId }: { title: ReactNode; help?: ReactNode; right?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-3 rounded-2xl border border-content/10 bg-content/[0.035] p-4" data-testid={testId}>
      <div className="flex items-center gap-2">
        <h3 className="flex min-w-0 flex-1 items-center text-[13px] font-semibold text-content">
          {title}
          {help && <HelpTip>{help}</HelpTip>}
        </h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/** her state now and the journal (paged), refetched when the server says it moved */
export function useGssView(mate: Mate) {
  const [v, setV] = useState<GssView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [older, setOlder] = useState<GssEntry[]>([]);
  const [more, setMore] = useState<{ busy: boolean; end: boolean; err: string | null }>({ busy: false, end: false, err: null });
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);
  const rev = useMateStore((s) => s.relationRev[mate.id] ?? 0);
  const pushed = JSON.stringify(mate.state ?? null);
  const temp = JSON.stringify(prefsOf(mate).temperament ?? null);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const x = await getGss(mate.id, { limit: PAGE });
      if (n !== seq.current) return null;
      setV(x);
      setErr(null);
      setNow(Date.now());
      if (x.journal.length < PAGE) setMore((m) => ({ ...m, end: true }));
      return x;
    } catch (e) {
      if (n === seq.current) setErr((e as Error).message);
      return null;
    }
  }, [mate.id]);
  useEffect(() => {
    void load();
  }, [load, rev, pushed, temp]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const entries = useMemo(() => mergeEntries(v?.journal ?? [], older), [v, older]);
  const loadMore = async () => {
    const last = entries[entries.length - 1];
    if (!last) return;
    setMore((m) => ({ ...m, busy: true, err: null }));
    try {
      const x = await getGss(mate.id, { limit: PAGE, before: last.id });
      setOlder((o) => mergeEntries(o, x.journal));
      setMore({ busy: false, end: x.journal.length < PAGE, err: null });
    } catch (e) {
      setMore((m) => ({ ...m, busy: false, err: (e as Error).message }));
    }
  };
  return { v, err, now, entries, more, loadMore, load };
}

export { NowContext };

/** every feeling with its word and why, and what is still with her */
export function Mind({ s, name }: { s: GssState; name: string }) {
  const t = useT();
  const byEmotion = new Map(s.feelings.map((f) => [f.emotion, f]));
  const g = s.grudge ? grudgeParts(t, s.grudge) : null;
  return (
    <Block
      title={t("mate.stateFeelings")}
      help={t("gss.nowHint", { name })}
      right={s.episodes > 0 ? <span className="shrink-0 text-[11px] text-content-faint" data-testid="mate-gss-episodes">{t("gss.nowEpisodes", { count: s.episodes })}</span> : undefined}
      testId="mate-gss-now"
    >
      <ul className="space-y-2" aria-label={t("mate.stateFeelings")}>
        {EMOTIONS.map((e) => {
          const f = byEmotion.get(e);
          const v = f?.v ?? 0;
          return <FeelingRow key={e} emotion={e} v={v} word={feelingWord(t, f?.word, v)} why={f && v >= 0.05 && f.why?.code !== "nature" ? stateWhy(t, f.why) : ""} />;
        })}
      </ul>
      {s.grudge && g && (
        <div className="rounded-lg border border-warning/30 bg-warning/[0.07] px-3 py-2.5" data-testid="mate-gss-grudge" data-stings={g.stings ? "true" : "false"}>
          <p className="text-[12.5px] font-medium text-warning">{t("gss.grudgeTitle")}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="w-[4.75rem] shrink-0 truncate text-[12px] text-content-dim">{g.strength}</span>
            <Meter ratio={s.grudge.v} color="rgb(var(--c-warning))" label={t("gss.grudgeTitle")} />
          </div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
            <dt className="text-content-faint">{t("gss.grudgeWhat")}</dt>
            <dd className="min-w-0 break-words text-content-dim">{g.what}</dd>
            <dt className="text-content-faint">{t("gss.grudgeWhen")}</dt>
            <dd className="text-content-dim">{g.ago}</dd>
            <dt className="text-content-faint">{t("gss.grudgeSorry")}</dt>
            <dd className="text-content-dim" data-testid="mate-gss-grudge-sorry">{g.sorry}</dd>
          </dl>
        </div>
      )}
    </Block>
  );
}

/** trust, romance, respect and affinity, and the stage */
export function Between({ b, name }: { b: GssBonds; name: string }) {
  const t = useT();
  const scale = bondScale(BOND_AXES.map((a) => b[a]));
  const rows = [
    ...BOND_AXES.map((a) => ({ id: a, label: t(BOND_LABEL[a]), v: bondPercent(b[a], scale), word: wordText(t, b.words?.[a]), color: undefined as string | undefined })),
    { id: "affinity", label: t(BOND_LABEL.affinity), v: Math.round(Math.max(-100, Math.min(100, b.affinity))), word: "", color: STAGE_COLOR[b.stage] },
  ];
  return (
    <Block
      title={t("gss.bondsTitle")}
      help={t("gss.bondsHint", { name })}
      right={
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-content-dim" data-testid="mate-gss-stage" data-stage={b.stage}>
          <span className="h-2 w-2 rounded-full" style={{ background: STAGE_COLOR[b.stage] }} />
          {STAGE_LABEL[b.stage] ? t(STAGE_LABEL[b.stage]) : b.stage}
        </span>
      }
      testId="mate-gss-bonds"
    >
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2" data-testid="mate-gss-bond" data-axis={r.id} data-value={r.v}>
            <span className="w-[4.75rem] shrink-0 truncate text-[12px] text-content-dim">{r.label}</span>
            <Meter ratio={Math.abs(r.v) / 100} color={r.color} label={r.label} />
            <span className="w-14 shrink-0 truncate text-right text-[11px] text-content-faint">{r.word}</span>
            <span className="w-7 shrink-0 text-right text-[11.5px] tabular-nums text-content-dim">{r.v}</span>
          </li>
        ))}
      </ul>
      {!b.romance_open && (
        <p className="text-[11.5px] leading-relaxed text-content-faint" data-testid="mate-gss-romance-closed">
          {t("gss.romanceClosed", { name })}
        </p>
      )}
    </Block>
  );
}

function PromiseList({ items, empty }: { items: GssPromise[]; empty: string }) {
  const t = useT();
  if (!items.length) return <p className="text-[11.5px] text-content-faint">{empty}</p>;
  return (
    <ul className="divide-y divide-content/10 rounded-lg border border-content/10 text-[12px]">
      {items.map((p) => {
        const when = promiseWhen(t, p);
        return (
          <li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5" data-testid="mate-gss-promise" data-status={p.status}>
            <span className={`min-w-0 flex-1 break-words ${p.status === "open" || p.status === "overdue" ? "text-content" : "text-content-dim"}`}>{p.what}</span>
            <ToneChip tone={promiseTone(p.status)}>{promiseStatusText(t, p.status)}</ToneChip>
            <span className="shrink-0 text-[11px] text-content-faint">{when.key ? t.rich(when.key, { when: <When at={when.at} /> }) : <When at={when.at} />}</span>
          </li>
        );
      })}
    </ul>
  );
}

const ORDER = { overdue: 0, open: 1, kept: 2, broken: 2, lapsed: 2 } as const;
const byWhen = (a: GssPromise, b: GssPromise) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3) || Date.parse(b.made_at) - Date.parse(a.made_at);

/** the promises both ways */
export function Promises({ promises, name }: { promises: GssPromise[]; name: string }) {
  const t = useT();
  const mine = promises.filter((p) => p.who === "user").sort(byWhen);
  const hers = promises.filter((p) => p.who === "her").sort(byWhen);
  return (
    <Block title={t("gss.promisesTitle")} help={t("gss.promisesHint", { name })} testId="mate-gss-promises">
      <div className="space-y-1.5">
        <p className="text-[12px] font-medium text-content-dim">{t("gss.promisesMine", { name })}</p>
        <PromiseList items={mine} empty={t("gss.promisesNone")} />
      </div>
      <div className="space-y-1.5">
        <p className="text-[12px] font-medium text-content-dim">{t("gss.promisesHers", { name })}</p>
        <PromiseList items={hers} empty={t("gss.promisesNone")} />
      </div>
    </Block>
  );
}
