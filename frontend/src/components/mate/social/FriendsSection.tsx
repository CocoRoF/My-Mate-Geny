/**
 * 인맥 — her friends among the user's mates, in the ♥ status window (stage/StatusWindow.tsx; app/mate/social,
 * docs/mate-social.md). Only what is: who she knows and how they met, how fond each is of the other and how close they are,
 * the plans they have, and what they did together (what both remember, and what only she knows). Whether mates hang out at
 * all is a shared mate setting.
 */
import { useEffect, useRef, useState } from "react";
import { getSocial, type Mate, type MateSocial, type SocialEvent, type SocialStage, type SocialTie } from "../../../api/mates";
import { useLang, useT, type MsgKey } from "../../../i18n";
import { fmtDate, fmtTime } from "../../../i18n/format";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { Meter } from "../gss/bits";
import { Card } from "../life/LifeSections";
import { lifeName } from "../life/needs";
import { MateThumb } from "../MateStage";

const STAGE: Record<SocialStage, MsgKey> = {
  awkward: "social.stage_awkward",
  acquainted: "social.stage_acquainted",
  friend: "social.stage_friend",
  close: "social.stage_close",
  best: "social.stage_best",
};
const STAGE_COLOR: Record<SocialStage, string> = { awkward: "#9aa3b5", acquainted: "#7ea6e0", friend: "#5fb39a", close: "#e0a04e", best: "#e06b8a" };
const MOOD: Record<string, MsgKey> = { great: "social.mood_great", good: "social.mood_good", okay: "social.mood_okay", awkward: "social.mood_awkward" };
const SPARK: Record<string, MsgKey> = { crush: "social.spark_crush", mutual: "social.spark_mutual", theirs: "social.spark_theirs" };

/** her side of it, refetched whenever the server says it moved (``social`` pushes) */
export function useSocialView(mate: Mate): { v: MateSocial | null; err: string | null } {
  const [v, setV] = useState<MateSocial | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rev = useMateStore((s) => s.socialRev[mate.id] ?? 0);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    getSocial(mate.id)
      .then((x) => n === seq.current && (setV(x), setErr(null)))
      .catch((e) => n === seq.current && setErr((e as Error).message));
  }, [mate.id, rev]);
  return { v, err };
}

/** today: the time; this week: the weekday and the time; else the date */
function when(at: string): string {
  const d = new Date(at);
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
  if (days === 0) return fmtTime(d);
  return `${fmtDate(d, Math.abs(days) < 6 ? { weekday: "short" } : { month: "short", day: "numeric" })} ${fmtTime(d)}`;
}

function eventTitle(t: ReturnType<typeof useT>, e: SocialEvent, locale: string, me: string): string {
  const name = e.with_name;
  switch (e.type) {
    case "met":
      return t("social.ev_met", { name });
    case "introduced":
      return t("social.ev_introduced", { name });
    case "message":
      return t("social.ev_message", { name });
    case "called_off":
      return t(e.by === me ? "social.ev_calledOffMine" : "social.ev_calledOffTheirs", { name });
    default:
      return lifeName(e.names, locale, e.kind ?? "");
  }
}

function EventRow({ e, mate }: { e: SocialEvent; mate: Mate }) {
  const t = useT();
  const locale = useLang();
  const text = lifeName(e.text, locale);
  const own = lifeName(e.own, locale);
  const why = e.type === "called_off" && e.why ? t(e.why === "asleep" ? "social.why_asleep" : "social.why_with_user") : "";
  return (
    <li className="space-y-0.5" data-testid="social-event" data-type={e.type} data-mood={e.mood ?? ""}>
      <p className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
        <span className="shrink-0 text-[11px] tabular-nums text-content-faint">{when(e.until || e.at)}</span>
        <span className="min-w-0 truncate font-medium text-content">{eventTitle(t, e, locale, mate.id)}</span>
        {e.mood && <span className={`pill shrink-0 ${e.mood === "awkward" ? "bg-warning/15 text-warning" : "bg-accent-soft text-accent"}`}>{t(MOOD[e.mood])}</span>}
        {e.spark && <span className="pill shrink-0 bg-pink/15 text-pink">{t("social.sparkMoment")}</span>}
        {why && <span className="shrink-0 text-[11px] text-content-faint">· {why}</span>}
      </p>
      {text && e.type !== "called_off" && <p className="text-[12px] leading-relaxed text-content-dim">{text}</p>}
      {own && (
        <p className="text-[11.5px] leading-relaxed text-content-faint" data-testid="social-event-own">
          <Icon name="eye" size={11} className="mr-1 inline align-[-1px]" />
          {t("social.onlyHer", { name: mate.name })}: {own}
        </p>
      )}
      {e.note && <p className="text-[11.5px] text-content-faint">“{e.note}”</p>}
    </li>
  );
}

function TieCard({ tie, mate, v }: { tie: SocialTie; mate: Mate; v: MateSocial }) {
  const t = useT();
  const locale = useLang();
  const other = useMateStore((s) => s.mates.find((m) => m.id === tie.id));
  const plans = v.plans.filter((p) => p.with === tie.id);
  const events = v.events.filter((e) => e.with === tie.id && e.type !== "introduced" && e.type !== "met").slice(0, 3);
  const how = tie.how === "met" ? t("social.how_met", { date: fmtDate(tie.since, { month: "short", day: "numeric" }) }) : t(tie.how === "builtin" ? "social.how_builtin" : "social.how_introduced");
  const story = tie.how === "introduced" ? "" : lifeName(tie.story, locale);
  return (
    <Card testId="social-tie">
      <div className="flex items-start gap-3" data-tie={tie.id} data-stage={tie.stage}>
        {other ? <MateThumb mate={other} className="h-10 w-10 shrink-0" /> : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-content/10"><Icon name="user" size={16} /></span>}
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold text-content">{tie.name}</span>
            <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-content-dim" data-testid="social-stage">
              <span className="h-2 w-2 rounded-full" style={{ background: STAGE_COLOR[tie.stage] }} />
              {t(STAGE[tie.stage])}
            </span>
            {tie.spark !== "none" && <span className="pill shrink-0 bg-pink/15 text-pink" data-testid="social-spark">{t(SPARK[tie.spark])}</span>}
          </p>
          <p className="truncate text-[11.5px] text-content-faint">
            {how}
            {tie.together > 0 && <> · {t("social.together", { count: tie.together })}</>}
          </p>
        </div>
      </div>
      <ul className="mt-3 space-y-1.5">
        {[
          { id: "fond", label: t("social.fond"), v: tie.fond },
          { id: "back", label: t("social.fondBack"), v: tie.fond_back },
          { id: "close", label: t("social.close"), v: tie.close },
        ].map((r) => (
          <li key={r.id} className="flex items-center gap-2" data-testid={`social-${r.id}`} data-value={Math.round(r.v)}>
            <span className="w-[4.75rem] shrink-0 truncate text-[12px] text-content-dim">{r.label}</span>
            <Meter ratio={r.v / 100} color={r.id === "close" ? STAGE_COLOR[tie.stage] : undefined} label={r.label} />
            <span className="w-7 shrink-0 text-right text-[11.5px] tabular-nums text-content-dim">{Math.round(r.v)}</span>
          </li>
        ))}
      </ul>
      {story && <p className="mt-2.5 text-[12px] leading-relaxed text-content-dim">{story}</p>}
      {plans.length > 0 && (
        <div className="mt-2.5 space-y-1" data-testid="social-plans">
          {plans.map((p) => (
            <p key={p.id} className="flex items-center gap-1.5 text-[12.5px] text-content">
              <Icon name="calendar" size={12} className="shrink-0 text-accent" />
              {p.status === "on" ? <span className="text-accent">{t("social.planOn")}</span> : <span className="tabular-nums text-content-dim">{when(p.at)}</span>}
              <span className="truncate">· {lifeName(p.names, locale, p.kind)}</span>
            </p>
          ))}
        </div>
      )}
      {events.length > 0 && <ul className="mt-2.5 space-y-2 border-t border-content/10 pt-2.5">{events.map((e) => <EventRow key={e.id} e={e} mate={mate} />)}</ul>}
    </Card>
  );
}

export default function FriendsSection({ mate }: { mate: Mate }) {
  const t = useT();
  const { v, err } = useSocialView(mate);
  if (err) return <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{err}</p>;
  if (!v) return <p className="text-[12px] text-content-faint">{t("common.loading")}</p>;
  if (!v.enabled) return <p className="text-[12.5px] text-content-faint" data-testid="social-off">{t("social.off")}</p>;
  const meetings = v.events.filter((e) => e.type === "met" || e.type === "introduced").slice(0, 3);
  return (
    <div className="space-y-3" data-testid="social-friends">
      {v.ties.length === 0 ? (
        <Card testId="social-empty">
          <p className="text-[13px] text-content">{t("social.empty", { name: mate.name })}</p>
          <p className="mt-1 text-[12px] text-content-faint">{t("social.emptyHint")}</p>
        </Card>
      ) : (
        v.ties.map((tie) => <TieCard key={tie.id} tie={tie} mate={mate} v={v} />)
      )}
      {meetings.length > 0 && (
        <Card title={t("social.recent")}>
          <ul className="space-y-2">{meetings.map((e) => <EventRow key={e.id} e={e} mate={mate} />)}</ul>
        </Card>
      )}
    </div>
  );
}
