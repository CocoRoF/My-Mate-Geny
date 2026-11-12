/**
 * Settings → 화면 공유 (docs/settings.md): this device's capture settings that are set once — asking before a capture,
 * the picture's size (always a PNG). Starting a share, what it shows and when she looks: the composer's screen
 * control.
 */
import DeviceCaptureSettings from "../composer/DeviceCaptureSettings";
import { useT } from "../../i18n";

export default function ScreenShareTab() {
  const t = useT();
  return (
    <div className="space-y-3" data-testid="settings-screen">
      <p className="text-[12.5px] text-content-dim">{t("settings.screenShareHow")}</p>
      <DeviceCaptureSettings part="device" />
    </div>
  );
}
