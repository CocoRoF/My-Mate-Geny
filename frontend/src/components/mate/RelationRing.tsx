/**
 * The relationship stages' words and colours, and the small ring in the Relationship tab (docs/mate-memory-affinity.md §6):
 * how warm it is now, 0–100, in the stage's colour.
 */
import type { RelationStage } from "../../api/mates";
import type { MsgKey } from "../../i18n";

export const STAGE_LABEL: Record<RelationStage, MsgKey> = {
  new: "mate.relStageNew",
  familiar: "mate.relStageFamiliar",
  trusted: "mate.relStageTrusted",
  companion: "mate.relStageCompanion",
};
export const STAGE_COLOR: Record<RelationStage, string> = {
  new: "rgb(var(--c-stage-new))",
  familiar: "rgb(var(--c-stage-familiar))",
  trusted: "rgb(var(--c-stage-trusted))",
  companion: "rgb(var(--c-stage-companion))",
};

export function RelationRing({ value, stage, size = 16 }: { value: number; stage: RelationStage; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value)) / 100;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={2.5} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" style={{ stroke: STAGE_COLOR[stage] }} strokeWidth={2.5} strokeLinecap="round" strokeDasharray={`${c * v} ${c}`} />
    </svg>
  );
}
