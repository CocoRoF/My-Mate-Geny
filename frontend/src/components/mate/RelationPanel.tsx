/**
 * The Relationship panel (docs/mate-memory-affinity.md §6.1) — memora's relationship page, as a side panel of the
 * Mate view (header ♥ or the indicator) and of the desktop Mate chat window. View-first: where you two are (stage
 * ring, affinity, mood, days together, streak), what the next stage still needs (the earned part and the warmth part —
 * the stage is the lower of the two), stats, 30 days of affinity, milestones and anniversaries, the change journal
 * (filters, by day) and her latest memories. This heart panel owns both memory and relationship management,
 * including their preferences. It follows the server's pushes (mates.changed → the store).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getRelationJournal, patchRelation, type Mate, type RelationChange, type RelationJournal, type RelationStage, RELATION_STAGES } from "../../api/mates";
import { useMateStore } from "../../stores/mateStore";
import { fmtDate, fmtTime, relTime } from "../../i18n/format";
import { useT, type MsgKey, type TFunction } from "../../i18n";
import Icon from "../ui/Icon";
import { STAGE_COLOR, STAGE_LABEL } from "./RelationRing";
import { StateCard, stateName, stateWhy } from "./StateCard";
import MemoryNotebook from "./MemoryNotebook";
import RelationshipTab from "./settings/RelationshipTab";
import { milestoneText, whyText } from "./settings/RelationshipTab";
import { CHANGE_FILTERS, chartSummary, deltaText, filterChanges, groupByDay, localDay, nextAnniversary, STATE_EMOJI, type ChangeFilter } from "../../mate/relationJournal";

export type RelationLink = "relation" | "memory";

const STAGE_DESC: Record<RelationStage, MsgKey> = {
  new: "mate.relPanelStageDescNew",
  familiar: "mate.relPanelStageDescFamiliar",
  trusted: "mate.relPanelStageDescTrusted",
  companion: "mate.relPanelStageDescCompanion",
};
const FILTER_LABEL: Record<ChangeFilter, MsgKey> = {
  all: "mate.relPanelFilterAll",
  gain: "mate.relPanelFilterGains",
  loss: "mate.relPanelFilterLosses",
  stage: "mate.relPanelFilterStages",
  manual: "mate.relPanelFilterManual",
};
const KIND_LABEL: Record<string, MsgKey> = {
  profile: "mateSettings.memKindProfile",
  preference: "mateSettings.memKindPreference",
  fact: "mateSettings.memKindFact",
  plan: "mateSettings.memKindPlan",
  context: "mateSettings.memKindContext",
};
const PAGE = 25;

export default function RelationPanel({ mate, onClose, initialTab = "relation" }: { mate: Mate; onClose: () => void; initialTab?: RelationLink }) {
  const t = useT();
  const [tab, setTab] = useState<RelationLink>(initialTab);
  const [adjusting, setAdjusting] = useState(false);
  // the other tab or view starts at its top
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo(0, 0);
  }, [tab, adjusting]);
  const [j, setJ] = useState<RelationJournal | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  // what moves it: a push about the relationship or her memories, or the mate document changing (stage, value, mood)
  const relRev = useMateStore((s) => s.relationRev[mate.id] ?? 0);
  const memRev = useMateStore((s) => s.memoryRev[mate.id] ?? 0);
  const summary = JSON.stringify(mate.relation ?? null);
  useEffect(() => {
    const n = ++seq.current;
    getRelationJournal(mate.id, 30)
      .then((x) => {
        if (n !== seq.current) return;
        setJ(x);
        setErr(null);
      })
      .catch((e) => n === seq.current && setErr((e as Error).message));
  }, [mate.id, relRev, memRev, summary]);

  const turnOn = async (patch: { enabled?: boolean; paused?: boolean }) => {
    setBusy(true);
    try {
      await patchRelation(mate.id, patch);
      setJ(await getRelationJournal(mate.id, 30));
      void useMateStore.getState().load(); // (this window's indicator at once; the others follow the push)
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const v = j?.relation;
  return (
    <div className="flex h-full flex-col" data-testid="mate-relation-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon name="heart" size={15} className="text-content-faint" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold">{t("mate.bondTitle")}</h2>
          <p className="truncate text-[11px] text-content-faint">{t("mate.relPanelSub", { name: mate.name })}</p>
        </div>
        {tab === "relation" && <button
          onClick={() => setAdjusting(v => !v)}
          aria-pressed={adjusting}
          className="btn-ghost shrink-0 !px-2.5 !py-1 text-[12px]"
          title={t("mate.bondAdjust")}
          aria-label={t("mate.bondAdjust")}
          data-testid="mate-relation-panel-adjust"
        >
          <Icon name="sliders" size={13} /> <span className="hidden min-[400px]:inline">{t("mate.bondAdjust")}</span>
        </button>}
        <button onClick={onClose} className="btn-ghost !px-2" aria-label={t("common.close")} data-testid="mate-relation-panel-close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="flex shrink-0 gap-1 border-b border-border px-4 py-2" role="tablist" aria-label={t("mate.bondTitle")}>
        {(["relation", "memory"] as const).map(id => (
          <button type="button" role="tab" key={id} aria-selected={tab === id}
            className={tab === id ? "btn-soft" : "btn-ghost"} data-testid={`bond-tab-${id}`} onClick={() => setTab(id)}>
            <Icon name={id === "relation" ? "heart" : "brain"} size={14} />
            {t(id === "relation" ? "mateSettings.relTitle" : "mateSettings.memTitle")}
          </button>
        ))}
      </div>
      <div ref={body} className="fit-fields min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-safe">
        <div className="mx-auto max-w-xl space-y-4 pb-6">
          {tab === "memory" ? <MemoryNotebook key={mate.id} mate={mate} /> : adjusting ? <RelationshipTab key={mate.id} mate={mate} /> : <>
          {err && <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{t("mate.relPanelError", { error: err })}</p>}
          {!j || !v ? (
            !err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
          ) : (
            <>
              {!v.enabled ? (
                <Card testId="mate-relation-panel-off">
                  <p className="text-[14px] font-semibold text-content">{t("mate.relPanelOffTitle")}</p>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-content-dim">{t("mate.relPanelOffBody", { name: mate.name })}</p>
                  <button className="btn-primary mt-3 !py-1.5 text-[12.5px]" disabled={busy} onClick={() => void turnOn({ enabled: true })} data-testid="mate-relation-panel-turn-on">
                    {busy && <Icon name="spinner" size={13} spin />} {t("mate.relPanelTurnOn")}
                  </button>
                </Card>
              ) : (
                <>
                  {v.paused && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning/30 bg-warning/[0.07] px-3 py-2.5" data-testid="mate-relation-panel-paused">
                      <Icon name="pause" size={14} className="shrink-0 text-warning" />
                      <div className="min-w-0 flex-1 basis-48">
                        <p className="text-[12.5px] font-medium text-warning">{t("mate.relPanelPausedTitle")}</p>
                        <p className="text-[11.5px] text-content-dim">{t("mate.relPanelPausedBody")}</p>
                      </div>
                      <button className="btn-soft shrink-0 !py-1 text-[12px]" disabled={busy} onClick={() => void turnOn({ paused: false })} data-testid="mate-relation-panel-resume">
                        <Icon name="play" size={12} /> {t("mate.relPanelResume")}
                      </button>
                    </div>
                  )}
                  <Hero j={j} mate={mate} />
                  <StateCard mate={mate} />
                  <NextStage j={j} mate={mate} />
                </>
              )}
              <Stats j={j} />
              <Chart j={j} />
              <Milestones j={j} />
              <Changes changes={j.changes} />
              <Memories j={j} mate={mate} onManage={() => setTab("memory")} />
            </>
          )}
          </>}
        </div>
      </div>
    </div>
  );
}

function Card({ title, right, children, testId }: { title?: ReactNode; right?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="rounded-xl border border-border bg-surface-2/50 p-4" data-testid={testId}>
      {(title || right) && (
        <div className="mb-3 flex items-center gap-2">
          <h3 className="min-w-0 flex-1 text-[13.5px] font-semibold text-content">{title}</h3>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

/** the big ring: fill = affinity, colour = the stage */
function StageRing({ value, stage, size = 104 }: { value: number; stage: RelationStage; size?: number }) {
  const sw = 8;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(100, value)) / 100;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" className="text-surface-3" strokeWidth={sw} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          style={{ stroke: STAGE_COLOR[stage] }}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={`${c * Math.max(0.005, f)} ${c}`}
          className="transition-[stroke-dasharray] duration-700"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center leading-none">
        <div>
          <div className="text-[26px] font-semibold tabular-nums text-content" data-testid="mate-relation-panel-value">
            {Math.round(value)}
          </div>
          <div className="mt-1 text-[10px] text-content-faint">/ 100</div>
        </div>
      </div>
    </div>
  );
}

function Hero({ j, mate }: { j: RelationJournal; mate: Mate }) {
  const t = useT();
  const v = j.relation;
  const idx = RELATION_STAGES.indexOf(v.stage);
  return (
    <Card testId="mate-relation-panel-hero">
      <div className="flex items-center gap-4">
        <StageRing value={v.affinity} stage={v.stage} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="flex items-center gap-2 text-[18px] font-semibold text-content" data-testid="mate-relation-panel-stage" data-stage={v.stage}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STAGE_COLOR[v.stage] }} />
            {t(STAGE_LABEL[v.stage])}
            <span className="text-[11.5px] font-normal text-content-faint">
              {t("mate.relPanelAffinity")} {Math.round(v.affinity)}
            </span>
          </p>
          <p className="text-[12px] leading-relaxed text-content-dim">{t(STAGE_DESC[v.stage], { name: mate.name })}</p>
          <div className="flex flex-wrap gap-1.5 pt-0.5 text-[11.5px]">
            <Chip testId="mate-relation-panel-mood">
              {v.paused ? (
                t("mate.relPaused")
              ) : mate.state ? (
                <span title={stateWhy(t, mate.state.top[0]?.why)}>
                  <span aria-hidden>{STATE_EMOJI[mate.state.label]}</span> {stateName(t, mate.state)}
                </span>
              ) : null}
            </Chip>
            <Chip testId="mate-relation-panel-days">
              <Icon name="heart" size={11} className="text-content-faint" />{" "}
              {v.stats.days_together ? t("mate.relPanelDaysTogether", { count: v.stats.days_together }) : t("mate.relPanelNotYet")}
            </Chip>
            {v.stats.streak_days >= 1 && (
              <Chip testId="mate-relation-panel-streak">
                <Icon name="bolt" size={11} className="text-content-faint" /> {t("mate.relPanelStreak", { count: v.stats.streak_days })}
              </Chip>
            )}
          </div>
        </div>
      </div>
      <ol className="mt-4 flex items-center gap-1" aria-label={t("mate.relPanelStages")}>
        {RELATION_STAGES.map((s, i) => (
          <li key={s} className="flex min-w-0 flex-1 items-center gap-1">
            <span
              className={`min-w-0 flex-1 truncate rounded-full px-2 py-1 text-center text-[11px] font-medium ${i <= idx ? "text-stage-ink" : "bg-surface-3 text-content-faint"}`}
              style={i <= idx ? { background: STAGE_COLOR[s] } : undefined}
              aria-current={i === idx ? "step" : undefined}
            >
              {t(STAGE_LABEL[s])}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Chip({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface/60 px-2 py-0.5 text-content-dim" data-testid={testId}>
      {children}
    </span>
  );
}

function Bar({ ratio, color, testId }: { ratio: number; color: string; testId?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} data-testid={testId}>
      <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.max(2, pct)}%`, background: color }} />
    </div>
  );
}

function NextStage({ j, mate }: { j: RelationJournal; mate: Mate }) {
  const t = useT();
  const q = j.requirements;
  const v = j.relation;
  const distant = RELATION_STAGES.indexOf(v.warmth_stage) < RELATION_STAGES.indexOf(v.earned_stage);
  if (!q) {
    return (
      <Card title={t("mate.relPanelNextTitle")} testId="mate-relation-panel-next">
        <p className="text-[12.5px] text-content-dim">{t("mate.relPanelMax")}</p>
      </Card>
    );
  }
  return (
    <Card title={t("mate.relPanelNextTo", { stage: t(STAGE_LABEL[q.stage]) })} testId="mate-relation-panel-next">
      <div className="space-y-2.5">
        <div data-testid="mate-relation-panel-warmth">
          <PartHead label={t("mate.relPanelWarmth")} hint={t("mate.relPanelWarmthHint", { days: v.stats.grace_days })} met={false} />
          <Bar ratio={q.warmth.ratio} color={STAGE_COLOR[q.stage]} />
          <p className="mt-1.5 text-[11.5px] tabular-nums text-content-dim">
            {t("mate.relPanelWarmthNeed", { value: Math.round(q.warmth.value), target: Math.round(q.warmth.target), left: Math.ceil(q.warmth.left) })}
          </p>
        </div>
        {distant && <p className="text-[11.5px] leading-relaxed text-content-faint">{t("mateSettings.relDistant", { name: mate.name })}</p>}
      </div>
    </Card>
  );
}

function PartHead({ label, hint, met }: { label: string; hint: string; met: boolean }) {
  const t = useT();
  return (
    <div className="mb-1.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-[12.5px] font-medium text-content">{label}</span>
        {met && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-success">
            <Icon name="check" size={11} /> {t("mate.relPanelMet")}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-snug text-content-faint">{hint}</p>
    </div>
  );
}

function Stats({ j }: { j: RelationJournal }) {
  const t = useT();
  const s = j.stats;
  return (
    <Card title={t("mate.relPanelStatsTitle")} testId="mate-relation-panel-stats">
      <dl className="grid grid-cols-2 gap-2 min-[480px]:grid-cols-3">
        <Stat label={t("mate.relPanelStatTalks")} value={s.turns} />
        <Stat label={t("mate.relPanelStatActiveDays")} value={s.active_days} />
        <Stat label={t("mate.relPanelStatMemories")} value={s.memories} hint={t("mate.relPanelStatMemoriesHint", { n: s.memories_active })} />
        <Stat label={t("mate.relPanelStatLongest")} value={t("mate.relPanelStatDays", { count: s.longest_streak })} />
        <Stat label={t("mate.relPanelStatLast")} value={s.last_talk_at ? relTime(s.last_talk_at) : t("mate.relPanelNever")} hint={s.last_talk_at ? fmtDate(s.last_talk_at) : undefined} />
      </dl>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg bg-surface/60 px-3 py-2">
      <dt className="text-[11px] text-content-faint">{label}</dt>
      <dd className="mt-0.5 text-[16px] font-semibold tabular-nums text-content">{value}</dd>
      {hint && <dd className="text-[10.5px] text-content-faint">{hint}</dd>}
    </div>
  );
}

const dayLabel = (day: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) => fmtDate(new Date(`${day}T12:00:00`), opts);

/** 30 days of affinity: one thin bar per day (the value at its end) in the stage's colour, a dot under the days you
 *  talked; hover / focus shows the day; a table is the text alternative. */
function Chart({ j }: { j: RelationJournal }) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const sum = chartSummary(j.series);
  const color = STAGE_COLOR[j.relation.stage];
  const shown = hover ?? j.series.length - 1;
  const x = j.series[shown];
  const alt = sum ? t("mate.relPanelChartAlt", { days: j.days, ...sum }) : t("mate.relPanelChartEmpty");
  const line = (p: RelationJournal["series"][number]) =>
    [
      dayLabel(p.day, { month: "short", day: "numeric", weekday: "short" }),
      p.v === null ? t("mate.relPanelChartNoValue") : t("mate.relPanelChartValue", { value: Math.round(p.v) }),
      p.talks ? t("mate.relPanelChartTalks", { count: p.talks }) : "",
      p.up || p.down ? [p.up ? deltaText(p.up) : "", p.down ? deltaText(p.down) : ""].filter(Boolean).join(" ") : "",
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <Card title={t("mate.relPanelChartTitle", { days: j.days })} testId="mate-relation-panel-chart">
      {!sum ? (
        <p className="text-[12px] text-content-faint">{t("mate.relPanelChartEmpty")}</p>
      ) : (
        <>
          <p className="mb-2 h-4 truncate text-[11.5px] tabular-nums text-content-dim" aria-live="polite" data-testid="mate-relation-panel-chart-line">
            {x && line(x)}
          </p>
          <div role="img" aria-label={alt}>
            <div className="relative h-[84px]">
              {/* recessive guides at 25 / 50 / 75 */}
              {[25, 50, 75].map((g) => (
                <div key={g} className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border/50" style={{ bottom: `${g}%` }} />
              ))}
              <div className="relative flex h-full items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
                {j.series.map((p, i) => (
                  <div
                    key={p.day}
                    className="flex h-full min-w-0 flex-1 cursor-default items-end rounded-t-[3px] outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    tabIndex={0}
                    aria-label={line(p)}
                    data-testid="mate-relation-panel-bar"
                    data-v={p.v ?? ""}
                  >
                    <div
                      className={`w-full rounded-t-[3px] transition-opacity ${i === shown ? "opacity-100" : "opacity-55"}`}
                      style={{ height: p.v === null ? 0 : `${Math.max(2, p.v)}%`, background: color }}
                    />
                  </div>
                ))}
              </div>
            </div>
            {/* the days you talked */}
            <div className="mt-1 flex h-1.5 gap-[2px]" aria-hidden>
              {j.series.map((p) => (
                <div key={p.day} className="flex min-w-0 flex-1 justify-center">
                  {p.talks > 0 && <span className="h-1.5 w-1.5 rounded-full bg-content-faint" />}
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[10px] tabular-nums text-content-faint" aria-hidden>
              <span>{dayLabel(j.series[0].day)}</span>
              <span>{dayLabel(j.series[j.series.length - 1].day)}</span>
            </div>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer select-none text-[11.5px] text-content-faint hover:text-content-dim">{t("mate.relPanelChartTable")}</summary>
            <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-[11.5px] tabular-nums">
                <thead className="sticky top-0 bg-surface-2 text-content-faint">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">{t("mate.relPanelColDay")}</th>
                    <th className="px-2 py-1 text-right font-medium">{t("mate.relPanelAffinity")}</th>
                    <th className="px-2 py-1 text-right font-medium">{t("mate.relPanelColChange")}</th>
                    <th className="px-2 py-1 text-right font-medium">{t("mate.relPanelStatTalks")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50 text-content-dim">
                  {[...j.series].reverse().map((p) => (
                    <tr key={p.day}>
                      <td className="px-2 py-1">{dayLabel(p.day, { month: "short", day: "numeric", weekday: "short" })}</td>
                      <td className="px-2 py-1 text-right">{p.v === null ? "–" : Math.round(p.v)}</td>
                      <td className="px-2 py-1 text-right">{[p.up ? deltaText(p.up) : "", p.down ? deltaText(p.down) : ""].filter(Boolean).join(" ") || "·"}</td>
                      <td className="px-2 py-1 text-right">{p.talks || "·"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </Card>
  );
}

function Milestones({ j }: { j: RelationJournal }) {
  const t = useT();
  const items: { key: string; at: string; text: string; color?: string }[] = [];
  if (j.stats.first_talk_at) items.push({ key: "first_talk", at: j.stats.first_talk_at, text: t("mate.relPanelFirstTalk") });
  for (const m of j.milestones) {
    const st = /^stage_(\w+)$/.exec(m.key)?.[1] as RelationStage | undefined;
    items.push({ key: m.key, at: m.at, text: milestoneText(t, m.key), color: st && st in STAGE_COLOR ? STAGE_COLOR[st] : undefined });
  }
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const next = nextAnniversary(j.anniversaries);
  return (
    <Card title={t("mate.relPanelMilestones")} testId="mate-relation-panel-milestones">
      {items.length === 0 ? (
        <p className="text-[12px] text-content-faint">{t("mate.relPanelNoChanges")}</p>
      ) : (
        <ol className="relative space-y-2 border-l border-border pl-4">
          {items.map((m) => (
            <li key={m.key} className="relative text-[12.5px]" data-testid="mate-relation-panel-milestone" data-key={m.key}>
              <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ring-4 ring-surface-2" style={{ background: m.color ?? "rgb(var(--c-content-faint))" }} />
              <span className="text-content">{m.text}</span> <span className="text-[11px] text-content-faint">· {fmtDate(m.at)}</span>
            </li>
          ))}
        </ol>
      )}
      {j.anniversaries.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-[12px] font-medium text-content-dim">{t("mate.relPanelAnniversaries")}</p>
          <ul className="flex flex-wrap gap-1.5" data-testid="mate-relation-panel-anniversaries">
            {j.anniversaries.map((a) => (
              <li
                key={a.days}
                className={`rounded-full border px-2.5 py-0.5 text-[11.5px] tabular-nums ${a.reached ? "border-transparent bg-accent-soft text-content" : next?.days === a.days ? "border-accent/50 text-content-dim" : "border-border text-content-faint"}`}
                title={dayLabel(a.day, { year: "numeric", month: "short", day: "numeric" })}
                data-reached={a.reached ? "true" : "false"}
              >
                {a.reached && <Icon name="check" size={10} className="mr-0.5 inline" />}
                {t("mateSettings.relMsDays", { days: a.days })}
              </li>
            ))}
          </ul>
          {next && (
            <p className="mt-2 text-[11.5px] text-content-dim" data-testid="mate-relation-panel-next-anniversary">
              {t("mate.relPanelAnnNext", {
                what: t("mateSettings.relMsDays", { days: next.days }),
                when: `${dayLabel(next.day)} (${next.in_days ? t("mate.relPanelAnnIn", { count: next.in_days }) : t("mate.relPanelAnnToday")})`,
              })}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function changeText(t: TFunction, c: RelationChange): string {
  if (c.why === "stage_up" && c.stage) return t("mateSettings.relMsStage", { stage: t(STAGE_LABEL[c.stage]) });
  if (c.why === "stage_now" && c.stage) return t("mate.relPanelStageNow", { stage: t(STAGE_LABEL[c.stage]) });
  return whyText(t, c.why);
}

function Changes({ changes }: { changes: RelationChange[] }) {
  const t = useT();
  const [filter, setFilter] = useState<ChangeFilter>("all");
  const [limit, setLimit] = useState(PAGE);
  const shown = useMemo(() => filterChanges(changes, filter), [changes, filter]);
  const groups = groupByDay(shown.slice(0, limit));
  const today = localDay(new Date());
  const yesterday = localDay(new Date(Date.now() - 86400000));
  return (
    <Card title={t("mate.relPanelChanges")} right={<span className="text-[11px] tabular-nums text-content-faint">{shown.length}</span>} testId="mate-relation-panel-changes">
      <div className="mb-3 flex flex-wrap gap-1" role="radiogroup" aria-label={t("mate.relPanelChanges")}>
        {CHANGE_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={filter === f}
            onClick={() => {
              setFilter(f);
              setLimit(PAGE);
            }}
            className={`rounded-full border px-2.5 py-0.5 text-[11.5px] transition ${filter === f ? "border-accent/50 bg-accent-soft text-content" : "border-border text-content-dim hover:bg-surface-3 hover:text-content"}`}
            data-testid={`mate-relation-panel-filter-${f}`}
          >
            {t(FILTER_LABEL[f])}
          </button>
        ))}
      </div>
      {groups.length === 0 ? (
        <p className="text-[12px] text-content-faint">{t("mate.relPanelNoChanges")}</p>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.day} data-testid="mate-relation-panel-day">
              <p className="mb-1 text-[11px] font-medium text-content-faint">
                {g.day === today ? t("mate.relPanelToday") : g.day === yesterday ? t("mate.relPanelYesterday") : dayLabel(g.day, { month: "short", day: "numeric", weekday: "short" })}
              </p>
              <ul className="divide-y divide-border/50 rounded-lg border border-border text-[12px]">
                {g.items.map((c, i) => (
                  <li key={`${c.at}-${c.why}-${i}`} className="flex items-center gap-2 px-2.5 py-1.5" data-testid="mate-relation-panel-change" data-kind={c.kind}>
                    <span
                      className={`w-11 shrink-0 text-right tabular-nums ${c.kind === "stage" ? "" : c.d > 0 ? "text-success" : c.d < 0 ? "text-danger" : "text-content-faint"}`}
                      style={c.kind === "stage" && c.stage ? { color: STAGE_COLOR[c.stage] } : undefined}
                    >
                      {c.kind === "stage" ? <Icon name="sparkles" size={12} className="inline" /> : deltaText(c.d)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-content-dim">{changeText(t, c)}</span>
                    {c.v !== null && <span className="shrink-0 tabular-nums text-content-faint">{Math.round(c.v)}</span>}
                    <span className="w-11 shrink-0 text-right tabular-nums text-content-faint">{fmtTime(c.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {shown.length > limit && (
            <button className="btn-ghost w-full !py-1 text-[12px]" onClick={() => setLimit((n) => n + PAGE)} data-testid="mate-relation-panel-more">
              {t("mate.relPanelShowMore", { n: shown.length - limit })}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function Memories({ j, mate, onManage }: { j: RelationJournal; mate: Mate; onManage: () => void }) {
  const t = useT();
  return (
    <Card
      title={t("mate.relPanelMemories")}
      right={
        <button type="button" onClick={onManage} className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-accent hover:underline" data-testid="mate-relation-panel-memories-manage">
          {t("mate.relPanelMemoriesManage")}
        </button>
      }
      testId="mate-relation-panel-memories"
    >
      {j.memories.length === 0 ? (
        <p className="text-[12px] text-content-faint">{t("mate.relPanelMemoriesEmpty", { name: mate.name })}</p>
      ) : (
        <ul className="space-y-1.5">
          {j.memories.map((m) => (
            <li key={m.id} className="flex items-start gap-2 text-[12.5px]" data-testid="mate-relation-panel-memory">
              <span className="mt-[1px] shrink-0 rounded-full bg-surface-3 px-1.5 py-[1px] text-[10.5px] text-content-faint">{KIND_LABEL[m.kind] ? t(KIND_LABEL[m.kind]) : m.kind}</span>
              <span className="min-w-0 flex-1 break-words text-content-dim">{m.text}</span>
              <span className="shrink-0 text-[11px] text-content-faint">{relTime(m.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
