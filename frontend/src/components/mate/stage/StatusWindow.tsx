/** Status (메이트 상태) — only what is, never settings: how close you are and every feeling she has now with what is still
 * with her, where she is and how she is (what today is, a gift she just gave); where you two are — the relationship in
 * full, what she is to you and the promises both ways (관계); her memories, their network and what she studied (기억 ·
 * 네트워크 · 공부); the rest of her day (plan, what she wants for herself and her growth, journal, gifts, what she gave and
 * the moments you shared); and the record of what happened (기록). One window for all of it (2026-11-20: the ♥ panel
 * beside the conversation was this shown a second time, a 자세히 away) — as wide as the screen allows, two columns when
 * there is room. How she is made — her temperament — is Mate settings → 기질 (`onSettings`). */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Mate } from "../../../api/mates";
import { useLang, useT, type MsgKey } from "../../../i18n";
import { fmtTime } from "../../../i18n/format";
import { STATE_EMOJI } from "../../../mate/relationJournal";
import Icon from "../../ui/Icon";
import { RelationRing, STAGE_LABEL } from "../RelationRing";
import { stateName, stateWhy } from "../StateCard";
import { Card, GiftsSection, GrowthSection, JournalSection, KeepsakesSection, LifeOff, NeedsList, PlanSection, SayChips, SKY, SLOT_LABEL, TodayList, useLifeView } from "../life/LifeSections";
import { lifeName } from "../life/needs";
import StageWindow, { type WindowTab } from "./StageWindow";
import Journal from "../gss/Journal";
import { Between, Mind, NowContext, Promises, useGssView } from "../gss/StateView";
import OtherMates from "../social/OtherMates";
import { RelationView } from "../RelationPanel";
import MemoryNotebook from "../MemoryNotebook";
import MemoryNetwork from "../memory/MemoryNetwork";
import StudyPanel from "../memory/StudyPanel";

export type StatusTab = "now" | "relation" | "memory" | "network" | "study" | "plan" | "growth" | "journal" | "gifts" | "keepsakes" | "log";
type Tab = StatusTab;
const NOW: WindowTab<Tab> = { id: "now", icon: "heart", label: "stage.tabNow" };
const RELATION: WindowTab<Tab> = { id: "relation", icon: "user", label: "stage.tabRelation" };
const MIND: WindowTab<Tab>[] = [
  { id: "memory", icon: "brain", label: "mateSettings.memTitle" },
  { id: "network", icon: "network", label: "memgraph.tab" },
  { id: "study", icon: "graduation", label: "memgraph.studyTab" },
];
const LOG: WindowTab<Tab> = { id: "log", icon: "history", label: "stage.tabLog" };
// (her day — only while it is on)
const LIFE_TABS: WindowTab<Tab>[] = [
  { id: "plan", icon: "calendar", label: "life.tabPlan" },
  { id: "growth", icon: "trending-up", label: "life.tabGrowth" },
  { id: "journal", icon: "book", label: "life.tabJournal" },
  { id: "gifts", icon: "gift", label: "life.tabGifts" },
  { id: "keepsakes", icon: "sparkles", label: "life.tabKeepsakes" },
];
const BIRTHDAY: Record<"her" | "user" | "both", MsgKey> = { her: "life.birthdayHer", user: "life.birthdayUser", both: "life.birthdayBoth" };

/** cards in two columns when the window is wide enough (top to bottom, then the next column), one otherwise */
// (each card its own bottom margin — a space-y would take it away from all but the first in a column)
const COLS = "lg:columns-2 lg:gap-4 [&>*]:mb-3 lg:[&>*]:mb-4 [&>*]:break-inside-avoid";

export default function StatusWindow({ mate, phone, wide = false, panel = false, onClose, onSay, onSettings, initialTab = "now" }: {
  mate: Mate;
  phone: boolean;
  /** over the whole view, as wide as the screen allows (desktop) */
  wide?: boolean;
  /** filling where it is put (the desktop chat window) */
  panel?: boolean;
  onClose: () => void;
  onSay: (text: string) => void;
  /** Mate settings → 관계와 기억 (how the relationship and her memory are set: this window is for looking) */
  onSettings: () => void;
  initialTab?: StatusTab;
}) {
  const t = useT();
  const locale = useLang();
  const [tab, setTab] = useState<Tab>(initialTab);
  const { v, setV, err, setErr } = useLifeView(mate);
  const gss = useGssView(mate);
  const life = v?.enabled ? v : null;
  const tabs = [NOW, RELATION, ...MIND, ...(life ? LIFE_TABS : []), LOG];
  const shown: Tab = tabs.some((x) => x.id === tab) ? tab : "now";
  // (another tab starts at its top)
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    top.current?.closest('[data-testid="stage-status-body"]')?.scrollTo(0, 0);
  }, [shown]);
  const rel = mate.relation;
  const state = mate.state;
  const sky = SKY[life?.weather ?? "clear"];
  // (two columns only in the wide window; the stage's, the sheet and the chat window's are one)
  const cols = wide ? COLS : "space-y-3";
  const narrow = (children: ReactNode) => <div className={wide ? "mx-auto max-w-3xl space-y-3" : "space-y-3"}>{children}</div>;
  const settingsBtn = (
    <button onClick={onSettings} className="btn-ghost shrink-0 !px-2.5 !py-1 text-[12px]" title={t("mate.bondAdjust")} aria-label={t("mate.bondAdjust")} data-testid="stage-status-settings">
      <Icon name="sliders" size={13} /> <span className="hidden min-[400px]:inline">{t("mate.bondAdjust")}</span>
    </button>
  );
  return (
    <StageWindow title={t("stage.statusTitle", { name: mate.name })} sub={t("stage.statusSub")} icon="heart" phone={phone} wide={wide} panel={panel} actions={settingsBtn} onClose={onClose} tabs={tabs} tab={shown} onTab={setTab} testId="stage-status">
      <NowContext.Provider value={gss.now}>
      <span ref={top} hidden />
      {err && <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{t("life.error", { error: err })}</p>}
      {gss.err && <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{gss.err}</p>}
      {shown === "now" ? (
        <div className={cols} data-testid="stage-status-now">
          <Card testId="stage-status-bond">
            <div className="flex items-center gap-3">
              {rel?.enabled ? (
                <span className="relative grid shrink-0 place-items-center">
                  <RelationRing value={rel.affinity} stage={rel.stage} size={54} />
                  <span className="absolute text-[13px] font-semibold tabular-nums text-content" data-testid="stage-status-affinity">{Math.round(rel.affinity)}</span>
                </span>
              ) : (
                <span className="grid h-[54px] w-[54px] shrink-0 place-items-center rounded-full bg-content/10 text-content-faint">
                  <Icon name="heart" size={18} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-content-faint">{t("stage.bond")}</p>
                <p className="truncate text-[14px] font-semibold text-content">{rel?.enabled ? t(STAGE_LABEL[rel.stage]) : t("stage.bondOff")}</p>
                {state && (
                  <p className="mt-0.5 truncate text-[12.5px] text-content-dim" data-testid="stage-status-feeling" data-state={state.label}>
                    <span aria-hidden>{STATE_EMOJI[state.label]}</span> {stateName(t, state)}
                    {stateWhy(t, state.top[0]?.why) ? ` · ${stateWhy(t, state.top[0]?.why)}` : ""}
                  </p>
                )}
              </div>
              <button type="button" className="btn-ghost shrink-0 !px-2 !py-1 text-[12px]" onClick={() => setTab("relation")} data-testid="stage-status-more">
                {t("stage.bondMore")} <Icon name="chevron" size={13} />
              </button>
            </div>
          </Card>
          {gss.v && <Mind s={gss.v.state} name={mate.name} />}
          {!v ? (
            !err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
          ) : !life ? (
            <LifeOff mate={mate} onOn={setV} />
          ) : (
            <>
              {(life.gift || life.birthday) && (
                <Card testId="stage-status-today">
                  {life.birthday && (
                    <p className="flex items-center gap-2 text-[12.5px] font-medium text-content" data-testid="life-birthday" data-who={life.birthday}>
                      <Icon name="sparkles" size={14} className="shrink-0 text-violet" /> {t(BIRTHDAY[life.birthday], { name: mate.name })}
                    </p>
                  )}
                  {life.gift && (
                    <div className={`flex items-center gap-2 text-[12.5px] ${life.birthday ? "mt-2" : ""}`} data-testid="life-gift-new">
                      <Icon name="gift" size={14} className="shrink-0 text-violet" />
                      <span className="min-w-0 flex-1 truncate text-content-dim">
                        {t("life.giftNew", { name: mate.name })}: <span className="text-content">{lifeName(life.gift.name, locale, life.gift.id)}</span>
                      </span>
                      <button type="button" className="btn-soft shrink-0 !px-2.5 !py-1 text-[12px]" onClick={() => setTab("keepsakes")} data-testid="life-gift-see">
                        {t("life.giftSee")}
                      </button>
                    </div>
                  )}
                </Card>
              )}
              <Card testId="stage-status-where">
                <div className="flex items-center gap-3">
                  {life.art && <img src={life.art} alt="" className="h-14 w-24 shrink-0 rounded-lg object-cover" draggable={false} />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-content" data-testid="life-now-place">{lifeName(life.place_name, locale, life.place)}</p>
                    <p className="truncate text-[12.5px] text-content-dim" data-testid="life-now-activity">
                      {lifeName(life.activity_name, locale)}
                      {life.with_user && <span className="ml-1.5 text-accent">· {t("life.together")}</span>}
                      {life.with_mate && <span className="ml-1.5 text-accent" data-testid="life-with-mate">· {t("life.withMate", { name: life.with_mate.name })}</span>}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-content-faint">
                      {t(SLOT_LABEL[life.slot ?? "day"])} <Icon name={sky.icon} size={11} /> {t(sky.label)}
                      {life.temp != null && <span data-testid="life-now-temp">{life.temp}°{life.city ? ` · ${life.city}` : ""}</span>}
                      {life.observance ? (
                        <span className="text-accent" data-testid="life-observance" data-id={life.observance.id}>· {lifeName(life.observance.name, locale, life.observance.id)}</span>
                      ) : (
                        life.holiday && <span className="text-accent">· {t("life.holiday")}</span>
                      )}
                      {life.next && <span className="truncate">· {t("life.next", { time: fmtTime(life.next.at), what: lifeName(life.next.name, locale) })}</span>}
                    </p>
                  </div>
                </div>
              </Card>
              <Card title={t("life.howShe", { name: mate.name })}>
                <NeedsList v={life} />
              </Card>
              <SayChips onSay={onSay} />
              <Card title={t("life.today")}>
                <TodayList v={life} />
              </Card>
              <button className="btn-ghost mx-auto block !py-1 text-[11.5px] text-content-faint" onClick={() => void import("../../../stores/mateStore").then(({ useMateStore }) => useMateStore.getState().patch(mate.id, { prefs: { life: "off" } }))} data-testid="mate-life-turn-off">
                {t("life.turnOff")}
              </button>
            </>
          )}
        </div>
      ) : shown === "relation" ? (
        // (where you two are in full — then what she is to you, the promises both ways, the others she knows)
        <RelationView mate={mate} onMemory={() => setTab("memory")} className={wide ? COLS : "space-y-3"}>
          {gss.v && (
            <>
              <Between b={gss.v.bonds} name={mate.name} />
              <Promises promises={gss.v.promises ?? []} name={mate.name} />
            </>
          )}
          <OtherMates mate={mate} />
        </RelationView>
      ) : shown === "memory" ? (
        narrow(<MemoryNotebook key={mate.id} mate={mate} onSettings={onSettings} />)
      ) : shown === "network" ? (
        <MemoryNetwork key={mate.id} mate={mate} onStudy={() => setTab("study")} />
      ) : shown === "study" ? (
        narrow(<StudyPanel key={mate.id} mate={mate} />)
      ) : shown === "log" ? (
        gss.v ? (
          narrow(<Journal entries={gss.entries} name={mate.name} more={gss.more} onMore={() => void gss.loadMore()} />)
        ) : (
          !gss.err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
        )
      ) : !life ? null : shown === "plan" ? (
        narrow(<PlanSection v={life} mate={mate} onChange={setV} onError={setErr} />)
      ) : shown === "growth" ? (
        narrow(<GrowthSection v={life} />)
      ) : shown === "journal" ? (
        narrow(<JournalSection v={life} />)
      ) : shown === "keepsakes" ? (
        narrow(<KeepsakesSection v={life} mate={mate} />)
      ) : (
        narrow(<GiftsSection v={life} mate={mate} onChange={setV} onError={setErr} />)
      )}
      </NowContext.Provider>
    </StageWindow>
  );
}
