import { useEffect, useState } from "react";
import {
  useDevicePreferences,
  patchDevicePreferences,
} from "../../stores/devicePreferences";
import {
  captureBridge,
  type CaptureSource,
  type CaptureInfo,
} from "../../mate/screenCapture";
import { useT } from "../../i18n";
export default function DeviceCaptureSettings() {
  const t = useT(),
    prefs = useDevicePreferences(),
    s = prefs.screen;
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  useEffect(() => {
    void captureBridge()
      ?.info()
      .then(setInfo, () => {});
    void captureBridge()
      ?.sources()
      .then(setSources, () => {});
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
      <p className="text-content-faint">{t("screen.deviceSettingsHint")}</p>
      {!!captureBridge() && (
        <label className="flex flex-wrap items-center gap-2">
          {t("screen.source")}
          <select
            className="min-w-0 max-w-full rounded border border-border bg-surface px-2 py-1"
            value={s.source?.id || ""}
            onChange={(e) =>
              patch({
                source: sources.find((x) => x.id === e.target.value) || null,
              })
            }
            data-testid="device-capture-source"
          >
            <option value="">{t("screen.primaryScreen")}</option>
            {s.source && !sources.some((x) => x.id === s.source?.id) && (
              <option value={s.source.id}>{s.source.name}</option>
            )}
            {sources.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-wrap items-center gap-2">
        {t("screen.approval")}
        <select
          value={s.approval}
          onChange={(e) =>
            patch({ approval: e.target.value as typeof s.approval })
          }
          className="rounded border border-border bg-surface px-2 py-1"
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
          className="rounded border border-border bg-surface px-2 py-1"
          data-testid="device-capture-size"
        >
          {[1280, 1920, 2560, 0].map((n) => (
            <option key={n} value={n}>
              {n ? `${n} px` : t("mateSettings.screenSizeFull")}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-wrap items-center gap-2">
        {t("screen.imageFormat")}
        <select
          value={s.format}
          onChange={(e) => patch({ format: e.target.value as typeof s.format })}
          className="rounded border border-border bg-surface px-2 py-1"
          data-testid="device-capture-format"
        >
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
        </select>
      </label>
      {s.format === "jpeg" && (
        <label className="flex items-center gap-2">
          {t("mateSettings.screenQuality", { n: s.quality })}
          <input
            type="range"
            min="40"
            max="100"
            value={s.quality}
            onChange={(e) => patch({ quality: Number(e.target.value) })}
          />
        </label>
      )}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={s.hide_avatar}
          onChange={(e) => patch({ hide_avatar: e.target.checked })}
          data-testid="device-capture-hide"
        />
        {t("screen.hideAvatar")}
      </label>
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
