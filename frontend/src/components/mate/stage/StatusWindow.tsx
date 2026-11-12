/** Status: how close you are and how she feels, where she is and how she is, and the rest of her day (plan, growth, journal, gifts). */
import { useState } from "react";
import type { Mate } from "../../../api/mates";
import { useLang, useT } from "../../../i18n";
import { fmtTime } from "../../../i18n/format";
import { STATE_EMOJI } from "../../../mate/relationJournal";
import Icon from "../../ui/Icon";
import { RelationRing, STAGE_LABEL } from "../RelationRing";
import { stateName, stateWhy, STATE_LABEL } from "../StateCard";
import { Card, GiftsSection, GrowthSection, JournalSection, LifeOff, NeedsList, PlanSection, SayChips, SKY, SLOT_LABEL, TodayList, useLifeView } from "../life/LifeSections";
import { lifeName } from "../life/needs";
import StageWindow, { type WindowTab } from "./StageWindow";

type Tab = "now" | "plan" | "growth" | "journal" | "gifts";
const TABS: WindowTab<Tab>[] = [
  { id: "now", icon: "heart", label: "stage.tabNow" },
  { id: "plan", icon: "calendar", label: "life.tabPlan" },
  { id: "growth", icon: "trending-up", label: "life.tabGrowth" },
  { id: "journal", icon: "book", label: "life.tabJournal" },
  { id: "gifts", icon: "gift", label: "life.tabGifts" },
];

export default function StatusWindow({ mate, phone, onClose, onSay, onRelation }: { mate: Mate; phone: boolean; onClose: () => void; onSay: (text: string) => void; onRelation: () => void }) {
  const t = useT();
  const locale = useLang();
  const [tab, setTab] = useState<Tab>("now");
  const { v, setV, err, setErr } = useLifeView(mate);
  const life = v?.enabled ? v : null;
  const rel = mate.relation;
  const state = mate.state;
  const sky = SKY[life?.weather ?? "clear"];
  return (
    <StageWindow title={t("stage.statusTitle", { name: mate.name })} sub={t("stage.statusSub")} icon="heart" phone={phone} onClose={onClose} tabs={life ? TABS : undefined} tab={tab} onTab={setTab} testId="stage-status">
      {err && <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{t("life.error", { error: err })}</p>}
      {tab === "now" || !life ? (
        <>
          <Card testId="stage-status-bond">
            <div className="flex items-center gap-3">
              {rel?.enabled ? (
                <span className="relative grid shrink-0 place-items-center">
                  <RelationRing value={rel.affinity} stage={rel.stage} size={54} />
                  <span className="absolute text-[13px] font-semibold tabular-nums text-content" data-testid="stage-status-affinity">{Math.round(rel.affinity)}</span>
                </span>
              ) : (
                <span className="grid h-[54px] w-[54px] shrink-0 place-items-center rounded-full bg-white/10 text-content-faint">
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
            {!!state?.top.length && (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {state.top.map((f) => (
                  <li key={f.emotion} className="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11.5px] text-content-dim" title={stateWhy(t, f.why)}>
                    {t(STATE_LABEL[f.emotion])}
                    <span className="h-1 w-8 overflow-hidden rounded-full bg-white/15">
                      <span className="block h-full rounded-full bg-violet" style={{ width: `${Math.round(Math.min(1, f.v) * 100)}%` }} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {!v ? (
            !err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
          ) : !life ? (
            <LifeOff mate={mate} onOn={setV} />
          ) : (
            <>
              <Card testId="stage-status-where">
                <div className="flex items-center gap-3">
                  {life.art && <img src={life.art} alt="" className="h-14 w-24 shrink-0 rounded-lg object-cover" draggable={false} />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-content" data-testid="life-now-place">{lifeName(life.place_name, locale, life.place)}</p>
                    <p className="truncate text-[12.5px] text-content-dim" data-testid="life-now-activity">
                      {lifeName(life.activity_name, locale)}
                      {life.with_user && <span className="ml-1.5 text-accent">· {t("life.together")}</span>}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-content-faint">
                      {t(SLOT_LABEL[life.slot ?? "day"])} <Icon name={sky.icon} size={11} /> {t(sky.label)}
                      {life.temp != null && <span data-testid="life-now-temp">{life.temp}°{life.city ? ` · ${life.city}` : ""}</span>}
                      {life.holiday && <span className="text-accent">· {t("life.holiday")}</span>}
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
      ) : tab === "plan" ? (
        <PlanSection v={life} mate={mate} onChange={setV} onError={setErr} />
      ) : tab === "growth" ? (
        <GrowthSection v={life} />
      ) : tab === "journal" ? (
        <JournalSection v={life} />
      ) : (
        <GiftsSection v={life} mate={mate} onChange={setV} onError={setErr} />
      )}
    </StageWindow>
  );
}
