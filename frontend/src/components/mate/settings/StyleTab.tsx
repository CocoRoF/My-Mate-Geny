/**
 * Conversation style (this mate, docs/mate-memory-affinity.md §3): speech level, reply length, emotion expression,
 * warmth / humor / initiative, topics to avoid. Each one changes a line of the mate's prompt (at its next message, with
 * a note saying what changed); the emotion level also changes how readily the avatar reacts and the voice colours —
 * its unsaved value previews on every avatar of this browser at once.
 */
import { useEffect, useRef, useState } from "react";
import { prefsOf, type EmotionLevel, type Formality, type Mate, type MatePrefs, type ReplyLength, type ToneLevel } from "../../../api/mates";
import { previewMateFlags } from "../../../mate/livePreview";
import { reactsAt } from "../../../mate/emotion";
import type { MateConversation } from "../../../mate/useMateConversation";
import { useMateStore } from "../../../stores/mateStore";
import { useT, type MsgKey } from "../../../i18n";
import Icon from "../../ui/Icon";
import { Field, SaveBar, Section, Segmented, useFollowSaved, useSaver } from "./ui";

const FORMALITY: { id: Formality; label: MsgKey }[] = [
  { id: "auto", label: "mateSettings.styleAsWritten" },
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
// "Try": a reply with a faint, a clear and a strong feeling — the level decides which ones move the avatar
const SAMPLE: { emotion: string; intensity: number }[] = [
  { emotion: "smile", intensity: 0.3 },
  { emotion: "joy", intensity: 0.9 },
  { emotion: "laugh", intensity: 1 },
];

type Draft = Pick<MatePrefs, "formality" | "length" | "emotion" | "tone" | "avoid">;
const draftOf = (p: MatePrefs): Draft => ({ formality: p.formality, length: p.length, emotion: p.emotion, tone: { ...p.tone }, avoid: p.avoid });

export default function StyleTab({ mate, conv }: { mate: Mate; conv: MateConversation }) {
  const t = useT();
  const saved = draftOf(prefsOf(mate));
  const [d, setD] = useState<Draft>(saved);
  const [tried, setTried] = useState<number | null>(null);
  const saver = useSaver();
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const reset = () => setD(saved);
  useFollowSaved([JSON.stringify(saved)], dirty, reset);

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
      const m = await useMateStore.getState().patch(mate.id, { prefs: d });
      setD(draftOf(prefsOf(m)));
    });

  return (
    <>
      <Section title={t("mateSettings.styleSpeech")} hint={t("mateSettings.styleSpeechHint", { name: mate.name })} testId="mate-style">
        <Field label={t("mateSettings.styleFormality")} hint={t("mateSettings.styleFormalityHint")} as="div">
          <Segmented value={d.formality} onChange={(v) => setD((x) => ({ ...x, formality: v }))} options={FORMALITY.map((o) => ({ id: o.id, label: t(o.label) }))} testId="mate-style-formality" />
        </Field>
        <Field label={t("mateSettings.styleLength")} as="div">
          <Segmented value={d.length} onChange={(v) => setD((x) => ({ ...x, length: v }))} options={LENGTH.map((o) => ({ id: o.id, label: t(o.label) }))} testId="mate-style-length" />
        </Field>
        <Field label={t("mateSettings.styleEmotion")} hint={t("mateSettings.styleEmotionHint")} as="div">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={`${d.emotion}` as `${EmotionLevel}`}
              onChange={(v) => setD((x) => ({ ...x, emotion: Number(v) as EmotionLevel }))}
              options={EMOTION.map((o) => ({ id: o.id, label: t(o.label) }))}
              testId="mate-style-emotion"
            />
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
        <Field label={t("mateSettings.styleAvoid")} hint={t("mateSettings.styleAvoidHint")}>
          <textarea className="field resize-y leading-relaxed" rows={2} maxLength={500} value={d.avoid} onChange={(e) => setD((x) => ({ ...x, avoid: e.target.value }))} placeholder={t("mateSettings.styleAvoidPh")} data-testid="mate-style-avoid" />
        </Field>
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} onReset={reset} />
    </>
  );
}
