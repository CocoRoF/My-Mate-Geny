/**
 * Mate settings → 상태 (the State Inspector; docs/geny-state-system.md): the Geny-State-System of this mate at once —
 * how she feels now (every feeling with its word and why, what is still with her, exactly what she is told), what she
 * is to the user (trust, romance, respect, affinity, the stage), promises both ways, lines she has been repeating, the
 * journal of every event (gss/Journal), her temperament with the user's own values (gss/TemperamentEditor; saved with
 * the Save bar), a scenario simulator (gss/Simulator) and a model's judgement of her last replies (gss/Evaluate). It
 * follows the server's pushes like the Relationship tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deriveTemperament, getGss, prefsOf, type GssBonds, type GssEntry, type GssPromise, type GssState, type GssView, type Mate, type Temperament } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import { useT } from "../../../i18n";
import { STATE_EMOJI } from "../../../mate/relationJournal";
import { stateWhy } from "../../../mate/reasons";
import { BOND_AXES, BOND_LABEL, bondPercent, bondScale, cleanTemperament, EMOTIONS, feelingWord, grudgeParts, mergeEntries, overrideOf, promiseStatusText, promiseTone, promiseWhen, sameTemperament, wordText } from "../../../mate/gss";
import { ifConfirmed } from "../../ui/ConfirmDialog";
import { FeelingRow, stateName } from "../StateCard";
import { STAGE_COLOR, STAGE_LABEL } from "../RelationRing";
import { ErrorLine, Field, SaveBar, Section, useSaver } from "./ui";
import { Exact, Meter, NowContext, ToneChip, When } from "./gss/bits";
import Journal from "./gss/Journal";
import TemperamentEditor from "./gss/TemperamentEditor";
import Simulator from "./gss/Simulator";
import Evaluate from "./gss/Evaluate";

const PAGE = 100;

function Now({ s, name }: { s: GssState; name: string }) {
  const t = useT();
  const why = stateWhy(t, s.top[0]?.why);
  const valence = Math.round(s.valence * 100);
  const byEmotion = new Map(s.feelings.map((f) => [f.emotion, f]));
  const g = s.grudge ? grudgeParts(t, s.grudge) : null;
  return (
    <Section title={t("mate.stateTitle")} hint={t("gss.nowHint", { name })} testId="mate-gss-now">
      <div>
        <p className="flex items-baseline gap-1.5 text-[14px] font-medium text-content" data-testid="mate-gss-now-state" data-state={s.label} data-blend={s.blend ?? ""}>
          <span aria-hidden>{STATE_EMOJI[s.label]}</span> {stateName(t, s)}
        </p>
        {why && <p className="mt-0.5 text-[12px] leading-relaxed text-content-dim">{why}</p>}
        <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11.5px] tabular-nums text-content-faint">
          <span>{t("mate.stateValence", { n: `${valence > 0 ? "+" : ""}${valence}` })}</span>
          <span>{t("mate.stateArousal", { n: Math.round(s.arousal * 100) })}</span>
          {s.episodes > 0 && <span data-testid="mate-gss-episodes">{t("gss.nowEpisodes", { count: s.episodes })}</span>}
        </p>
      </div>
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
            <span className="w-7 shrink-0 text-right text-[11.5px] tabular-nums text-content-dim">{Math.round(s.grudge.v * 100)}</span>
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
      <Field label={t("gss.lineTitle", { name })} hint={t("gss.lineHint")} as="div">
        <Exact text={s.line} testId="mate-gss-line" />
      </Field>
    </Section>
  );
}

function Between({ b, name }: { b: GssBonds; name: string }) {
  const t = useT();
  const scale = bondScale(BOND_AXES.map((a) => b[a]));
  const rows = [
    ...BOND_AXES.map((a) => ({ id: a, label: t(BOND_LABEL[a]), v: bondPercent(b[a], scale), word: wordText(t, b.words?.[a]), color: undefined as string | undefined })),
    { id: "affinity", label: t(BOND_LABEL.affinity), v: Math.round(Math.max(0, Math.min(100, b.affinity))), word: "", color: STAGE_COLOR[b.stage] },
  ];
  return (
    <Section
      title={t("gss.bondsTitle")}
      hint={t("gss.bondsHint", { name })}
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
            <Meter ratio={r.v / 100} color={r.color} label={r.label} />
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
    </Section>
  );
}

function PromiseList({ items, empty }: { items: GssPromise[]; empty: string }) {
  const t = useT();
  if (!items.length) return <p className="text-[11.5px] text-content-faint">{empty}</p>;
  return (
    <ul className="divide-y divide-border/50 rounded-lg border border-border text-[12px]">
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

function Promises({ promises, name }: { promises: GssPromise[]; name: string }) {
  const t = useT();
  const mine = promises.filter((p) => p.who === "user").sort(byWhen);
  const hers = promises.filter((p) => p.who === "her").sort(byWhen);
  return (
    <Section title={t("gss.promisesTitle")} hint={t("gss.promisesHint", { name })} testId="mate-gss-promises">
      <Field label={t("gss.promisesMine", { name })} as="div">
        <PromiseList items={mine} empty={t("gss.promisesNone")} />
      </Field>
      <Field label={t("gss.promisesHers", { name })} as="div">
        <PromiseList items={hers} empty={t("gss.promisesNone")} />
      </Field>
    </Section>
  );
}

export default function StateTab({ mate }: { mate: Mate }) {
  const t = useT();
  const [v, setV] = useState<GssView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [older, setOlder] = useState<GssEntry[]>([]);
  const [more, setMore] = useState<{ busy: boolean; end: boolean; err: string | null }>({ busy: false, end: false, err: null });
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);

  // what moves it: a push about the relationship or her feelings, the mate document's state, her temperament saved
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

  // her temperament: the form follows what is in effect until it is touched
  const effective = useMemo(() => cleanTemperament(v?.temperament), [v]);
  const custom = useMemo(() => cleanTemperament(v?.temperament_custom), [v]);
  const [draft, setDraft] = useState<Temperament | null>(null);
  const form = draft ?? effective;
  const dirty = draft !== null && !sameTemperament(draft, effective);
  const saver = useSaver();
  const [deriving, setDeriving] = useState(false);
  const [tempErr, setTempErr] = useState<string | null>(null);
  const savePrefs = (temperament: Temperament | null) => useMateStore.getState().patch(mate.id, { prefs: { temperament } });
  const save = () =>
    saver.run(async () => {
      await savePrefs(overrideOf(form, effective, custom));
      await load();
      setDraft(null);
    });
  const backToHers = () =>
    ifConfirmed({ body: t("gss.tempResetConfirm", { name: mate.name }), confirmLabel: t("gss.tempReset") }, async () => {
      setTempErr(null);
      try {
        await savePrefs(null);
        await load();
        setDraft(null);
      } catch (e) {
        setTempErr((e as Error).message);
      }
    });
  const derive = async () => {
    setDeriving(true);
    setTempErr(null);
    try {
      const r = await deriveTemperament(mate.id);
      const x = await load();
      // (saved by the server: the form shows it, and stays changed only if what is in effect didn't take it)
      const next = cleanTemperament({ ...cleanTemperament(x?.temperament ?? v?.temperament), ...cleanTemperament(r.temperament) });
      setDraft(x && sameTemperament(next, cleanTemperament(x.temperament)) ? null : next);
    } catch (e) {
      setTempErr((e as Error).message);
    } finally {
      setDeriving(false);
    }
  };
  const askDerive = () => (Object.keys(custom).length || dirty ? ifConfirmed({ body: t("gss.tempDeriveConfirm", { name: mate.name }), confirmLabel: t("gss.tempDerive") }, derive) : void derive());

  if (!v) {
    return (
      <Section title={t("gss.title")}>
        <ErrorLine text={err} />
        {!err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>}
      </Section>
    );
  }
  const name = mate.name;
  return (
    <NowContext.Provider value={now}>
      <p className="text-[11.5px] leading-relaxed text-content-faint" data-testid="mate-gss-intro">
        {t("gss.intro", { name })}
      </p>
      <ErrorLine text={err} />
      <Now s={v.state} name={name} />
      <Between b={v.bonds} name={name} />
      <Promises promises={v.promises ?? []} name={name} />
      {v.repeats?.length > 0 && (
        <Section title={t("gss.repeatsTitle")} hint={t("gss.repeatsHint", { name })} testId="mate-gss-repeats">
          <ul className="space-y-1">
            {v.repeats.map((r, i) => (
              <li key={i} className="break-words rounded-lg bg-surface/60 px-2.5 py-1.5 text-[12px] text-content-dim">
                “{r}”
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Journal entries={entries} name={name} more={more} onMore={() => void loadMore()} />
      <TemperamentEditor name={name} form={form} effective={effective} custom={custom} onChange={setDraft} onDerive={askDerive} onReset={backToHers} deriving={deriving} err={tempErr} dirty={dirty} />
      <Simulator mateId={mate.id} name={name} form={form} edited={dirty} affinity={v.bonds.affinity} />
      <Evaluate mateId={mate.id} name={name} onDone={() => void load()} />
      <SaveBar saver={saver} onSave={() => void save()} dirty={dirty} onReset={() => setDraft(null)} label={t("gss.tempSave")} />
    </NowContext.Provider>
  );
}
