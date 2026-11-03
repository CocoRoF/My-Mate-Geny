import {useDevicePreferences,patchDevicePreferences} from "../../../stores/devicePreferences";
import type {Mate} from "../../../api/mates";
import {useT} from "../../../i18n";
import {Section,Toggle} from "./ui";
export default function ProactiveTab({mate}:{mate:Mate}){
 const t=useT(),p=useDevicePreferences();
 const on=!!p.screen.proactive_enabled&&(!p.screen.proactive_mate||p.screen.proactive_mate===mate.id);
 return <Section title={t("screen.simpleReachOut")} hint={t("screen.fixedReachOutHint")} testId="mate-proactive">
  <Toggle on={on} onChange={enabled=>void patchDevicePreferences({screen:{proactive_enabled:enabled,proactive_mate:mate.id,proactive_interval:60}})} label={t("screen.reachOutSwitch",{name:mate.name})} testId="proactive-enabled"/>
 </Section>;
}
