/**
 * The other mates in her life, in the ♥ status window's 관계 tab (app/mate/social, docs/mate-social.md). Only what is: whom she
 * knows (of) and how, how she feels about each — the same numbers as with the user —, their conversations, plans and outings.
 * Opening a conversation is reading it: both of them know the user did.
 */
import { useEffect, useRef, useState } from "react";
import { getSocial, readSocialThread, type Mate, type MateSocial, type SocialEvent, type SocialMate, type SocialThread } from "../../../api/mates";
import { useLang, useT, type MsgKey } from "../../../i18n";
import { fmtDate, fmtTime } from "../../../i18n/format";
import { useMateStore } from "../../../stores/mateStore";
import HelpTip from "../../ui/HelpTip";
import Icon from "../../ui/Icon";
import { Meter } from "../gss/bits";
import { Block } from "../gss/StateView";
import { lifeName } from "../life/needs";
import { MateThumb } from "../MateStage";
import { STAGE_COLOR, STAGE_LABEL } from "../RelationRing";
import { BOND_LABEL } from "../../../mate/gss";

const MOOD: Record<string, MsgKey> = { great: "social.mood_great", good: "social.mood_good", okay: "social.mood_okay", awkward: "social.mood_awkward" };

/** her side of it, refetched whenever the server says it moved (``social`` pushes) */
function useSocialView(mate: Mate): { v: MateSocial | null; err: string | null } {
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

function Conversation({ mate, other, id, onClose }: { mate: Mate; other: SocialMate; id: string; onClose: () => void }) {
  const t = useT();
  const [c, setC] = useState<SocialThread | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rev = useMateStore((s) => s.socialRev[mate.id] ?? 0);
  useEffect(() => {
    readSocialThread(mate.id, id).then(setC, (e) => setErr((e as Error).message));
  }, [mate.id, id, rev]);
  return (
    <div className="mt-2 rounded-xl border border-content/10 bg-content/[0.03] p-2.5" data-testid="social-thread" data-thread={id}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-medium text-content">{t("social.convoWith", { name: other.name })}</span>
        <button type="button" className="btn-ghost ml-auto !px-1.5 !py-0.5 text-[11.5px]" onClick={onClose} data-testid="social-thread-close">
          <Icon name="x" size={12} />
        </button>
      </div>
      {err && <p className="text-[12px] text-danger">{err}</p>}
      {!c ? (
        !err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
      ) : (
        <ul className="space-y-1.5">
          {c.messages.map((m, i) => {
            const mine = m.by === mate.id;
            return (
              <li key={i} className={`flex ${mine ? "justify-end" : "justify-start"}`} data-by={mine ? "her" : "them"}>
                <div className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-[12.5px] leading-relaxed ${mine ? "bg-accent-soft text-content" : "bg-content/10 text-content"}`}>
                  <span className="mr-1.5 text-[10.5px] font-semibold text-content-dim">{m.name}</span>
                  {m.text}
                  <span className="ml-1.5 text-[10px] tabular-nums text-content-faint">{fmtTime(m.at)}</span>
                </div>
              </li>
            );
          })}
          {c.status === "on" && <li className="text-center text-[11px] text-content-faint">{t("social.convoGoingOn")}</li>}
        </ul>
      )}
    </div>
  );
}

function EventRow({ e, mate }: { e: SocialEvent; mate: Mate }) {
  const t = useT();
  const locale = useLang();
  const own = lifeName(e.own, locale);
  const text = lifeName(e.text, locale);
  return (
    <li className="space-y-0.5" data-testid="social-event" data-type={e.type} data-mood={e.mood ?? ""}>
      <p className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
        <span className="shrink-0 text-[11px] tabular-nums text-content-faint">{when(e.until || e.at)}</span>
        <span className="min-w-0 truncate font-medium text-content">
          {e.type === "called_off" ? t(e.by === mate.id ? "social.calledOffMine" : "social.calledOffTheirs") : lifeName(e.names, locale, e.kind ?? "")}
        </span>
        {e.mood && <span className={`pill shrink-0 ${e.mood === "awkward" ? "bg-warning/15 text-warning" : "bg-accent-soft text-accent"}`}>{t(MOOD[e.mood])}</span>}
      </p>
      {text && e.type === "outing" && <p className="text-[12px] leading-relaxed text-content-dim">{text}</p>}
      {own && (
        <p className="text-[11.5px] leading-relaxed text-content-faint" data-testid="social-event-own">
          <Icon name="eye" size={11} className="mr-1 inline align-[-1px]" />
          {t("social.onlyHer", { name: mate.name })}: {own}
        </p>
      )}
    </li>
  );
}

function OtherMate({ o, mate, v }: { o: SocialMate; mate: Mate; v: MateSocial }) {
  const t = useT();
  const locale = useLang();
  const other = useMateStore((s) => s.mates.find((m) => m.id === o.id));
  const [open, setOpen] = useState<string | null>(null);
  const f = o.feels;
  const rows: { id: string; label: string; v: number; color?: string }[] = f
    ? [
        { id: "affinity", label: t(BOND_LABEL.affinity), v: f.affinity, color: STAGE_COLOR[f.stage] },
        { id: "trust", label: t(BOND_LABEL.trust), v: f.trust },
        { id: "respect", label: t(BOND_LABEL.respect), v: f.respect },
        ...(v.romance && o.romance_fits ? [{ id: "romance", label: t(BOND_LABEL.romance), v: f.romance }] : []),
      ]
    : [];
  return (
    <li className="rounded-xl border border-content/10 p-3" data-testid="social-mate" data-mate={o.id} data-stage={f?.stage ?? ""}>
      <div className="flex items-center gap-2.5">
        {other ? <MateThumb mate={other} className="h-9 w-9 shrink-0" /> : <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-content/10"><Icon name="user" size={15} /></span>}
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13.5px] font-semibold text-content">{o.name}</span>
            {f ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-content-dim" data-testid="social-stage">
                <span className="h-2 w-2 rounded-full" style={{ background: STAGE_COLOR[f.stage] }} />
                {t(STAGE_LABEL[f.stage])}
              </span>
            ) : (
              <span className="shrink-0 text-[11.5px] text-content-faint">{t("social.knowsOf")}</span>
            )}
          </p>
          <p className="truncate text-[11.5px] text-content-faint">
            {t(o.how === "talked" ? "social.how_talked" : "social.how_told")}
            {o.note && ` · “${o.note}”`}
          </p>
        </div>
      </div>
      {rows.length > 0 && (
        <ul className="mt-2.5 space-y-1.5">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2" data-testid={`social-${r.id}`} data-value={Math.round(r.v)}>
              <span className="w-[4.75rem] shrink-0 truncate text-[12px] text-content-dim">{r.label}</span>
              <Meter ratio={Math.abs(r.v) / 100} color={r.color} label={r.label} />
              <span className="w-8 shrink-0 text-right text-[11.5px] tabular-nums text-content-dim">{Math.round(r.v)}</span>
            </li>
          ))}
        </ul>
      )}
      {o.plans.length > 0 && (
        <div className="mt-2.5 space-y-1" data-testid="social-plans">
          {o.plans.map((p) => (
            <p key={p.id} className="flex items-center gap-1.5 text-[12.5px] text-content">
              <Icon name="calendar" size={12} className="shrink-0 text-accent" />
              {p.status === "on" ? <span className="text-accent">{t("social.planOn")}</span> : <span className="tabular-nums text-content-dim">{when(p.at)}</span>}
              <span className="truncate">· {lifeName(p.names, locale, p.kind)}</span>
            </p>
          ))}
        </div>
      )}
      {o.events.length > 0 && <ul className="mt-2.5 space-y-2 border-t border-content/10 pt-2.5">{o.events.map((e) => <EventRow key={e.id} e={e} mate={mate} />)}</ul>}
      {o.threads.length > 0 && (
        <div className="mt-2.5 border-t border-content/10 pt-2.5" data-testid="social-threads">
          <p className="mb-1 flex items-center gap-1 text-[11.5px] font-medium text-content-dim">
            {t("social.convos")}
            <HelpTip>{t("social.convosHelp", { name: mate.name, other: o.name })}</HelpTip>
          </p>
          <ul className="space-y-1">
            {o.threads.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  onClick={() => setOpen(open === x.id ? null : x.id)}
                  className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-content/[0.05]"
                  aria-expanded={open === x.id}
                  data-testid="social-thread-open"
                >
                  <Icon name="chat" size={12} className="shrink-0 text-content-faint" />
                  <span className="shrink-0 text-[11px] tabular-nums text-content-faint">{when(x.last_at)}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-content-dim">{x.last}</span>
                  {x.unseen > 0 && <span className="pill shrink-0 bg-accent-soft text-accent" data-testid="social-thread-unseen">{t("social.unseen", { count: x.unseen })}</span>}
                </button>
                {open === x.id && <Conversation mate={mate} other={o} id={x.id} onClose={() => setOpen(null)} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export default function OtherMates({ mate }: { mate: Mate }) {
  const t = useT();
  const { v, err } = useSocialView(mate);
  if (err) return <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{err}</p>;
  if (!v || !v.enabled) return null;
  return (
    <Block title={t("social.title")} testId="social-others">
      {v.mates.length === 0 ? (
        <p className="text-[12.5px] text-content-faint" data-testid="social-empty">{t("social.empty", { name: mate.name })}</p>
      ) : (
        <ul className="space-y-2.5">
          {v.mates.map((o) => (
            <OtherMate key={o.id} o={o} mate={mate} v={v} />
          ))}
        </ul>
      )}
    </Block>
  );
}
