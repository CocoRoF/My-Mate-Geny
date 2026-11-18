/** Status (메이트 상태) — only what is, never settings: how close you are and every feeling she has now with what is still
 * with her, where she is and how she is (what today is, a gift she just gave); what she is to you and the promises both
 * ways (관계); the rest of her day (plan, what she wants for herself and her growth, journal, gifts, what she gave and the
 * moments you shared); and the record of what happened (기록). How she is made — her temperament — is Mate settings → 기질. */
import { useState } from "react";
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

type Tab = "now" | "relation" | "plan" | "growth" | "journal" | "gifts" | "keepsakes" | "log";
const NOW: WindowTab<Tab> = { id: "now", icon: "heart", label: "stage.tabNow" };
const RELATION: WindowTab<Tab> = { id: "relation", icon: "user", label: "stage.tabRelation" };
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

export default function StatusWindow({ mate, phone, onClose, onSay, onRelation }: { mate: Mate; phone: boolean; onClose: () => void; onSay: (text: string) => void; onRelation: () => void }) {
  const t = useT();
  const locale = useLang();
  const [tab, setTab] = useState<Tab>("now");
  const { v, setV, err, setErr } = useLifeView(mate);
  const gss = useGssView(mate);
  const life = v?.enabled ? v : null;
  const tabs = life ? [NOW, RELATION, ...LIFE_TABS, LOG] : [NOW, RELATION, LOG];
  const shown: Tab = tabs.some((x) => x.id === tab) ? tab : "now";
  const rel = mate.relation;
  const state = mate.state;
  const sky = SKY[life?.weather ?? "clear"];
  return (
    <StageWindow title={t("stage.statusTitle", { name: mate.name })} sub={t("stage.statusSub")} icon="heart" phone={phone} onClose={onClose} tabs={tabs} tab={shown} onTab={setTab} testId="stage-status">
      <NowContext.Provider value={gss.now}>
      {err && <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{t("life.error", { error: err })}</p>}
      {gss.err && <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{gss.err}</p>}
      {shown === "now" ? (
        <>
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
              <button type="button" className="btn-ghost shrink-0 !px-2 !py-1 text-[12px]" onClick={onRelation} data-testid="stage-status-more">
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
        </>
      ) : shown === "relation" ? (
        gss.v ? (
          <>
            <Between b={gss.v.bonds} name={mate.name} />
            <Promises promises={gss.v.promises ?? []} name={mate.name} />
            <OtherMates mate={mate} />
          </>
        ) : (
          !gss.err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
        )
      ) : shown === "log" ? (
        gss.v ? (
          <Journal entries={gss.entries} name={mate.name} more={gss.more} onMore={() => void gss.loadMore()} />
        ) : (
          !gss.err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
        )
      ) : !life ? null : shown === "plan" ? (
        <PlanSection v={life} mate={mate} onChange={setV} onError={setErr} />
      ) : shown === "growth" ? (
        <GrowthSection v={life} />
      ) : shown === "journal" ? (
        <JournalSection v={life} />
      ) : shown === "keepsakes" ? (
        <KeepsakesSection v={life} mate={mate} />
      ) : (
        <GiftsSection v={life} mate={mate} onChange={setV} onError={setErr} />
      )}
      </NowContext.Provider>
    </StageWindow>
  );
}
