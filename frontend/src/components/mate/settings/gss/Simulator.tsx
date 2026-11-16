/**
 * The State tab's scenario simulator (docs/geny-state-system.md, Roadmap 3): a preset ("threat → sorry → I love you") or
 * steps of the user's own (minutes after the one before, what I say, her reply, or something I do), optionally with the
 * temperament being edited and a starting affinity, played by the server on her state as it is. Shows the curves —
 * angry, sad, happy, lonely and what is still with her; trust, romance, respect and affinity — drawn like the System
 * tab's charts (TimeChart), and each step with exactly what she would be told.
 */
import { useMemo, useState } from "react";
import { simulateGss, type GssEvent, type GssSimPoint, type GssSimRequest, type Temperament } from "../../../../api/mates";
import { useT, type MsgKey, type TFunction } from "../../../../i18n";
import Icon from "../../../ui/Icon";
import TimeChart, { Legend, type ChartSeries, type Marker } from "../../../admin/system/TimeChart";
import { C1, C2, C3, C4, MUTED } from "../../../admin/system/fmt";
import { afterText, anyWhy, BOND_AXES, BOND_LABEL, cleanSteps, EMOTION_LABEL, EVENTS, parseHours, PRESETS, SIM_FEELINGS, simSeries } from "../../../../mate/gss";
import { ErrorLine, Field, Section, Segmented, Toggle } from "../ui";
import { Exact, ToneChip } from "./bits";

const EVENT_LABEL: Record<GssEvent, MsgKey> = { ignored: "gss.eventIgnored", declined_call: "gss.eventDeclinedCall", poke: "gss.eventPoke" };
const CUSTOM = "__custom";
const MAX_STEPS = 20;

interface StepDraft {
  key: number;
  after: string;
  kind: "say" | "event";
  say: string;
  reply: string;
  event: GssEvent;
}
let keys = 0;
const newStep = (after = "5"): StepDraft => ({ key: ++keys, after, kind: "say", say: "", reply: "", event: "ignored" });

const presetText = (t: TFunction, p: string) => {
  const key = `gss.preset_${p}`;
  const s = t(key as MsgKey);
  return s === key ? p.replace(/_/g, " ") : s;
};
const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function StepRow({ s, i, onChange, onRemove, name }: { s: StepDraft; i: number; onChange: (s: StepDraft) => void; onRemove: () => void; name: string }) {
  const t = useT();
  return (
    <li className="space-y-2 rounded-lg border border-border/70 bg-surface/50 p-2.5" data-testid="mate-gss-sim-step">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-5 shrink-0 text-[11px] tabular-nums text-content-faint">{i + 1}</span>
        <label className="flex items-center gap-1.5 text-[12px] text-content-dim">
          <input className="field !w-[4.5rem] !py-1 text-right tabular-nums" inputMode="numeric" value={s.after} onChange={(e) => onChange({ ...s, after: e.target.value.replace(/[^\d]/g, "").slice(0, 5) })} aria-label={t("gss.simAfterLabel")} data-testid="mate-gss-sim-after" />
          {t("gss.simAfterUnit")}
        </label>
        <Segmented value={s.kind} onChange={(kind) => onChange({ ...s, kind })} options={[{ id: "say" as const, label: t("gss.simKindSay") }, { id: "event" as const, label: t("gss.simKindEvent") }]} />
        <button type="button" className="btn-ghost ml-auto shrink-0 !px-2 !py-1" onClick={onRemove} aria-label={t("gss.simRemoveStep")} title={t("gss.simRemoveStep")}>
          <Icon name="x" size={13} />
        </button>
      </div>
      {s.kind === "say" ? (
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(14rem,100%),1fr))]">
          <input className="field !py-1.5 text-[12.5px]" value={s.say} maxLength={500} onChange={(e) => onChange({ ...s, say: e.target.value })} placeholder={t("gss.simSayPh")} aria-label={t("gss.simSay")} data-testid="mate-gss-sim-say" />
          <input className="field !py-1.5 text-[12.5px]" value={s.reply} maxLength={500} onChange={(e) => onChange({ ...s, reply: e.target.value })} placeholder={t("gss.simReplyPh", { name })} aria-label={t("gss.simReply", { name })} data-testid="mate-gss-sim-reply" />
        </div>
      ) : (
        <select className="field !py-1.5 text-[12.5px]" value={s.event} onChange={(e) => onChange({ ...s, event: e.target.value as GssEvent })} aria-label={t("gss.simKindEvent")} data-testid="mate-gss-sim-event">
          {EVENTS.map((ev) => (
            <option key={ev} value={ev}>
              {t(EVENT_LABEL[ev])}
            </option>
          ))}
        </select>
      )}
    </li>
  );
}

function Charts({ points }: { points: GssSimPoint[] }) {
  const t = useT();
  const s = useMemo(() => simSeries(points), [points]);
  const span = Math.max(60, s.t[s.t.length - 1] ?? 0);
  const fmt = (ts: number) => afterText(t, ts / 60);
  const common = { t: s.t, domain: [0, span] as [number, number], step: span, live: false, yMax: 100, yFmt: (v: number) => String(Math.round(v)), xFmt: fmt, tipFmt: fmt, height: 150 };
  const extra = (i: number) => (points[i]?.label ? [{ label: t("gss.simWhat"), value: clip(points[i].label) }] : []);
  const markers: Marker[] = points.flatMap((p, i) => (p.furious ? [{ ts: s.t[i], level: "error", message: t("gss.simFurious") }] : []));
  const colors = { angry: C2, sad: C1, happy: C4, lonely: C3 } as const;
  const feelings: ChartSeries[] = [
    { key: "grudge", label: t("gss.simGrudge"), color: MUTED, values: s.grudge, kind: "area" },
    ...SIM_FEELINGS.map((e) => ({ key: e, label: t(EMOTION_LABEL[e]), color: colors[e], values: s.feelings[e], kind: "line" as const })),
  ];
  const bondColors = { trust: C1, romance: C2, respect: C3 } as const;
  const bonds: ChartSeries[] = [
    { key: "affinity", label: t(BOND_LABEL.affinity), color: MUTED, values: s.affinity, kind: "area" },
    ...BOND_AXES.map((a) => ({ key: a, label: t(BOND_LABEL[a]), color: bondColors[a], values: s.bonds[a], kind: "line" as const })),
  ];
  const last = (v: (number | null)[]) => {
    const x = v[v.length - 1];
    return x === null || x === undefined ? undefined : String(x);
  };
  return (
    <div className="space-y-4" data-testid="mate-gss-sim-charts">
      <div>
        <h4 className="mb-1.5 text-[12px] font-medium text-content-dim">{t("gss.simFeelingsChart")}</h4>
        <div className="mb-2">
          <Legend items={feelings.map((x) => ({ label: x.label, color: x.color, kind: x.kind, value: last(x.values) }))} />
        </div>
        <TimeChart {...common} series={feelings} markers={markers} extra={extra} label={t("gss.simFeelingsChart")} />
      </div>
      <div>
        <h4 className="mb-1.5 text-[12px] font-medium text-content-dim">{t("gss.simBondsChart")}</h4>
        <div className="mb-2">
          <Legend items={bonds.map((x) => ({ label: x.label, color: x.color, kind: x.kind, value: last(x.values) }))} />
        </div>
        <TimeChart {...common} series={bonds} extra={extra} label={t("gss.simBondsChart")} />
      </div>
    </div>
  );
}

export default function Simulator({ mateId, name, form, edited, affinity }: { mateId: string; name: string; form: Temperament; edited: boolean; affinity: number }) {
  const t = useT();
  const [presets, setPresets] = useState<string[]>(PRESETS);
  const [pick, setPick] = useState<string>(PRESETS[3]);
  const [steps, setSteps] = useState<StepDraft[]>(() => [newStep("0")]);
  const [hours, setHours] = useState("1, 6, 24");
  const [useEdited, setUseEdited] = useState(true);
  const [fromAffinity, setFromAffinity] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [points, setPoints] = useState<GssSimPoint[] | null>(null);

  const custom = pick === CUSTOM;
  const body = (): GssSimRequest | null => {
    const extra: GssSimRequest = {
      ...(edited && useEdited ? { temperament: form } : {}),
      ...(fromAffinity !== null ? { affinity: fromAffinity } : {}),
    };
    if (!custom) return { preset: pick, ...extra };
    const clean = cleanSteps(steps.map((s) => ({ after_min: Number(s.after || 0), ...(s.kind === "event" ? { event: s.event } : { say: s.say, reply: s.reply }) })));
    if (!clean.length) return null;
    return { steps: clean, then_hours: parseHours(hours), ...extra };
  };
  const req = body();
  const run = async () => {
    const b = body();
    if (!b) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await simulateGss(mateId, b);
      setPoints(r.points);
      if (r.presets?.length) setPresets(r.presets);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("gss.simTitle")} hint={t("gss.simHint", { name })} testId="mate-gss-simulator">
      <Field label={t("gss.simScenario")} as="div">
        <Segmented value={pick} onChange={setPick} options={[...presets.map((p) => ({ id: p, label: presetText(t, p) })), { id: CUSTOM, label: t("gss.simCustom") }]} testId="mate-gss-sim-preset" />
      </Field>
      {custom && (
        <>
          <Field label={t("gss.simSteps")} hint={t("gss.simStepsHint", { name })} as="div">
            <ol className="space-y-2" data-testid="mate-gss-sim-steps">
              {steps.map((s, i) => (
                <StepRow key={s.key} s={s} i={i} name={name} onChange={(x) => setSteps((all) => all.map((y) => (y.key === s.key ? x : y)))} onRemove={() => setSteps((all) => (all.length > 1 ? all.filter((y) => y.key !== s.key) : [newStep("0")]))} />
              ))}
            </ol>
            {steps.length < MAX_STEPS && (
              <button type="button" className="btn-ghost mt-2 !py-1 text-[12px]" onClick={() => setSteps((all) => [...all, newStep()])} data-testid="mate-gss-sim-add">
                <Icon name="plus" size={12} /> {t("gss.simAddStep")}
              </button>
            )}
          </Field>
          <Field label={t("gss.simThenHours")} hint={t("gss.simThenHoursHint")}>
            <input className="field" value={hours} maxLength={80} onChange={(e) => setHours(e.target.value)} placeholder="1, 6, 24" data-testid="mate-gss-sim-hours" />
          </Field>
        </>
      )}
      <Toggle on={edited && useEdited} disabled={!edited} onChange={setUseEdited} label={t("gss.simUseEdited")} hint={edited ? t("gss.simUseEditedHint", { name }) : t("gss.simUseEditedNone")} testId="mate-gss-sim-use-edited" />
      <Toggle on={fromAffinity !== null} onChange={(on) => setFromAffinity(on ? Math.round(affinity) : null)} label={t("gss.simFromAffinity")} hint={t("gss.simFromAffinityHint", { name })} testId="mate-gss-sim-affinity-on" />
      {fromAffinity !== null && (
        <div className="flex items-center gap-2">
          <input type="range" min={0} max={100} step={1} value={fromAffinity} onChange={(e) => setFromAffinity(Number(e.target.value))} className="flex-1" aria-label={t("gss.simFromAffinity")} data-testid="mate-gss-sim-affinity" />
          <span className="w-8 text-right text-[12px] tabular-nums text-content-dim">{fromAffinity}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary !py-1.5 text-[12.5px]" disabled={busy || !req} onClick={() => void run()} data-testid="mate-gss-sim-run">
          <Icon name={busy ? "spinner" : "play"} size={13} spin={busy} /> {t("gss.simRun")}
        </button>
        {!req && <span className="text-[11.5px] text-content-faint">{t("gss.simNothing")}</span>}
      </div>
      <ErrorLine text={err} />
      {points && points.length === 0 && <p className="text-[12px] text-content-faint">{t("gss.simNoPoints")}</p>}
      {points && points.length > 0 && (
        <>
          <Charts points={points} />
          <div>
            <h4 className="mb-1.5 text-[12px] font-medium text-content-dim">{t("gss.simLines", { name })}</h4>
            <ol className="space-y-2" data-testid="mate-gss-sim-points">
              {points.map((p, i) => (
                <li key={i} className="rounded-lg border border-border/70 bg-surface/50 px-3 py-2" data-testid="mate-gss-sim-point">
                  <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                    <ToneChip tone="muted">{afterText(t, p.minute)}</ToneChip>
                    {p.label && <span className="min-w-0 flex-1 break-words text-content">{p.label}</span>}
                    {p.furious && <ToneChip tone="danger">{t("gss.simFurious")}</ToneChip>}
                  </div>
                  {anyWhy(t, p.angry_why) && <p className="mb-1 text-[11px] text-content-faint">{t("gss.simAngryWhy", { why: anyWhy(t, p.angry_why) })}</p>}
                  {p.line && <Exact text={p.line} className="max-h-40" />}
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </Section>
  );
}
