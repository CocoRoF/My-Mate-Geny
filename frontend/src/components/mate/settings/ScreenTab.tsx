/**
 * Screen (this mate, docs/mate.md §4 "Seeing the screen"): may she look at the screen (see_screen — off by default;
 * off, the tool doesn't exist for her), ask every time or not, hide the avatar windows while capturing, the picture's
 * size and format (saved on the server: every device follows at once, mates.changed). "On this computer" (the desktop
 * app only): what she sees from here — the primary screen, another screen or one window — remembered on this computer
 * (sources are this computer's), a test picture that never leaves the page, and what this system needs.
 */
import { useEffect, useState } from "react";
import { screenOf, type Mate, type MateScreen } from "../../../api/mates";
import { captureBridge, captureError, type CaptureInfo, type CaptureSource } from "../../../mate/screenCapture";
import { useMateStore } from "../../../stores/mateStore";
import { useT, type MsgKey } from "../../../i18n";
import Icon from "../../ui/Icon";
import { Banner, Field, SaveBar, Section, Segmented, Toggle, useFollowSaved, useSaver } from "./ui";

const EDGES: { id: `${MateScreen["max_edge"]}`; label: string | MsgKey }[] = [
  { id: "1280", label: "1280" },
  { id: "1920", label: "1920" },
  { id: "2560", label: "2560" },
  { id: "0", label: "mateSettings.screenSizeFull" },
];

export default function ScreenTab({ mate }: { mate: Mate }) {
  const t = useT();
  const saved = screenOf(mate);
  const [d, setD] = useState<MateScreen>(saved);
  const saver = useSaver();
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const reset = () => setD(saved);
  useFollowSaved([JSON.stringify(saved)], dirty, reset);
  const save = () =>
    saver.run(async () => {
      const m = await useMateStore.getState().patch(mate.id, { screen: d });
      setD(screenOf(m));
    });
  const off = !d.enabled;

  return (
    <>
      <Section title={t("mateSettings.screenTitle")} hint={t("mateSettings.screenHint", { name: mate.name })} testId="mate-screen">
        <Toggle on={d.enabled} onChange={(on) => setD((x) => ({ ...x, enabled: on }))} label={t("mateSettings.screenEnabled", { name: mate.name })} hint={t("mateSettings.screenEnabledHint")} testId="mate-screen-enabled" />
        <Field label={t("mateSettings.screenApproval")} hint={t("mateSettings.screenApprovalHint")} as="div">
          <Segmented
            value={d.approval}
            onChange={(v) => setD((x) => ({ ...x, approval: v }))}
            options={[
              { id: "ask", label: t("mateSettings.screenAsk"), disabled: off },
              { id: "allow", label: t("mateSettings.screenAllow"), disabled: off },
            ]}
            testId="mate-screen-approval"
          />
        </Field>
        <Toggle on={d.hide_avatar} onChange={(on) => setD((x) => ({ ...x, hide_avatar: on }))} label={t("mateSettings.screenHide")} hint={t("mateSettings.screenHideHint")} testId="mate-screen-hide" />
        <Field label={t("mateSettings.screenSize")} hint={t("mateSettings.screenSizeHint")} as="div">
          <Segmented
            value={`${d.max_edge}` as `${MateScreen["max_edge"]}`}
            onChange={(v) => setD((x) => ({ ...x, max_edge: Number(v) as MateScreen["max_edge"] }))}
            options={EDGES.map((o) => ({ id: o.id, label: o.id === "0" ? t(o.label as MsgKey) : `${o.label} px` }))}
            testId="mate-screen-size"
          />
        </Field>
        <Field label={t("mateSettings.screenFormat")} hint={t("mateSettings.screenFormatHint")} as="div">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented value={d.format} onChange={(v) => setD((x) => ({ ...x, format: v }))} options={[{ id: "png", label: "PNG" }, { id: "jpeg", label: "JPEG" }]} testId="mate-screen-format" />
            {d.format === "jpeg" && (
              <label className="flex items-center gap-2 text-[12px] text-content-dim">
                {t("mateSettings.screenQuality", { n: d.quality })}
                <input type="range" min={40} max={100} step={5} value={d.quality} onChange={(e) => setD((x) => ({ ...x, quality: Number(e.target.value) }))} data-testid="mate-screen-quality" />
              </label>
            )}
          </div>
        </Field>
      </Section>
      <SaveBar saver={saver} onSave={save} dirty={dirty} onReset={reset} />
      <ThisComputer mate={mate} screen={saved} />
      <Section title={t("mateSettings.screenPlatforms")}>
        <ul className="list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-content-dim">
          <li>{t("mateSettings.screenWin")}</li>
          <li>{t("mateSettings.screenMac")}</li>
          <li>{t("mateSettings.screenLinux")}</li>
          <li>{t("mateSettings.screenPrivacy", { name: mate.name })}</li>
        </ul>
      </Section>
    </>
  );
}

/** what she sees from this computer (desktop app only; remembered here) + a test picture */
function ThisComputer({ mate, screen }: { mate: Mate; screen: MateScreen }) {
  const t = useT();
  const bridge = captureBridge();
  const [list, setList] = useState<CaptureSource[] | null>(null);
  const [choice, setChoice] = useState<CaptureSource | null>(null);
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [test, setTest] = useState<{ url?: string; error?: string; size?: string; busy?: boolean }>({});

  const load = () => {
    if (!bridge) return;
    setList(null);
    void bridge.info().then(setInfo, () => {});
    void bridge.getChoice(mate.id).then(setChoice, () => {});
    bridge.sources({ thumbnails: true, size: 240 }).then(setList, () => setList([]));
  };
  useEffect(load, [mate.id]);
  useEffect(() => () => {
    if (test.url) URL.revokeObjectURL(test.url);
  }, [test.url]);

  if (!bridge) {
    const old = !!window.hrhNative?.platform?.startsWith("desktop");
    return (
      <Section title={t("mateSettings.screenDevice")}>
        <Banner tone="info" testId="mate-screen-noapp">
          {old ? t("mateSettings.screenOldApp") : t("mateSettings.screenNoApp")}
        </Banner>
      </Section>
    );
  }
  const pick = async (id: string) => {
    const src = id ? (list ?? []).find((s) => s.id === id) ?? null : null;
    await bridge.setChoice(mate.id, src ? { id: src.id, name: src.name, kind: src.kind, display_id: src.display_id } : null);
    setChoice(src);
  };
  const tryIt = async () => {
    setTest({ busy: true });
    const shot = await bridge.grab({ mateId: mate.id, sourceId: choice?.id || "", maxEdge: screen.max_edge, format: screen.format, quality: screen.quality, hideAvatar: screen.hide_avatar }).catch(() => null);
    if (!shot || !shot.ok) return setTest({ error: captureError(shot && !shot.ok ? shot.code : "error") });
    const url = URL.createObjectURL(new Blob([new Uint8Array(shot.data)], { type: shot.mime }));
    setTest({ url, size: `${shot.width}×${shot.height} · ${Math.round(shot.data.byteLength / 1024)} KB` });
  };
  const missing = !!choice && !!list && !list.some((s) => s.id === choice.id);
  const shown = (list ?? []).find((s) => s.id === (choice?.id || "")) ?? (list ?? []).find((s) => s.primary);

  return (
    <Section title={t("mateSettings.screenDevice")} hint={t("mateSettings.screenDeviceHint", { name: mate.name })} testId="mate-screen-device">
      {info && info.permission !== "granted" && info.permission !== "not-determined" && (
        <Banner tone="warn" action={<button className="underline" onClick={() => void bridge.openPrivacySettings()}>{t("mateSettings.screenOpenPrivacy")}</button>}>
          {t("mate.sharePermission")}
        </Banner>
      )}
      {info?.wayland && <Banner tone="info">{t("mateSettings.screenWayland")}</Banner>}
      <Field label={t("mateSettings.screenSource")} as="div">
        <div className="flex items-center gap-2">
          <select className="field min-w-0 flex-1" value={missing ? "__missing" : choice?.id || ""} onChange={(e) => void pick(e.target.value === "__missing" ? choice!.id : e.target.value)} data-testid="mate-screen-source">
            <option value="">{t("mateSettings.screenPrimary")}</option>
            {missing && <option value="__missing">{t("mateSettings.screenGone", { name: choice!.name })}</option>}
            {(list ?? []).filter((s) => s.kind === "screen").map((s) => (
              <option key={s.id} value={s.id}>
                {t("mateSettings.screenOptScreen", { name: s.name })}
              </option>
            ))}
            {(list ?? []).filter((s) => s.kind === "window").map((s) => (
              <option key={s.id} value={s.id}>
                {t("mateSettings.screenOptWindow", { name: s.name })}
              </option>
            ))}
          </select>
          <button className="btn-ghost !px-2" onClick={load} title={t("mate.shareRefresh")} aria-label={t("mate.shareRefresh")}>
            <Icon name="refresh" size={14} />
          </button>
        </div>
        {missing && <p className="text-[11.5px] text-warning">{t("mateSettings.screenGoneHint", { name: mate.name })}</p>}
      </Field>
      {shown?.thumbnail && !test.url && (
        <img src={shown.thumbnail} alt="" className="max-h-40 rounded-lg border border-border object-contain" data-testid="mate-screen-thumb" />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-ghost !px-2.5 !py-1 text-[12px]" onClick={() => void tryIt()} disabled={test.busy} data-testid="mate-screen-test">
          <Icon name={test.busy ? "spinner" : "monitor"} size={13} spin={test.busy} /> {t("mateSettings.screenTest")}
        </button>
        <span className="text-[11.5px] text-content-faint">{test.size || t("mateSettings.screenTestHint")}</span>
      </div>
      {test.error && <p className="text-[12px] text-danger" data-testid="mate-screen-test-error">{test.error}</p>}
      {test.url && <img src={test.url} alt="" className="max-h-56 rounded-lg border border-border object-contain" data-testid="mate-screen-test-shot" />}
    </Section>
  );
}
