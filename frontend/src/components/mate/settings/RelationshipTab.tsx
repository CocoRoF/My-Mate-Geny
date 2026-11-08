/**
 * Relationship (this mate, docs/mate-memory-affinity.md §5–6): how close you two are (stage + warmth now), what
 * the next stage needs, her mood; on/off, pause, sensitivity, the indicator, the avatar's idle look following her
 * mood, setting the value by hand, a fresh start or a recompute from your real history; why it changed (collapsed).
 * Every change is saved at once and reaches every window by the server's push.
 */
import { useEffect, useRef, useState } from "react";
import { getRelation, patchRelation, RELATION_STAGES, resetRelation, type Mate, type RelationPatch, type RelationView } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import { relTime } from "../../../i18n/format";
import { useT, type TFunction } from "../../../i18n";
import { RelationRing, STAGE_LABEL } from "../RelationRing";
import { stateLine } from "../StateCard";
import { whyText } from "../../../mate/reasons";
import { ErrorLine, Field, ProgressBar, Section, Segmented, Toggle } from "./ui";

const SENS: { id: string; v: number; label: "mateSettings.relSensGentle" | "mateSettings.styleNormal" | "mateSettings.relSensStrong" }[] = [
  { id: "0.5", v: 0.5, label: "mateSettings.relSensGentle" },
  { id: "1", v: 1, label: "mateSettings.styleNormal" },
  { id: "1.5", v: 1.5, label: "mateSettings.relSensStrong" },
];

export { whyText };

export function milestoneText(t: TFunction, key: string): string {
  const days = /^days_(\d+)$/.exec(key);
  if (days) return t("mateSettings.relMsDays", { days: Number(days[1]) });
  const stage = /^stage_(\w+)$/.exec(key);
  if (stage && stage[1] in STAGE_LABEL) return t("mateSettings.relMsStage", { stage: t(STAGE_LABEL[stage[1] as keyof typeof STAGE_LABEL]) });
  if (key === "first_memory") return t("mateSettings.relMsFirstMemory");
  return key;
}

export default function RelationshipTab({ mate }: { mate: Mate }) {
  const t = useT();
  const [v, setV] = useState<RelationView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState<number | null>(null);
  const seq = useRef(0);
  const load = () => {
    const n = ++seq.current;
    getRelation(mate.id)
      .then((x) => n === seq.current && setV(x))
      .catch((e) => setErr((e as Error).message));
  };
  // (it changed in another window, or a message moved it: server push)
  const rev = useMateStore((s) => s.relationRev[mate.id] ?? 0);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mate.id, rev]);

  const apply = async (fn: () => Promise<RelationView>) => {
    setErr(null);
    try {
      setV(await fn());
      void useMateStore.getState().load(); // (this window's indicator at once; the others follow the push)
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const patch = (p: RelationPatch) => apply(() => patchRelation(mate.id, p));

  if (!v) {
    return (
      <Section title={t("mateSettings.relTitle")}>
        <ErrorLine text={err} />
        {!err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>}
      </Section>
    );
  }
  const stage = t(STAGE_LABEL[v.stage]);
  const off = !v.enabled;
  const distant = RELATION_STAGES.indexOf(v.warmth_stage) < RELATION_STAGES.indexOf(v.earned_stage);
  const value = manual ?? Math.round(v.affinity);

  return (
    <>
      <Section title={t("mateSettings.relTitle")} hint={t("mateSettings.relHint", { name: mate.name })} testId="mate-relation">
        <Toggle on={v.enabled} onChange={(on) => void patch({ enabled: on })} label={t("mateSettings.relEnabled")} hint={t("mateSettings.relEnabledHint")} testId="mate-relation-enabled" />
        <div className={`flex items-center gap-3 rounded-xl border border-border bg-surface-2/40 p-3 ${off ? "opacity-50" : ""}`} data-testid="mate-relation-status">
          <span className="text-content">
            <RelationRing value={v.affinity} stage={v.stage} size={44} />
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-[14px] font-semibold text-content">
              {stage} <span className="text-[12px] font-normal text-content-faint">· {Math.round(v.affinity)} / 100</span>
            </p>
            <p className="text-[11.5px] text-content-dim">
              {t("mateSettings.relStats", { days: v.stats.days_together, talks: v.stats.turns, memories: v.stats.memories })}
              {v.stats.streak_days >= 2 ? ` · ${t("mateSettings.relStreak", { count: v.stats.streak_days })}` : ""}
            </p>
            <p className="text-[11.5px] text-content-faint" data-testid="mate-relation-mood">
              {v.paused ? t("mate.relPaused") : stateLine(t, mate)}
            </p>
          </div>
        </div>
        {distant && !off && <p className="text-[11.5px] text-content-faint">{t("mateSettings.relDistant", { name: mate.name })}</p>}
        {v.next && !off && (
          <Field label={t("mateSettings.relNext", { stage: t(STAGE_LABEL[v.next.stage]) })} as="div">
            <ProgressBar value={v.next.ratio} testId="mate-relation-next" />
            <p className="text-[11.5px] text-content-faint">{t("mateSettings.relNeedWarmth")}</p>
          </Field>
        )}
      </Section>
      <Section title={t("mateSettings.relControls")} hint={t("mateSettings.relControlsHint", { days: v.stats.grace_days })}>
        <Toggle on={v.paused} onChange={(on) => void patch({ paused: on })} disabled={off} label={t("mateSettings.relPause")} hint={t("mateSettings.relPauseHint")} testId="mate-relation-pause" />
        <Field label={t("mateSettings.relSensitivity")} hint={t("mateSettings.relSensitivityHint")} as="div">
          <Segmented
            value={SENS.reduce((a, b) => (Math.abs(b.v - v.sensitivity) < Math.abs(a.v - v.sensitivity) ? b : a)).id}
            onChange={(id) => void patch({ sensitivity: SENS.find((s) => s.id === id)!.v })}
            options={SENS.map((s) => ({ id: s.id, label: t(s.label), disabled: off }))}
            testId="mate-relation-sensitivity"
          />
        </Field>
        <Toggle on={v.avatar_mood} onChange={(on) => void patch({ avatar_mood: on })} label={t("mateSettings.relAvatarMood")} hint={t("mateSettings.relAvatarMoodHint", { name: mate.name })} testId="mate-relation-avatar-mood" />
        <Field label={t("mateSettings.relManual")} hint={t("mateSettings.relManualHint")} as="div">
          <div className="flex items-center gap-2">
            <input type="range" min={0} max={100} step={1} value={value} disabled={off} onChange={(e) => setManual(Number(e.target.value))} className="flex-1" aria-label={t("mateSettings.relManual")} data-testid="mate-relation-slider" />
            <span className="w-8 text-right text-[12px] tabular-nums text-content-dim">{value}</span>
            <button
              className="btn-soft shrink-0 !py-1 text-[12px]"
              disabled={off || manual === null || manual === Math.round(v.affinity)}
              onClick={() => {
                const x = manual;
                setManual(null);
                if (x !== null) void patch({ affinity: x });
              }}
              data-testid="mate-relation-set"
            >
              {t("mateSettings.relSet")}
            </button>
          </div>
        </Field>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn-ghost !py-1 text-[12px]"
            disabled={off}
            onClick={() => window.confirm(t("mateSettings.relRecomputeConfirm", { name: mate.name })) && void apply(() => resetRelation(mate.id, "recompute"))}
            data-testid="mate-relation-recompute"
          >
            {t("mateSettings.relRecompute")}
          </button>
          <button
            className="btn-ghost !py-1 text-[12px] text-danger"
            onClick={() => window.confirm(t("mateSettings.relResetConfirm", { name: mate.name })) && void apply(() => resetRelation(mate.id, "zero"))}
            data-testid="mate-relation-reset"
          >
            {t("mateSettings.relReset")}
          </button>
        </div>
        <ErrorLine text={err} />
      </Section>
      <Section title={t("mateSettings.relHistory")}>
        <details className="group" data-testid="mate-relation-log">
          <summary className="cursor-pointer select-none text-[12.5px] text-content-dim hover:text-content">{t("mateSettings.relWhy", { count: v.log.length })}</summary>
          {v.log.length === 0 ? (
            <p className="mt-2 text-[12px] text-content-faint">{t("mateSettings.memEmpty")}</p>
          ) : (
            <ul className="mt-2 max-h-64 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border text-[12px]">
              {v.log.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex items-center gap-2 px-2.5 py-1.5">
                  <span className={`w-12 shrink-0 text-right tabular-nums ${e.d > 0 ? "text-success" : e.d < 0 ? "text-danger" : "text-content-faint"}`}>
                    {e.d > 0 ? "+" : ""}
                    {e.d === 0 ? "·" : e.d.toFixed(1)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-content-dim">{whyText(t, e.why)}</span>
                  <span className="shrink-0 tabular-nums text-content-faint">{Math.round(e.v)}</span>
                  <span className="w-20 shrink-0 text-right text-content-faint">{relTime(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
        {v.milestones.length > 0 && (
          <ul className="space-y-1 text-[12px] text-content-dim" data-testid="mate-relation-milestones">
            {v.milestones.slice(0, 8).map((m) => (
              <li key={m.key} className="flex gap-2">
                <span className="flex-1">{milestoneText(t, m.key)}</span>
                <span className="text-content-faint">{relTime(m.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
