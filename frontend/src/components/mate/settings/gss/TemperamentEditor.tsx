/**
 * The State tab's temperament (docs/geny-state-system.md §3): the values in effect, with what the user set marked — how
 * readily a sorry moves her, how long a hurt stays, how big a sulk something sweet still melts, which way a fight goes,
 * her attachment, how easily each feeling rises, how soon it passes and where it rests, what lights her up. "Read from
 * persona" has a model read it from who she is (saved at once); the Save bar saves the form as the user's own
 * (prefs.temperament: what they had set and whatever now differs); "Back to her own" clears it.
 */
import { useState, type ReactNode } from "react";
import type { StateEmotion, Temperament } from "../../../../api/mates";
import { useT, type MsgKey } from "../../../../i18n";
import Icon from "../../../ui/Icon";
import { STATE_EMOJI } from "../../../../mate/relationJournal";
import { ATTACHMENTS, CONFLICTS, EMOTION_LABEL, EMOTIONS, isCustom, knob, RANGES, type EmotionKnob, type ScalarKnob } from "../../../../mate/gss";
import { ErrorLine, Field, Section, Segmented } from "../ui";

const SCALARS: { k: ScalarKnob; label: MsgKey; hint: MsgKey; step: number }[] = [
  { k: "forgives", label: "gss.tempForgives", hint: "gss.tempForgivesHint", step: 0.05 },
  { k: "holds", label: "gss.tempHolds", hint: "gss.tempHoldsHint", step: 0.05 },
  { k: "sweet_until", label: "gss.tempSweetUntil", hint: "gss.tempSweetUntilHint", step: 0.01 },
];
const KNOBS: { id: EmotionKnob; label: MsgKey; hint: MsgKey; step: number }[] = [
  { id: "rise", label: "gss.tempRise", hint: "gss.tempRiseHint", step: 0.05 },
  { id: "settle", label: "gss.tempSettle", hint: "gss.tempSettleHint", step: 0.05 },
  { id: "base", label: "gss.tempBase", hint: "gss.tempBaseHint", step: 0.01 },
];
const CONFLICT_LABEL: Record<(typeof CONFLICTS)[number], MsgKey> = { confront: "gss.tempConfront", withdraw: "gss.tempWithdraw" };
const ATTACHMENT_LABEL: Record<(typeof ATTACHMENTS)[number], MsgKey> = { secure: "gss.tempSecure", anxious: "gss.tempAnxious", avoidant: "gss.tempAvoidant" };

const fixed = (v: number) => v.toFixed(2);

/** the user's own value (prefs.temperament): a dot beside its name */
function Mine({ on }: { on: boolean }) {
  const t = useT();
  if (!on) return null;
  return <span className="ml-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent align-middle" title={t("gss.tempMine")} aria-label={t("gss.tempMine")} data-testid="mate-gss-temp-mine" />;
}

function Slider({ value, range, step, onChange, label, changed, testId }: { value: number; range: [number, number]; step: number; onChange: (v: number) => void; label: string; changed: boolean; testId?: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <input type="range" min={range[0]} max={range[1]} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="min-w-0 flex-1" aria-label={label} data-testid={testId} />
      <span className={`w-9 shrink-0 text-right text-[12px] tabular-nums ${changed ? "text-accent" : "text-content-dim"}`}>{fixed(value)}</span>
    </div>
  );
}

function Loves({ value, onChange, mine }: { value: string[]; onChange: (v: string[]) => void; mine: boolean }) {
  const t = useT();
  const [q, setQ] = useState("");
  const add = () => {
    const words = q.split(/[,，、]/).map((w) => w.trim()).filter(Boolean);
    if (!words.length) return;
    onChange([...value, ...words.filter((w) => !value.includes(w))].slice(0, 60));
    setQ("");
  };
  return (
    <Field label={<>{t("gss.tempLoves")}<Mine on={mine} /></>} hint={t("gss.tempLovesHint")} as="div">
      <div className="flex flex-wrap items-center gap-1.5" data-testid="mate-gss-temp-loves">
        {value.map((w) => (
          <span key={w} className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[12px] text-content-dim">
            {w}
            <button type="button" className="text-content-faint hover:text-content" onClick={() => onChange(value.filter((x) => x !== w))} aria-label={t("gss.tempLovesRemove", { word: w })}>
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        <input
          className="field !w-auto min-w-[8rem] flex-1 !py-1 text-[12.5px]"
          value={q}
          maxLength={80}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder={t("gss.tempLovesPh")}
          data-testid="mate-gss-temp-loves-input"
        />
      </div>
    </Field>
  );
}

export default function TemperamentEditor({
  name,
  form,
  effective,
  custom,
  onChange,
  onDerive,
  onReset,
  deriving,
  err,
  dirty,
}: {
  name: string;
  form: Temperament;
  effective: Temperament;
  custom: Temperament;
  onChange: (v: Temperament) => void;
  onDerive: () => void;
  onReset: () => void;
  deriving: boolean;
  err: string | null;
  dirty: boolean;
}) {
  const t = useT();
  const [which, setWhich] = useState<EmotionKnob>("rise");
  const per = KNOBS.find((x) => x.id === which)!;
  const setScalar = (k: ScalarKnob, v: number) => onChange({ ...form, [k]: v });
  const setPer = (k: EmotionKnob, e: StateEmotion, v: number) => onChange({ ...form, [k]: { ...(form[k] ?? {}), [e]: v } });
  const anyMine = Object.keys(custom).length > 0;
  const right: ReactNode = (
    <button type="button" className="btn-soft shrink-0 !px-2.5 !py-1 text-[12px]" disabled={deriving} onClick={onDerive} title={t("gss.tempDeriveHint", { name })} data-testid="mate-gss-temp-derive">
      <Icon name={deriving ? "spinner" : "wand"} size={13} spin={deriving} /> {t("gss.tempDerive")}
    </button>
  );
  return (
    <Section title={t("gss.tempTitle")} hint={t("gss.tempHint", { name })} right={right} testId="mate-gss-temperament">
      {deriving && <p className="text-[11.5px] text-content-faint" data-testid="mate-gss-temp-deriving">{t("gss.tempDeriving", { name })}</p>}
      <p className="flex items-center gap-1.5 text-[11.5px] text-content-faint">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden /> {anyMine ? t("gss.tempMineLegend", { name }) : t("gss.tempNoneMine", { name })}
      </p>
      {SCALARS.map((s) => (
        <Field key={s.k} label={<>{t(s.label)}<Mine on={isCustom(custom, s.k)} /></>} hint={t(s.hint, { name })} as="div">
          <Slider value={knob(form, s.k)} range={RANGES[s.k]} step={s.step} onChange={(v) => setScalar(s.k, v)} label={t(s.label)} changed={Math.abs(knob(form, s.k) - knob(effective, s.k)) > 0.001} testId={`mate-gss-temp-${s.k}`} />
        </Field>
      ))}
      <Field label={<>{t("gss.tempConflict")}<Mine on={isCustom(custom, "conflict")} /></>} hint={t("gss.tempConflictHint", { name })} as="div">
        <Segmented
          value={form.conflict ?? ""}
          onChange={(v) => onChange({ ...form, conflict: v || undefined })}
          options={[{ id: "" as const, label: t("gss.tempUnset") }, ...CONFLICTS.map((c) => ({ id: c, label: t(CONFLICT_LABEL[c]) }))]}
          testId="mate-gss-temp-conflict"
        />
      </Field>
      <Field label={<>{t("gss.tempAttachment")}<Mine on={isCustom(custom, "attachment")} /></>} hint={t("gss.tempAttachmentHint")} as="div">
        <Segmented
          value={form.attachment ?? ""}
          onChange={(v) => onChange({ ...form, attachment: v || undefined })}
          options={[{ id: "" as const, label: t("gss.tempUnset") }, ...ATTACHMENTS.map((c) => ({ id: c, label: t(ATTACHMENT_LABEL[c]) }))]}
          testId="mate-gss-temp-attachment"
        />
      </Field>
      <Field label={<>{t("gss.tempPerEmotion")}<Mine on={isCustom(custom, "rise") || isCustom(custom, "settle") || isCustom(custom, "base")} /></>} hint={t(per.hint)} as="div">
        <Segmented value={which} onChange={setWhich} options={KNOBS.map((x) => ({ id: x.id, label: t(x.label) }))} testId="mate-gss-temp-knob" />
        <ul className="mt-2 space-y-1.5" data-testid="mate-gss-temp-emotions" data-knob={which}>
          {EMOTIONS.map((e) => {
            const v = knob(form, which, e);
            return (
              <li key={e} className="flex items-center gap-2">
                <span className="flex w-[5.25rem] shrink-0 items-center gap-1 truncate text-[12px] text-content-dim">
                  <span aria-hidden>{STATE_EMOJI[e]}</span> {t(EMOTION_LABEL[e])}
                  <Mine on={isCustom(custom, which, e)} />
                </span>
                <Slider value={v} range={RANGES[which]} step={per.step} onChange={(x) => setPer(which, e, x)} label={`${t(per.label)} · ${t(EMOTION_LABEL[e])}`} changed={Math.abs(v - knob(effective, which, e)) > 0.001} testId={`mate-gss-temp-${which}-${e}`} />
              </li>
            );
          })}
        </ul>
      </Field>
      <Loves value={form.loves ?? []} onChange={(loves) => onChange({ ...form, loves })} mine={isCustom(custom, "loves")} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost !py-1 text-[12px]" disabled={!anyMine && !dirty} onClick={onReset} data-testid="mate-gss-temp-reset">
          <Icon name="rotate" size={12} /> {t("gss.tempReset")}
        </button>
      </div>
      <ErrorLine text={err} />
    </Section>
  );
}
