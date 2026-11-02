/**
 * The relationship indicator next to a mate's name (docs/mate-memory-affinity.md §6): a small ring (how warm it is
 * now, 0–100) in the stage's colour and the stage word; the tooltip adds the value and her mood. Hidden while the
 * relationship is off or the user hid the indicator (Mate settings → Relationship). It follows the server's pushes.
 */
import type { Mate, MoodLabel, RelationStage } from "../../api/mates";
import { useT, type MsgKey } from "../../i18n";

export const STAGE_LABEL: Record<RelationStage, MsgKey> = {
  new: "mate.relStageNew",
  familiar: "mate.relStageFamiliar",
  trusted: "mate.relStageTrusted",
  companion: "mate.relStageCompanion",
};
export const MOOD_LABEL: Record<MoodLabel, MsgKey> = {
  cheerful: "mate.moodCheerful",
  content: "mate.moodContent",
  calm: "mate.moodCalm",
  focused: "mate.moodFocused",
  sleepy: "mate.moodSleepy",
  concerned: "mate.moodConcerned",
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

export default function RelationBadge({ mate, compact = false, onClick, active = false }: { mate: Mate; compact?: boolean; onClick?: () => void; active?: boolean }) {
  const t = useT();
  const rel = mate.relation;
  if (!rel || !rel.enabled || !rel.show_indicator) return null;
  const stage = t(STAGE_LABEL[rel.stage]);
  const tip = [
    t("mate.relTooltip", { name: mate.name, stage, value: rel.affinity }),
    rel.paused ? t("mate.relPaused") : rel.mood ? t("mate.relMood", { mood: t(MOOD_LABEL[rel.mood]) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const inner = (
    <>
      <RelationRing value={rel.affinity} stage={rel.stage} />
      {!compact && <span className={rel.paused ? "opacity-60" : ""}>{stage}</span>}
    </>
  );
  // (clickable: opens the Relationship panel)
  if (onClick)
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-content-dim transition hover:bg-surface-3 hover:text-content ${compact ? "min-h-8" : ""} ${active ? "bg-surface-3 text-content" : ""}`}
        title={tip}
        aria-label={tip}
        data-testid="mate-relation-badge"
        data-stage={rel.stage}
        data-value={rel.affinity}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {inner}
      </button>
    );
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-content-dim" title={tip} aria-label={tip} data-testid="mate-relation-badge" data-stage={rel.stage} data-value={rel.affinity}>
      {inner}
    </span>
  );
}
