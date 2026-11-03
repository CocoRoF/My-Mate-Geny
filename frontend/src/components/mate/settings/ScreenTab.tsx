import { useSyncExternalStore } from "react";
import { useLocalScreenControls } from "../../composer/LocalScreenControls";
import { sharingSnapshot, subscribeSharing, stopSharing } from "../../../mate/localScreen";
import { useMateStore } from "../../../stores/mateStore";
import { screenOf, type Mate } from "../../../api/mates";
import { useT } from "../../../i18n";
import { Section, Toggle } from "./ui";
import DeviceCaptureSettings from "../../composer/DeviceCaptureSettings";
export default function ScreenTab({ mate, sid }: { mate: Mate; sid: string | null }) {
  const t = useT();
  const sharing = useSyncExternalStore(subscribeSharing, sharingSnapshot);
  const screen = useLocalScreenControls(sid || "", mate.name, () => {}, mate, {
    listenToolbar: false, allowOnce: false,
  });
  return (
    <>
      <Section
        title={t("mateSettings.screenTitle")}
        hint={t("screen.matePermissionHint")}
        testId="mate-screen"
      >
        <Toggle
          on={screenOf(mate).enabled}
          onChange={(enabled) => {
            void useMateStore
              .getState()
              .patch(mate.id, { screen: { enabled } });
          }}
          label={t("mateSettings.screenEnabled", { name: mate.name })}
          hint={t("mateSettings.screenEnabledHint")}
          testId="mate-screen-enabled"
        />
      </Section>
      <Section title={t("composer.shareScreen")} testId="settings-screen-sharing">
        {sharing && (
          <p className="break-words text-xs text-content-dim">
            {t("screen.sharing", { source: sharing.source })}
          </p>
        )}
        {sharing ? (
          <button type="button" onClick={stopSharing} className="btn-ghost text-danger" data-testid="settings-screen-stop">
            {t("screen.stop")}
          </button>
        ) : (
          <button type="button" disabled={!sid} onClick={screen.open} className="btn-primary" data-testid="settings-screen-start">
            {t("screen.start")}
          </button>
        )}
        {sharing?.error && <p role="alert" className="text-xs text-danger">{sharing.error}</p>}
      </Section>
      <DeviceCaptureSettings />
      {screen.ui}
    </>
  );
}
