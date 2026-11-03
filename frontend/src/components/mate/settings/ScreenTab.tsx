import { useMateStore } from "../../../stores/mateStore";
import { screenOf, type Mate } from "../../../api/mates";
import { useT } from "../../../i18n";
import { Section, Toggle } from "./ui";
import DeviceCaptureSettings from "../../composer/DeviceCaptureSettings";
export default function ScreenTab({ mate }: { mate: Mate }) {
  const t = useT();
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
      <DeviceCaptureSettings />
    </>
  );
}
