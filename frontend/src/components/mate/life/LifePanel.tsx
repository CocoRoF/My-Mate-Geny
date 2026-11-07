/**
 * The Life panel (docs/mate-life.md): her own day. Now: where she is, what she is doing, how she is, what she did today.
 * Map: her neighbourhood; asking her along is a message like any other, and she decides. Gifts: something sent to her.
 * Plan: how they suggest she spends the week (she mostly goes along). Growth: what she is getting better at. Journal: her days.
 * It follows the server's pushes (mates.changed → the store).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getLife, sendLifeGift, setLifePlan, type LifeDay, type LifeGift, type LifePlace, type LifeView, type Mate } from "../../../api/mates";
import { fmtDate, fmtTime } from "../../../i18n/format";
import { useLang, useT, type MsgKey } from "../../../i18n";
import { useMateStore } from "../../../stores/mateStore";
import Icon, { type IconName } from "../../ui/Icon";
import { lifeName, needStep, needTone, NEEDS, STATS } from "./needs";
import "./life.css";

type Tab = "now" | "map" | "plan" | "gifts" | "growth" | "journal";
const TABS: { id: Tab; icon: IconName; label: MsgKey }[] = [
  { id: "now", icon: "clock", label: "life.tabNow" },
  { id: "map", icon: "map", label: "life.tabMap" },
  { id: "plan", icon: "calendar", label: "life.tabPlan" },
  { id: "gifts", icon: "gift", label: "life.tabGifts" },
  { id: "growth", icon: "trending-up", label: "life.tabGrowth" },
  { id: "journal", icon: "book", label: "life.tabJournal" },
];
const SLOT_LABEL: Record<string, MsgKey> = { morning: "life.slotMorning", day: "life.slotDay", evening: "life.slotEvening", night: "life.slotNight" };
const SKY: Record<string, { icon: IconName; label: MsgKey }> = {
  clear: { icon: "sun", label: "life.skyClear" },
  cloudy: { icon: "cloud", label: "life.skyCloudy" },
  rain: { icon: "cloud-rain", label: "life.skyRain" },
  snow: { icon: "snowflake", label: "life.skySnow" },
};

export default function LifePanel({ mate, onClose, onSay }: { mate: Mate; onClose: () => void; onSay?: (text: string) => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("now");
  const [v, setV] = useState<LifeView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo(0, 0);
  }, [tab]);
  // what moves it: the mate document changing (a push about her day comes through the store)
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

  const setOn = async (on: boolean) => {
    setBusy(true);
    try {
      await useMateStore.getState().patch(mate.id, { prefs: { life: on ? "on" : "off" } });
      setV(await getLife(mate.id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="mate-life-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon name="map-pin" size={15} className="text-content-faint" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold">{t("life.title", { name: mate.name })}</h2>
          <p className="truncate text-[11px] text-content-faint">{t("life.sub")}</p>
        </div>
        <button onClick={onClose} className="btn-ghost !px-2" aria-label={t("common.close")} data-testid="mate-life-panel-close">
          <Icon name="x" size={16} />
        </button>
      </div>
      {v?.enabled && (
        <div className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 py-2" role="tablist" aria-label={t("life.open")}>
          {TABS.map(({ id, icon, label }) => (
            <button type="button" role="tab" key={id} aria-selected={tab === id} className={`shrink-0 ${tab === id ? "btn-soft" : "btn-ghost"}`} data-testid={`life-tab-${id}`} onClick={() => setTab(id)}>
              <Icon name={icon} size={14} />
              {t(label)}
            </button>
          ))}
        </div>
      )}
      <div ref={body} className="fit-fields min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-safe">
        <div className="mx-auto max-w-xl space-y-4 pb-6">
          {err && <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{t("life.error", { error: err })}</p>}
          {!v ? (
            !err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
          ) : !v.enabled ? (
            <Card testId="mate-life-off">
              <p className="text-[14px] font-semibold text-content">{t("life.offTitle")}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-content-dim">{t("life.offBody", { name: mate.name })}</p>
              <button className="btn-primary mt-3 !py-1.5 text-[12.5px]" disabled={busy} onClick={() => void setOn(true)} data-testid="mate-life-turn-on">
                {busy && <Icon name="spinner" size={13} spin />} {t("life.turnOn")}
              </button>
            </Card>
          ) : tab === "now" ? (
            <NowTab v={v} name={mate.name} onSay={onSay} />
          ) : tab === "map" ? (
            <MapTab v={v} onSay={onSay} />
          ) : tab === "plan" ? (
            <PlanTab v={v} mate={mate} onChange={setV} onError={setErr} />
          ) : tab === "journal" ? (
            <JournalTab v={v} />
          ) : tab === "gifts" ? (
            <GiftsTab v={v} mate={mate} onChange={setV} onError={setErr} />
          ) : (
            <GrowthTab v={v} />
          )}
          {v?.enabled && (
            <button className="btn-ghost mx-auto !py-1 text-[11.5px] text-content-faint" disabled={busy} onClick={() => void setOn(false)} data-testid="mate-life-turn-off">
              {t("life.turnOff")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ title, right, children, testId }: { title?: ReactNode; right?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="rounded-2xl border border-border bg-surface-1 p-4" data-testid={testId}>
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

const SAY: MsgKey[] = ["life.sayMeal", "life.sayPlay", "life.sayRest", "life.sayHow"];

function NowTab({ v, name, onSay }: { v: LifeView; name: string; onSay?: (text: string) => void }) {
  const t = useT();
  const locale = useLang();
  const sky = SKY[v.weather ?? "clear"];
  return (
    <>
      <section className="relative overflow-hidden rounded-2xl border border-border" data-testid="life-now-card">
        {v.art && <img src={v.art} alt="" className="block aspect-[16/8] w-full object-cover" draggable={false} />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
        <div className="absolute inset-x-3 bottom-2.5 text-white">
          <p className="truncate text-[15px] font-semibold" data-testid="life-now-place">{lifeName(v.place_name, locale, v.place)}</p>
          <p className="truncate text-[12.5px] opacity-90" data-testid="life-now-activity">{lifeName(v.activity_name, locale)}</p>
        </div>
        <div className="life-chip absolute right-2.5 top-2.5 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]">
          <span>{t(SLOT_LABEL[v.slot ?? "day"])}</span>
          <Icon name={sky.icon} size={12} />
          <span>{t(sky.label)}</span>
        </div>
        {v.with_user && (
          <div className="life-chip absolute left-2.5 top-2.5 flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px]" data-testid="life-together">
            <Icon name="heart" size={11} />
            {t("life.together")}
          </div>
        )}
      </section>
      {v.next && (
        <p className="px-1 text-[12px] text-content-dim" data-testid="life-next">
          {t("life.next", { time: fmtTime(v.next.at), what: lifeName(v.next.name, locale) })}
        </p>
      )}
      <Card title={t("life.howShe", { name })} testId="life-needs">
        <ul className="space-y-2.5">
          {NEEDS.map(({ need, icon, label, words }) => {
            const value = v.needs?.[need] ?? 0;
            return (
              <li key={need} className="flex items-center gap-2.5" data-testid={`life-need-${need}`}>
                <Icon name={icon} size={13} className="shrink-0 text-content-faint" />
                <span className="w-12 shrink-0 text-[12px] text-content-dim">{t(label)}</span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
                  <span className={`block h-full rounded-full transition-[width] duration-700 ${needTone(value)}`} style={{ width: `${Math.max(4, Math.round((1 - value) * 100))}%` }} />
                </span>
                <span className="w-[6.5rem] shrink-0 truncate text-right text-[11.5px] text-content-dim">{t(words[needStep(value)])}</span>
              </li>
            );
          })}
        </ul>
      </Card>
      {onSay && (
        <div className="flex flex-wrap gap-1.5" data-testid="life-say">
          {SAY.map((k) => (
            <button key={k} type="button" className="btn-soft !px-2.5 !py-1 text-[12px]" onClick={() => onSay(t(k))} data-testid={`life-say-${k.slice(8).toLowerCase()}`}>
              {t(k)}
            </button>
          ))}
        </div>
      )}
      <Card title={t("life.today")} testId="life-today">
        {!v.today?.length ? (
          <p className="text-[12px] text-content-faint">{t("life.todayEmpty")}</p>
        ) : (
          <ol className="space-y-1.5">
            {[...v.today].reverse().filter((e) => e.activity !== "commute").slice(0, 12).map((e) => (
              <li key={e.from} className="flex items-baseline gap-2 text-[12px]">
                <span className="w-[5.4rem] shrink-0 tabular-nums text-content-faint">{fmtTime(e.from)}</span>
                <span className="min-w-0 flex-1 truncate text-content-dim">{lifeName(e.name, locale, e.activity)}</span>
                <span className="max-w-[40%] shrink-0 truncate text-[11px] text-content-faint">{lifeName(e.place_name, locale)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}

function MapTab({ v, onSay }: { v: LifeView; onSay?: (text: string) => void }) {
  const t = useT();
  const locale = useLang();
  const places = (v.places ?? []).filter((p) => p.key !== "street");
  return (
    <>
      {v.map && (
        <section className="relative overflow-hidden rounded-2xl border border-border" data-testid="life-map">
          <img src={v.map} alt="" className="block w-full" draggable={false} />
          {places.filter((p) => p.x != null && p.y != null).map((p) => (
            <span
              key={p.key}
              className={`absolute flex -translate-x-1/2 -translate-y-full items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium shadow-float ${
                p.here ? "bg-accent text-white" : p.open ? "bg-surface-2/95 text-content" : "bg-surface-2/90 text-content-dim"
              }`}
              style={{ left: `${p.x}%`, top: `${p.y}%` }}
              data-testid={`life-pin-${p.key}`}
              data-here={p.here || undefined}
            >
              {p.here && <Icon name="map-pin" size={9} />}
              {lifeName(p.name, locale, p.key)}
            </span>
          ))}
        </section>
      )}
      <ul className="grid grid-cols-2 gap-2.5" data-testid="life-places">
        {places.map((p) => (
          <PlaceCard key={p.key} p={p} onSay={onSay} />
        ))}
      </ul>
      <p className="px-1 text-[11.5px] leading-relaxed text-content-faint">{t("life.mapNote")}</p>
    </>
  );
}

function PlaceCard({ p, onSay }: { p: LifePlace; onSay?: (text: string) => void }) {
  const t = useT();
  const locale = useLang();
  const name = lifeName(p.name, locale, p.key);
  return (
    <li className={`overflow-hidden rounded-xl border ${p.here ? "border-accent" : "border-border"} bg-surface-1`} data-testid={`life-place-${p.key}`}>
      <div className="relative">
        {p.art && <img src={p.art} alt="" loading="lazy" className={`block aspect-video w-full object-cover ${p.open ? "" : "opacity-50 grayscale"}`} draggable={false} />}
        {p.here && (
          <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white">
            <Icon name="map-pin" size={9} />
            {t("life.here")}
          </span>
        )}
      </div>
      <div className="px-2.5 py-2">
        <p className="truncate text-[12.5px] font-medium text-content">{lifeName(p.name, locale, p.key)}</p>
        <p className="truncate text-[11px] text-content-faint">
          {p.open ? (p.here ? t("life.open_") : t("life.minutes", { n: p.minutes })) : t("life.closed")}
        </p>
        {onSay && !p.here && p.open && (
          <button type="button" className="btn-soft mt-1.5 w-full !px-2 !py-1 text-[11.5px]" onClick={() => onSay(t("life.invite", { place: name }))} data-testid={`life-invite-${p.key}`}>
            {t("life.inviteButton")}
          </button>
        )}
      </div>
    </li>
  );
}

const DAY_LABEL: Record<string, MsgKey> = { mon: "life.dayMon", tue: "life.dayTue", wed: "life.dayWed", thu: "life.dayThu", fri: "life.dayFri", sat: "life.daySat", sun: "life.daySun" };

function PlanTab({ v, mate, onChange, onError }: { v: LifeView; mate: Mate; onChange: (v: LifeView) => void; onError: (e: string | null) => void }) {
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
            return (
              <li key={slot} className="flex items-center gap-2.5" data-testid={`life-plan-${slot}`} data-now={plan.now === slot || undefined}>
                <span className={`w-[4.6rem] shrink-0 text-[12px] ${plan.now === slot ? "font-semibold text-accent" : "text-content-dim"}`}>
                  {t(DAY_LABEL[day])} {t(part === "day" ? "life.slotDay" : "life.slotEvening")}
                </span>
                <select
                  className="field min-w-0 flex-1 !py-1 text-[12.5px]"
                  value={plan.week[slot] ?? ""}
                  disabled={busy !== null}
                  aria-label={`${t(DAY_LABEL[day])} ${t(part === "day" ? "life.slotDay" : "life.slotEvening")}`}
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

function JournalTab({ v }: { v: LifeView }) {
  const t = useT();
  return (
    <>
      {!!v.happened?.length && <Happened v={v} />}
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

function Happened({ v }: { v: LifeView }) {
  const t = useT();
  const locale = useLang();
  return (
    <Card title={t("life.happened")} testId="life-happened">
      <ul className="space-y-1.5">
        {(v.happened ?? []).slice(0, 6).map((e) => (
          <li key={e.at} className="flex items-baseline gap-2 text-[12px]">
            <span className="w-[3.2rem] shrink-0 tabular-nums text-content-faint">{fmtDate(e.at, { month: "numeric", day: "numeric" })}</span>
            <span className="min-w-0 flex-1 text-content-dim">{lifeName(e.title, locale)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DayCard({ d }: { d: LifeDay }) {
  const t = useT();
  const locale = useLang();
  const grown = STATS.filter(({ stat }) => (d.grown?.[stat] ?? 0) > 0);
  return (
    <Card title={fmtDate(`${d.day}T12:00:00`, { month: "long", day: "numeric", weekday: "short" })} testId={`life-day-${d.day}`}>
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
          <span key={k} className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-content-dim">
            {lifeName(d.names[k], locale, k)} {t("life.hours", { n: h })}
          </span>
        ))}
      </div>
      {!!grown.length && (
        <p className="mt-2 text-[11.5px] text-content-faint">
          {grown.map(({ stat, label }) => `${t(label)} +${d.grown[stat]}`).join(" · ")}
        </p>
      )}
    </Card>
  );
}

function GiftsTab({ v, mate, onChange, onError }: { v: LifeView; mate: Mate; onChange: (v: LifeView) => void; onError: (e: string | null) => void }) {
  const t = useT();
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
  const locale = useLang();
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
          <li key={g.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface-1 px-3 py-2.5" data-testid={`life-gift-${g.id}`}>
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

function GrowthTab({ v }: { v: LifeView }) {
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
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
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
