import {useDevicePreferences} from "../../../stores/devicePreferences";
import { useSyncExternalStore } from "react";
import { useLocalScreenControls } from "../../composer/LocalScreenControls";
import { sharingSnapshot, subscribeSharing, stopSharing,sharingStatusSnapshot } from "../../../mate/localScreen";
import { type Mate } from "../../../api/mates";
import { useT,type MsgKey } from "../../../i18n";
import { Section } from "./ui";
import DeviceCaptureSettings from "../../composer/DeviceCaptureSettings";
export default function ScreenTab({ mate, sid }: { mate: Mate; sid: string | null }) {
  const t = useT();
  const intent = useDevicePreferences().sharing;
  const status=useSyncExternalStore(subscribeSharing,sharingStatusSnapshot);
  const labels:Record<string,MsgKey>={waiting_connection:"screen.waitConnection",waiting_auth:"screen.waitAuth",waiting_target:"screen.waitTarget",waiting_permission:"screen.waitPermission",waiting_session:"screen.waitSession",error:"screen.waitConnection",off:"screen.waitConnection"};
  const sharing = useSyncExternalStore(subscribeSharing, sharingSnapshot);
  const screen = useLocalScreenControls(sid || "", mate.name, () => {}, mate, {
    listenToolbar: false, allowOnce: false,
  });
  return (
    <>
      <Section title={t("composer.shareScreen")} hint={t("screen.oneSharingHint")} testId="settings-screen-sharing">
        {sharing && (
          <p className="break-words text-xs text-content-dim">
            {t("screen.sharing", { source: sharing.source })}
          </p>
        )}
        {!sharing && intent.enabled && <p className="text-xs text-content-dim">{t(labels[status]||"screen.restorePending")}</p>}
        {sharing || intent.enabled ? (
          <button type="button" onClick={stopSharing} className="btn-ghost text-danger" data-testid="settings-screen-stop">
            {t("screen.stop")}
          </button>
        ) : (
          <button type="button" disabled={!sid} onClick={screen.open} className="btn-primary" data-testid="settings-screen-start">
            {t("screen.start")}
          </button>
        )}
        {intent.enabled&&!sharing&&<button type="button" className="btn-ghost" onClick={screen.open}>{t("screen.reconnect")}</button>}
        {sharing?.error && <p role="alert" className="text-xs text-danger">{sharing.error}</p>}
      </Section>
      <DeviceCaptureSettings mate={mate}/>
      {screen.ui}
    </>
  );
}
