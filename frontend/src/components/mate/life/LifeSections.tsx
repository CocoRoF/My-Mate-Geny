/**
 * The pieces of her day the stage's windows are made of (docs/mate-life.md): her condition, what she did today, the map and
 * its places, the plan for her week, gifts, what she is growing in and her journal. Each reads one LifeView (useLifeView).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getLife, sendLifeGift, setLifePlan, type LifeDay, type LifeGift, type LifePlace, type LifeView, type Mate } from "../../../api/mates";
import { fmtDate, fmtTime } from "../../../i18n/format";
import { useLang, useT, type MsgKey } from "../../../i18n";
import { useMateStore } from "../../../stores/mateStore";
import Icon, { type IconName } from "../../ui/Icon";
import { lifeName, needStep, needTone, NEEDS, STATS } from "./needs";
import "./life.css";

export const SLOT_LABEL: Record<string, MsgKey> = { morning: "life.slotMorning", day: "life.slotDay", evening: "life.slotEvening", night: "life.slotNight" };
export const SKY: Record<string, { icon: IconName; label: MsgKey }> = {
  clear: { icon: "sun", label: "life.skyClear" },
  cloudy: { icon: "cloud", label: "life.skyCloudy" },
  rain: { icon: "cloud-rain", label: "life.skyRain" },
  snow: { icon: "snowflake", label: "life.skySnow" },
};

/** her day as the server has it, refetched whenever the mate document's summary of it changes (a push brings that) */
export function useLifeView(mate: Mate): { v: LifeView | null; setV: (v: LifeView) => void; err: string | null; setErr: (e: string | null) => void } {
  const [v, setV] = useState<LifeView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);
  const summary = JSON.stringify(mate.life ?? null);
  useEffect(() => {
    const n = ++seq.current;
    getLife(mate.id)
      .then((x) => {
        if (n !== seq.current) return;
        setV(x);
        setErr(null);
      })
      .catch((e) => n === seq.current && setErr((e as Error).message));
  }, [mate.id, summary]);
  return { v, setV, err, setErr };
}

export function Card({ title, right, children, testId, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; testId?: string; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/10 bg-white/[0.04] p-4 ${className}`} data-testid={testId}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="min-w-0 truncate text-[12.5px] font-semibold text-content">{title}</h3>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

/** turning her day on, for a mate who doesn't have one yet */
export function LifeOff({ mate, onOn }: { mate: Mate; onOn: (v: LifeView) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <Card testId="mate-life-off">
      <p className="text-[14px] font-semibold text-content">{t("life.offTitle")}</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-content-dim">{t("life.offBody", { name: mate.name })}</p>
      <button
        className="btn-primary mt-3 !py-1.5 text-[12.5px]"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void useMateStore
            .getState()
            .patch(mate.id, { prefs: { life: "on" } })
            .then(() => getLife(mate.id))
            .then(onOn)
            .finally(() => setBusy(false));
        }}
        data-testid="mate-life-turn-on"
      >
        {busy && <Icon name="spinner" size={13} spin />} {t("life.turnOn")}
      </button>
    </Card>
  );
}

export function NeedsList({ v }: { v: LifeView }) {
  const t = useT();
  return (
    <ul className="space-y-2.5" data-testid="life-needs">
      {NEEDS.map(({ need, icon, label, words }) => {
        const value = v.needs?.[need] ?? 0;
        return (
          <li key={need} className="flex items-center gap-2.5" data-testid={`life-need-${need}`}>
            <Icon name={icon} size={13} className="shrink-0 text-content-faint" />
            <span className="w-12 shrink-0 text-[12px] text-content-dim">{t(label)}</span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
              <span className={`block h-full rounded-full transition-[width] duration-700 ${needTone(value)}`} style={{ width: `${Math.max(4, Math.round((1 - value) * 100))}%` }} />
            </span>
            <span className="w-[6.5rem] shrink-0 truncate text-right text-[11.5px] text-content-dim">{t(words[needStep(value)])}</span>
          </li>
        );
      })}
    </ul>
  );
}

const SAY: MsgKey[] = ["life.sayMeal", "life.sayPlay", "life.sayRest", "life.sayHow"];

export function SayChips({ onSay }: { onSay: (text: string) => void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="life-say">
      {SAY.map((k) => (
        <button key={k} type="button" className="btn-soft !px-2.5 !py-1 text-[12px]" onClick={() => onSay(t(k))} data-testid={`life-say-${k.slice(8).toLowerCase()}`}>
          {t(k)}
        </button>
      ))}
    </div>
  );
}

export function TodayList({ v }: { v: LifeView }) {
  const t = useT();
  const locale = useLang();
  if (!v.today?.length) return <p className="text-[12px] text-content-faint">{t("life.todayEmpty")}</p>;
  return (
    <ol className="space-y-1.5" data-testid="life-today">
      {[...v.today].reverse().filter((e) => e.activity !== "commute").slice(0, 10).map((e) => (
        <li key={e.from} className="flex items-baseline gap-2 text-[12px]">
          <span className="w-[3.4rem] shrink-0 tabular-nums text-content-faint">{fmtTime(e.from)}</span>
          <span className="min-w-0 flex-1 truncate text-content-dim">{lifeName(e.name, locale, e.activity)}</span>
          <span className="max-w-[40%] shrink-0 truncate text-[11px] text-content-faint">{lifeName(e.place_name, locale)}</span>
        </li>
      ))}
    </ol>
  );
}

/** her neighbourhood: a tap on a pin chooses that place */
export function MapView({ v, picked, onPick }: { v: LifeView; picked: string | null; onPick: (key: string) => void }) {
  const locale = useLang();
  const places = (v.places ?? []).filter((p) => p.key !== "street" && p.x != null && p.y != null);
  if (!v.map) return null;
  return (
    <section className="relative overflow-hidden rounded-2xl border border-white/10" data-testid="life-map">
      <img src={v.map} alt="" className="block w-full" draggable={false} />
      {places.map((p) => (
        <button
          type="button"
          key={p.key}
          onClick={() => onPick(p.key)}
          className={`absolute flex -translate-x-1/2 -translate-y-full items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-medium shadow-float transition-transform hover:scale-105 ${
            p.key === picked ? "bg-violet text-white ring-2 ring-white/70" : p.here ? "bg-accent text-white" : p.open ? "bg-surface-2/95 text-content" : "bg-surface-2/90 text-content-dim"
          }`}
          style={{ left: `${p.x}%`, top: `${p.y}%` }}
          aria-pressed={p.key === picked}
          data-testid={`life-pin-${p.key}`}
          data-here={p.here || undefined}
        >
          {p.here && <Icon name="map-pin" size={9} />}
          {lifeName(p.name, locale, p.key)}
        </button>
      ))}
    </section>
  );
}

export function PlaceDetail({ p, withUser, onSay }: { p: LifePlace; withUser?: boolean; onSay?: (text: string) => void }) {
  const t = useT();
  const locale = useLang();
  const name = lifeName(p.name, locale, p.key);
  return (
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]" data-testid={`life-place-detail-${p.key}`}>
      <div className="relative">
        {p.art && <img src={p.art} alt="" className={`block aspect-[16/8] w-full object-cover ${p.open ? "" : "opacity-50 grayscale"}`} draggable={false} />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
        <div className="absolute inset-x-3 bottom-2.5 text-white">
          <p className="truncate text-[15px] font-semibold">{name}</p>
          <p className="truncate text-[12px] opacity-85">
            {p.here ? t("life.open_") : p.open ? t("life.minutes", { n: p.minutes }) : t("life.closed")}
            {p.hours ? ` · ${p.hours[0]}–${p.hours[1]}` : ""}
          </p>
        </div>
      </div>
      {onSay && !p.here && (
        <div className="p-3">
          <button
            type="button"
            className="btn-primary w-full !py-2 text-[13px]"
            disabled={!p.open}
            onClick={() => onSay(t(withUser ? "life.inviteTogether" : "life.invite", { place: name }))}
            data-testid={`life-invite-${p.key}`}
          >
            <Icon name="map-pin" size={13} /> {p.open ? t("life.inviteButton") : t("life.closed")}
          </button>
          <p className="mt-2 text-center text-[11px] text-content-faint">{t("life.mapNote")}</p>
        </div>
      )}
    </section>
  );
}

export function PlaceGrid({ v, picked, onPick }: { v: LifeView; picked: string | null; onPick: (key: string) => void }) {
  const t = useT();
  const locale = useLang();
  return (
    <ul className="grid grid-cols-2 gap-2 min-[520px]:grid-cols-3" data-testid="life-places">
      {(v.places ?? []).filter((p) => p.key !== "street").map((p) => (
        <li key={p.key}>
          <button
            type="button"
            onClick={() => onPick(p.key)}
            className={`block w-full overflow-hidden rounded-xl border text-left transition ${p.key === picked ? "border-violet ring-1 ring-violet/60" : p.here ? "border-accent" : "border-white/10"} bg-white/[0.04]`}
            aria-pressed={p.key === picked}
            data-testid={`life-place-${p.key}`}
          >
            <span className="relative block">
              {p.art && <img src={p.art} alt="" loading="lazy" className={`block aspect-video w-full object-cover ${p.open ? "" : "opacity-50 grayscale"}`} draggable={false} />}
              {p.here && (
                <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white">
                  <Icon name="map-pin" size={9} />
                  {t("life.here")}
                </span>
              )}
            </span>
            <span className="block px-2.5 py-1.5">
              <span className="block truncate text-[12px] font-medium text-content">{lifeName(p.name, locale, p.key)}</span>
              <span className="block truncate text-[10.5px] text-content-faint">{p.open ? (p.here ? t("life.open_") : t("life.minutes", { n: p.minutes })) : t("life.closed")}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const DAY_LABEL: Record<string, MsgKey> = { mon: "life.dayMon", tue: "life.dayTue", wed: "life.dayWed", thu: "life.dayThu", fri: "life.dayFri", sat: "life.daySat", sun: "life.daySun" };

export function PlanSection({ v, mate, onChange, onError }: { v: LifeView; mate: Mate; onChange: (v: LifeView) => void; onError: (e: string | null) => void }) {
  const t = useT();
  const locale = useLang();
  const [busy, setBusy] = useState<string | null>(null);
  const plan = v.plan;
  if (!plan) return null;
  const choose = async (slot: string, activity: string) => {
    setBusy(slot);
    try {
      onChange(await setLifePlan(mate.id, slot, activity || null));
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <p className="px-1 text-[12.5px] leading-relaxed text-content-dim">{t("life.planNote", { name: mate.name })}</p>
      <Card testId="life-plan">
        <ul className="space-y-2">
          {plan.slots.map((slot) => {
            const [day, part] = slot.split("_");
            const label = `${t(DAY_LABEL[day])} ${t(part === "day" ? "life.slotDay" : "life.slotEvening")}`;
            return (
              <li key={slot} className="flex items-center gap-2.5" data-testid={`life-plan-${slot}`} data-now={plan.now === slot || undefined}>
                <span className={`w-[4.6rem] shrink-0 text-[12px] ${plan.now === slot ? "font-semibold text-accent" : "text-content-dim"}`}>{label}</span>
                <select
                  className="field min-w-0 flex-1 !py-1 text-[12.5px]"
                  value={plan.week[slot] ?? ""}
                  disabled={busy !== null}
                  aria-label={label}
                  onChange={(e) => void choose(slot, e.target.value)}
                  data-testid={`life-plan-select-${slot}`}
                >
                  <option value="">{t("life.planFree")}</option>
                  {plan.choices.map((c) => (
                    <option key={c.id} value={c.id}>{lifeName(c.name, locale, c.id)}</option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}

export function JournalSection({ v }: { v: LifeView }) {
  const t = useT();
  const locale = useLang();
  return (
    <>
      {!!v.happened?.length && (
        <Card title={t("life.happened")} testId="life-happened">
          <ul className="space-y-1.5">
            {v.happened.slice(0, 6).map((e) => (
              <li key={e.at} className="flex items-baseline gap-2 text-[12px]">
                <span className="w-[3.2rem] shrink-0 tabular-nums text-content-faint">{fmtDate(e.at, { month: "numeric", day: "numeric" })}</span>
                <span className="min-w-0 flex-1 text-content-dim">{lifeName(e.title, locale)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {!v.journal?.length ? (
        <Card testId="life-journal-empty">
          <p className="text-[12.5px] text-content-faint">{t("life.journalEmpty")}</p>
        </Card>
      ) : (
        v.journal.map((d) => <DayCard key={d.day} d={d} />)
      )}
    </>
  );
}

function DayCard({ d }: { d: LifeDay }) {
  const t = useT();
  const locale = useLang();
  const grown = STATS.filter(({ stat }) => (d.grown?.[stat] ?? 0) > 0);
  return (
    <Card title={fmtDate(`${d.day}T12:00:00`, { month: "long", day: "numeric", weekday: "short" })} testId={`life-day-${d.day}`}>
      {d.diary && <p className="mb-2.5 whitespace-pre-wrap rounded-lg bg-white/[0.05] px-3 py-2 text-[12.5px] italic leading-relaxed text-content" data-testid="life-diary">{d.diary}</p>}
      {!!d.titles.length && (
        <ul className="mb-2.5 space-y-1">
          {d.titles.map((title, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[12.5px] text-content">
              <Icon name="sparkles" size={12} className="mt-[3px] shrink-0 text-violet" />
              <span className="min-w-0">{lifeName(title, locale)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(d.hours).filter(([k]) => k !== "commute").map(([k, h]) => (
          <span key={k} className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-content-dim">
            {lifeName(d.names[k], locale, k)} {t("life.hours", { n: h })}
          </span>
        ))}
      </div>
      {!!grown.length && <p className="mt-2 text-[11.5px] text-content-faint">{grown.map(({ stat, label }) => `${t(label)} +${d.grown[stat]}`).join(" · ")}</p>}
    </Card>
  );
}

export function GiftsSection({ v, mate, onChange, onError }: { v: LifeView; mate: Mate; onChange: (v: LifeView) => void; onError: (e: string | null) => void }) {
  const t = useT();
  const locale = useLang();
  const [sending, setSending] = useState<string | null>(null);
  const send = async (g: LifeGift) => {
    setSending(g.id);
    try {
      onChange(await sendLifeGift(mate.id, g.id));
      onError(null);
      void useMateStore.getState().load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSending(null);
    }
  };
  return (
    <>
      <Card testId="life-coins">
        <div className="flex items-center gap-2 text-[12.5px]">
          <Icon name="wallet" size={14} className="text-content-faint" />
          <span className="flex-1 text-content-dim">{t("life.coinsNote", { name: mate.name })}</span>
          <span className="shrink-0 font-semibold tabular-nums text-content" data-testid="life-coins-n">{t("life.coins", { n: (v.coins ?? 0).toLocaleString() })}</span>
        </div>
      </Card>
      <ul className="space-y-2" data-testid="life-shop">
        {(v.shop ?? []).map((g) => (
          <li key={g.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5" data-testid={`life-gift-${g.id}`}>
            <Icon name={g.kind === "food" ? "utensils" : "gift"} size={15} className="shrink-0 text-content-faint" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] font-medium text-content">{lifeName(g.name, locale, g.id)}</p>
              <p className="text-[11.5px] leading-snug text-content-faint">{lifeName(g.about, locale)}</p>
            </div>
            <button
              type="button"
              className="btn-soft shrink-0 !px-2.5 !py-1 text-[12px]"
              disabled={sending !== null || (v.coins ?? 0) < g.price || (g.keep && g.have)}
              onClick={() => void send(g)}
              data-testid={`life-send-${g.id}`}
            >
              {sending === g.id ? <Icon name="spinner" size={12} spin /> : g.keep && g.have ? t("life.haveIt") : t("life.coins", { n: g.price.toLocaleString() })}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function GrowthSection({ v }: { v: LifeView }) {
  const t = useT();
  return (
    <>
      <Card title={t("life.growthTitle")} testId="life-stats">
        <ul className="space-y-2.5">
          {STATS.map(({ stat, icon, label }) => {
            const value = v.stats?.[stat] ?? 0;
            return (
              <li key={stat} className="flex items-center gap-2.5" data-testid={`life-stat-${stat}`}>
                <Icon name={icon} size={13} className="shrink-0 text-content-faint" />
                <span className="w-12 shrink-0 text-[12px] text-content-dim">{t(label)}</span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
                  <span className="block h-full rounded-full bg-violet" style={{ width: `${Math.round(value)}%` }} />
                </span>
                <span className="w-8 shrink-0 text-right text-[11.5px] tabular-nums text-content-dim">{Math.floor(value)}</span>
              </li>
            );
          })}
        </ul>
      </Card>
      <Card testId="life-money">
        <div className="flex items-center gap-2 text-[12.5px]">
          <Icon name="wallet" size={14} className="text-content-faint" />
          <span className="flex-1 text-content-dim">{t("life.money")}</span>
          <span className="font-semibold tabular-nums text-content">{t("life.won", { n: (v.money ?? 0).toLocaleString() })}</span>
        </div>
      </Card>
    </>
  );
}
