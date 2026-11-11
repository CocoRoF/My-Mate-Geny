import {type Mate} from "../../api/mates";
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
import { openAppSettings } from "../../lib/openAppSettings";
/**
 * This device's screen capture (docs/settings.md). `part`: "share" — what a share shows and when she looks (the
 * composer's share dialog: changed now and then); "device" — what is set once (Settings → Screen sharing: asking
 * first, the picture's size and format).
 */
export default function DeviceCaptureSettings({mate, part}: {mate?:Mate; part:"share"|"device"}) {
  const t = useT(),
    prefs = useDevicePreferences(),
    s = prefs.screen;
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const refreshSources = () => {
    void captureBridge()?.sources().then(setSources,()=>{});
  };
  useEffect(() => {
    void captureBridge()?.info().then(setInfo,()=>{});
    refreshSources();
    window.addEventListener("focus",refreshSources);
    return ()=>window.removeEventListener("focus",refreshSources);
  }, []);
  const patch = (p: Partial<typeof s>) => {
    void patchDevicePreferences({ screen: p });
  };
  return (
    <div
      className="space-y-3 rounded-xl border border-border p-3 text-xs"
      data-testid="device-capture-settings"
    >
      <p className="font-medium">{t(part === "share" ? "screen.shareSettings" : "screen.deviceSettings")}</p>
      <p className="text-content-faint">{t("screen.deviceSettingsHint")}</p>

      {part === "share" && <>
      <label className="flex flex-wrap items-center gap-2">
        {t("screen.mode")}
        <select value={prefs.sharing.mode} onChange={e=>void patchDevicePreferences({sharing:{mode:e.target.value as typeof prefs.sharing.mode}})} className="min-w-0 flex-1 basis-40 rounded border border-border bg-surface px-2 py-1" data-testid="screen-mode">
          <option value="ask">{t("screen.whenRequested")}</option>
          <option value="on_turn">{t("screen.onTurn")}</option>
          {(!mate || prefs.sharing.mode==="observe")&&<option value="observe">{t("screen.observe")}</option>}
        </select>
      </label>
      {prefs.sharing.mode==="observe"&&<label className="flex flex-wrap items-center gap-2">{t("screen.interval")}
        <select value={prefs.sharing.interval} onChange={e=>void patchDevicePreferences({sharing:{interval:Number(e.target.value)}})} data-testid="screen-interval" className="min-w-0 flex-1 basis-40 rounded border border-border bg-surface px-2 py-1">
          {[60,180,300,600].map(n=><option key={n} value={n}>{t("screen.seconds",{count:n})}</option>)}
        </select>
      </label>}
      {!!captureBridge() && (
        <label className="flex flex-wrap items-center gap-2">
          {t("screen.source")}
          <select
            className="min-w-0 max-w-full flex-1 basis-40 rounded border border-border bg-surface px-2 py-1"
            value={s.source_invalid?"__invalid__":s.source?.id || ""}
            onChange={(e) =>
              patch({
                source: sources.find((x) => x.id === e.target.value) || null,
              })
            }
            data-testid="device-capture-source"
          >
            <option value="">{t("screen.primaryScreen")}</option>
            {s.source_invalid&&<option value="__invalid__" disabled>{t("screen.targetUnavailable")}</option>}
            {s.source && !sources.some((x) => x.id === s.source?.id) && (
              <option value={s.source.id}>{s.source.name}</option>
            )}
            {sources.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn-ghost !px-2" onClick={refreshSources} data-testid="device-capture-refresh">{t("common.refresh")}</button>
        </label>
      )}
      <button type="button" className="text-left text-accent hover:underline" onClick={() => openAppSettings("screen")} data-testid="device-capture-settings-link">
        {t("screen.moreInSettings")}
      </button>
      </>}
      {part === "device" && <>
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
          className="min-w-0 flex-1 basis-40 rounded border border-border bg-surface px-2 py-1"
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
      <p className="text-content-faint">{t("screen.asVisible")}</p>
      </>}
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
