/**
 * Conversation style (대화 방식; docs/mate.md "Prompt composition"): the one place that decides how this mate talks —
 * how she calls you (your name, her address for you, how she refers to herself) · speech (reply language, speech
 * level) · speech habits · length & emotion · tone · topics to avoid · whether she may change all this herself, with
 * the history of the changes she made (undo / apply). Each field changes a line of her prompt's "How you talk"
 * section (at her next message, with a note saying what changed); the emotion level also changes how readily the
 * avatar reacts — its unsaved value previews on every avatar of this browser at once. Her own changes arrive here live
 * (mates.changed).
 */
import { useEffect, useRef, useState } from "react";
import {
  effectiveStyle,
  fillAddress,
  prefsOf,
  type EmotionLevel,
  type Formality,
  type Mate,
  type MatePrefs,
  type ReplyLength,
  type SelfEdit,
  type StyleChange,
  type ToneLevel,
} from "../../../api/mates";
import { addressForms, isBareKoreanName } from "../../../lib/josa";
import { previewMateFlags } from "../../../mate/livePreview";
import { reactsAt } from "../../../mate/emotion";
import { describeChanges, fieldLabel, LANG_NAMES, resolveChange, useStyleChanges } from "../../../mate/styleChanges";
import type { MateConversation } from "../../../mate/useMateConversation";
import { useMateStore } from "../../../stores/mateStore";
import { useT, type MsgKey } from "../../../i18n";
import Icon from "../../ui/Icon";
import { Field, SaveBar, Section, Segmented, useFollowSaved, useSaver } from "./ui";

const LEVELS: { id: Exclude<Formality, "auto">; label: MsgKey }[] = [
  { id: "haeyo", label: "mateSettings.styleHaeyo" },
  { id: "hapsyo", label: "mateSettings.styleHapsyo" },
  { id: "banmal", label: "mateSettings.styleBanmal" },
];
const LENGTH: { id: ReplyLength; label: MsgKey }[] = [
  { id: "short", label: "mateSettings.styleShort" },
  { id: "normal", label: "mateSettings.styleNormal" },
  { id: "long", label: "mateSettings.styleLong" },
];
const EMOTION: { id: `${EmotionLevel}`; label: MsgKey }[] = [
  { id: "0", label: "mateSettings.styleEmoOff" },
  { id: "1", label: "mateSettings.styleEmoSubtle" },
  { id: "2", label: "mateSettings.styleNormal" },
  { id: "3", label: "mateSettings.styleEmoExpressive" },
];
const TONE: { key: keyof MatePrefs["tone"]; label: MsgKey; low: MsgKey; high: MsgKey }[] = [
  { key: "warmth", label: "mateSettings.styleWarmth", low: "mateSettings.styleWarmthLow", high: "mateSettings.styleWarmthHigh" },
  { key: "humor", label: "mateSettings.styleHumor", low: "mateSettings.styleHumorLow", high: "mateSettings.styleHumorHigh" },
  { key: "initiative", label: "mateSettings.styleInitiative", low: "mateSettings.styleInitiativeLow", high: "mateSettings.styleInitiativeHigh" },
];
const SELF_EDIT: { id: SelfEdit; label: MsgKey }[] = [
  { id: "auto", label: "mateSettings.styleSelfAuto" },
  { id: "ask", label: "mateSettings.styleSelfAsk" },
  { id: "off", label: "mateSettings.styleSelfOff" },
];
// "Try": a reply with a faint, a clear and a strong feeling — the level decides which ones move the avatar
const SAMPLE: { emotion: string; intensity: number }[] = [
  { emotion: "smile", intensity: 0.3 },
  { emotion: "joy", intensity: 0.9 },
  { emotion: "laugh", intensity: 1 },
];

type Draft = Pick<MatePrefs, "user_name" | "address" | "self_ref" | "formality" | "speech_style" | "length" | "emotion" | "tone" | "avoid" | "self_edit"> & { language: string };
const draftOf = (m: Mate): Draft => {
  const p = prefsOf(m);
  return {
    user_name: p.user_name,
    address: p.address,
    self_ref: p.self_ref,
    formality: p.formality,
    speech_style: p.speech_style,
    length: p.length,
    emotion: p.emotion,
    tone: { ...p.tone },
    avoid: p.avoid,
    self_edit: p.self_edit,
    language: m.persona.language || "ko",
  };
};

/** one of her own changes: what, when, why — Undo (applied) or Apply / Dismiss (proposed) */
function ChangeRow({ mateId, c }: { mateId: string; c: StyleChange }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const act = (action: "undo" | "apply" | "dismiss") => {
    setBusy(true);
    setNote(null);
    resolveChange(mateId, c.id, action)
      .then((r) => r.skipped.length && setNote(t("mateSettings.styleSkipped", { fields: r.skipped.map(fieldLabel).join(", ") })))
      .catch((e) => setNote(String((e as Error)?.message || e)))
      .finally(() => setBusy(false));
  };
  const done = c.status === "undone" || c.status === "dismissed";
  return (
    <li className="flex flex-col gap-0.5 rounded-lg border border-border/70 bg-surface/50 px-3 py-2" data-testid="mate-style-history-item" data-status={c.status}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        <span className={`min-w-0 flex-1 break-words text-content ${done ? "line-through opacity-60" : ""}`}>{describeChanges(c.changes)}</span>
        <span className={`shrink-0 rounded-full px-1.5 py-px text-[10.5px] ${c.status === "proposed" ? "bg-warning/15 text-warning" : "bg-surface-3 text-content-faint"}`}>
          {t(`mateSettings.styleStatus_${c.status}` as MsgKey)}
        </span>
        {c.status === "applied" && (
          <button type="button" className="btn-ghost shrink-0 !px-2 !py-0.5 text-[11.5px]" disabled={busy} onClick={() => act("undo")} data-testid="mate-style-history-undo">
            <Icon name="rotate" size={11} /> {t("mateSettings.styleUndo")}
          </button>
        )}
        {c.status === "proposed" && (
          <>
            <button type="button" className="btn-primary shrink-0 !px-2 !py-0.5 text-[11.5px]" disabled={busy} onClick={() => act("apply")} data-testid="mate-style-history-apply">
              {t("mateSettings.styleApply")}
            </button>
            <button type="button" className="btn-ghost shrink-0 !px-2 !py-0.5 text-[11.5px]" disabled={busy} onClick={() => act("dismiss")}>
              {t("mateSettings.styleDismiss")}
            </button>
          </>
        )}
      </div>
      <span className="text-[11px] text-content-faint">
        {new Date(c.created_at).toLocaleString()}
        {c.reason ? ` · “${c.reason}”` : ""}
      </span>
      {note && <span className="text-[11px] text-content-faint">{note}</span>}
    </li>
  );
}

export default function StyleTab({ mate, conv }: { mate: Mate; conv: MateConversation }) {
  const t = useT();
  const saved = draftOf(mate);
  const p = prefsOf(mate);
  const [d, setD] = useState<Draft>(saved);
  const [tried, setTried] = useState<number | null>(null);
  const saver = useSaver();
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const reset = () => setD(saved);
  // (her own changes, the user's in another window: they show here at once while nothing is being edited)
  useFollowSaved([JSON.stringify(saved)], dirty, reset);
  const changes = useStyleChanges(mate.id);

  // the unsaved emotion level shows on every avatar of this browser; saving or leaving the tab ends the preview
  useEffect(() => {
    previewMateFlags(mate.id, d.emotion !== saved.emotion ? { emotion: d.emotion } : null);
  }, [mate.id, d.emotion, saved.emotion]);
  useEffect(() => () => previewMateFlags(mate.id, null), [mate.id]);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const tryIt = () => {
    timers.current.forEach(clearTimeout);
    let reacted = 0;
    let n = 0;
    SAMPLE.forEach((s, i) => {
      if (!reactsAt(d.emotion, s.intensity, reacted)) return;
      reacted++;
      n++;
      timers.current.push(setTimeout(() => conv.poke(s.emotion), i * 1300));
    });
    setTried(n);
  };

  const save = () =>
    saver.run(async () => {
      const { language, ...prefs } = d;
      const m = await useMateStore.getState().patch(mate.id, {
        prefs,
        ...(language !== saved.language ? { persona: { language } } : {}),
      });
      setD(draftOf(m));
    });

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const korean = (d.language || "ko").toLowerCase().startsWith("ko");
  const nm = d.user_name.trim();
  const chips = nm ? (korean ? [`${nm}님`, `${nm} 씨`, nm, "주인님"] : [nm, "boss"]) : korean ? ["주인님", "사장님"] : ["boss"];
  const eff = effectiveStyle({ ...p, formality: d.formality, address: d.address, self_ref: d.self_ref });
  const forms = korean && d.address ? addressForms(d.address, eff.formality === "banmal" && isBareKoreanName(d.address, nm)) : null;
  const charAddress = p.defaults.address ? fillAddress(p.defaults.address, d.user_name, t("mateSettings.styleNamePh")) : "";
  const charLevel = LEVELS.find((l) => l.id === p.defaults.formality);
  const known = d.language in LANG_NAMES;

  return (
    <>
      <p className="text-[11.5px] leading-relaxed text-content-faint" data-testid="mate-style-intro">
        {t("mateSettings.styleIntro", { name: mate.name })}
      </p>
      <Section title={t("mateSettings.styleCallGroup")} hint={t("mateSettings.styleSpeechHint", { name: mate.name })} testId="mate-style-call">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("mateSettings.profUserName")} hint={t("mateSettings.profUserNameHint")}>
            <input className="field" value={d.user_name} onChange={(e) => set("user_name", e.target.value)} maxLength={80} placeholder={t("mateSettings.profUserNamePh")} data-testid="mate-user-name" />
          </Field>
          <Field label={t("mateSettings.profSelfRef")} hint={t("mateSettings.profSelfRefHint")}>
            <input className="field" value={d.self_ref} onChange={(e) => set("self_ref", e.target.value)} maxLength={40} placeholder={p.defaults.self_ref || t("mateSettings.profSelfRefPh")} data-testid="mate-self-ref" />
          </Field>
        </div>
        <Field label={t("mateSettings.profCallsYou")} hint={charAddress ? t("mateSettings.styleCallsYouHint", { value: charAddress }) : t("mateSettings.styleCallsYouNone")}>
          <input className="field" value={d.address} onChange={(e) => set("address", e.target.value)} maxLength={80} placeholder={charAddress || t("mateSettings.profCallsYouPh")} data-testid="mate-address" />
        </Field>
        <div className="flex flex-wrap gap-1.5" data-testid="mate-address-chips">
          {chips.map((c) => (
            <button
              key={c}
              type="button"
              className={`rounded-full border px-2.5 py-0.5 text-[12px] ${d.address === c ? "border-accent bg-accent-soft text-content" : "border-border text-content-dim hover:bg-surface-3"}`}
              onClick={() => set("address", d.address === c ? "" : c)}
            >
              {c}
            </button>
          ))}
        </div>
        {forms && (
          <p className="text-[11.5px] text-content-faint" data-testid="mate-address-forms">
            {t("mateSettings.profForms", { forms: [forms.subject, forms.topic, forms.object, forms.with, forms.to].filter(Boolean).join(" · "), call: forms.call })}
          </p>
        )}
      </Section>
      <Section title={t("mateSettings.styleLevelGroup")} testId="mate-style">
        <Field label={t("mateSettings.profReplyLang")}>
          <select className="field" value={known ? d.language : "__other"} onChange={(e) => e.target.value !== "__other" && set("language", e.target.value)} data-testid="mate-language">
            {Object.entries(LANG_NAMES).map(([c, l]) => (
              <option key={c} value={c}>
                {l}
              </option>
            ))}
            {!known && <option value="__other">{d.language || "—"}</option>}
          </select>
        </Field>
        <Field label={t("mateSettings.styleFormality")} hint={t("mateSettings.styleFormalityHint")} as="div">
          <Segmented<Formality>
            value={d.formality}
            onChange={(v) => set("formality", v)}
            options={[
              { id: "auto", label: charLevel ? t("mateSettings.styleAsCharacter", { level: t(charLevel.label) }) : t("mateSettings.styleAsWritten") },
              ...LEVELS.map((o) => ({ id: o.id, label: t(o.label) })),
            ]}
            testId="mate-style-formality"
          />
        </Field>
      </Section>
      <Section title={t("mateSettings.styleHabits")} hint={t("mateSettings.styleHabitsHint")} testId="mate-style-habits">
        <textarea className="field resize-y leading-relaxed" rows={6} maxLength={8000} value={d.speech_style} onChange={(e) => set("speech_style", e.target.value)} placeholder={t("mateSettings.styleHabitsPh")} data-testid="mate-style-speech" />
      </Section>
      <Section title={t("mateSettings.styleLengthGroup")}>
        <Field label={t("mateSettings.styleLength")} as="div">
          <Segmented value={d.length} onChange={(v) => set("length", v)} options={LENGTH.map((o) => ({ id: o.id, label: t(o.label) }))} testId="mate-style-length" />
        </Field>
        <Field label={t("mateSettings.styleEmotion")} hint={t("mateSettings.styleEmotionHint")} as="div">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={`${d.emotion}` as `${EmotionLevel}`} onChange={(v) => set("emotion", Number(v) as EmotionLevel)} options={EMOTION.map((o) => ({ id: o.id, label: t(o.label) }))} testId="mate-style-emotion" />
            <button type="button" className="btn-ghost !px-2.5 !py-1 text-[12px]" onClick={tryIt} data-testid="mate-style-try">
              <Icon name="sparkles" size={13} /> {t("mateSettings.styleTry")}
            </button>
          </div>
          {tried !== null && (
            <p className="text-[11.5px] text-content-faint" data-testid="mate-style-tried">
              {t("mateSettings.styleTried", { count: tried, total: SAMPLE.length })}
            </p>
          )}
        </Field>
      </Section>
      <Section title={t("mateSettings.styleTone")} hint={t("mateSettings.styleToneHint")}>
        {TONE.map((o) => (
          <Field key={o.key} label={t(o.label)} as="div">
            <Segmented<ToneLevel>
              value={d.tone[o.key]}
              onChange={(v) => setD((x) => ({ ...x, tone: { ...x.tone, [o.key]: v } }))}
              options={[
                { id: "low", label: t(o.low) },
                { id: "auto", label: t("mateSettings.styleAsWritten") },
                { id: "high", label: t(o.high) },
              ]}
              testId={`mate-style-${o.key}`}
            />
          </Field>
        ))}
      </Section>
      <Section title={t("mateSettings.styleAvoidGroup")} hint={t("mateSettings.styleAvoidHint")}>
        <textarea className="field resize-y leading-relaxed" rows={2} maxLength={500} value={d.avoid} onChange={(e) => set("avoid", e.target.value)} placeholder={t("mateSettings.styleAvoidPh")} data-testid="mate-style-avoid" aria-label={t("mateSettings.styleAvoid")} />
      </Section>
      <Section title={t("mateSettings.styleSelf")} hint={t("mateSettings.styleSelfHint", { name: mate.name })} testId="mate-style-self">
        <Field label={t("mateSettings.styleSelfLabel")} as="div">
          <Segmented<SelfEdit> value={d.self_edit} onChange={(v) => set("self_edit", v)} options={SELF_EDIT.map((o) => ({ id: o.id, label: t(o.label) }))} testId="mate-style-self-edit" />
        </Field>
        <div>
          <h4 className="mb-1.5 text-[12px] font-medium text-content-dim">{t("mateSettings.styleHistory")}</h4>
          {changes && changes.length > 0 ? (
            <ul className="space-y-1.5" data-testid="mate-style-history">
              {changes.slice(0, 12).map((c) => (
                <ChangeRow key={c.id} mateId={mate.id} c={c} />
              ))}
            </ul>
          ) : (
            <p className="text-[11.5px] text-content-faint">{t("mateSettings.styleHistoryEmpty")}</p>
          )}
        </div>
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} onReset={reset} />
    </>
  );
}
