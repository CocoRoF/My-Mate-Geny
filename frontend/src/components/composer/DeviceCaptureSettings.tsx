import { useEffect, useState } from "react";
import {
  useDevicePreferences,
  patchDevicePreferences,
} from "../../stores/devicePreferences";
import { captureBridge, type CaptureInfo } from "../../mate/screenCapture";
import { useT } from "../../i18n";
/**
 * This device's screen capture, set once (Settings → 메이트 and the Mate panel's 공통 tab, docs/settings.md): what
 * sharing is, asking before a capture, the picture's size (the original by default). What to share is picked with
 * Share screen itself (composer/LocalScreenControls).
 */
export default function DeviceCaptureSettings() {
  const t = useT(),
    s = useDevicePreferences().screen;
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  useEffect(() => {
    void captureBridge()?.info().then(setInfo,()=>{});
  }, []);
  const patch = (p: Partial<typeof s>) => {
    void patchDevicePreferences({ screen: p });
  };
  return (
    <div
      className="space-y-3 rounded-xl border border-border p-3 text-xs"
      data-testid="device-capture-settings"
    >
      <p className="font-medium">{t("screen.deviceSettings")}</p>
      <p data-testid="device-capture-intro">{t("screen.deviceIntro")}</p>
      <p className="text-content-faint">{t("screen.deviceSettingsHint")}</p>
      <label className="flex flex-wrap items-center gap-2">
        {t("screen.approval")}
        <select
          value={s.approval}
          onChange={(e) =>
            patch({ approval: e.target.value as typeof s.approval })
          }
          className="min-w-0 flex-1 basis-40 rounded border border-border bg-surface px-2 py-1"
          data-testid="device-capture-approval"
        >
          <option value="ask">{t("screen.ask")}</option>
          <option value="allow">{t("screen.allow")}</option>
        </select>
      </label>
      <label className="flex flex-wrap items-center gap-2">
        {t("screen.imageSize")}
        <select
          value={s.max_edge}
          onChange={(e) => patch({ max_edge: Number(e.target.value) })}
          className="min-w-0 flex-1 basis-40 rounded border border-border bg-surface px-2 py-1"
          data-testid="device-capture-size"
        >
          {[0, 2560, 1920, 1280].map((n) => (
            <option key={n} value={n}>
              {n ? `${n} px` : t("mateSettings.screenSizeFull")}
            </option>
          ))}
        </select>
      </label>
      <p className="text-content-faint">{t("screen.asVisible")}</p>
      {info?.permission === "denied" && (
        <button
          type="button"
          className="text-warning underline"
          onClick={() => void captureBridge()?.openPrivacySettings()}
        >
          {t("mateSettings.screenOpenPrivacy")}
        </button>
      )}
      <p className="text-content-faint">{t("screen.savedLocally")}</p>
      <details className="text-content-faint">
        <summary>{t("mateSettings.screenPlatforms")}</summary>
        <ul className="mt-2 space-y-1">
          <li>{t("mateSettings.screenWin")}</li>
          <li>{t("mateSettings.screenMac")}</li>
          <li>{t("mateSettings.screenLinux")}</li>
        </ul>
      </details>
    </div>
  );
}
