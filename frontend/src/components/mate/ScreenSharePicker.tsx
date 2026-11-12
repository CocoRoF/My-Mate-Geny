import {
  useDevicePreferences,
  patchDevicePreferences,
} from "../../stores/devicePreferences";
/**
 * Share screen in the desktop app (the Mate composer's + menu): the screens and windows of this computer with small
 * previews, the one shared last preselected (this device), Share → one picture (the device's size setting) attached
 * to the message. With more than one screen (desktop app ≥ 4) also "All screens": one picture per screen, the one in
 * use first. mate/screenCapture.ts, docs/mate.md §4.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { type Mate } from "../../api/mates";
import {
  ALL_SCREENS,
  allScreensSource,
  canShareAllScreens,
  captureBridge,
  captureError,
  lastShared,
  rememberShared,
  shotPictures,
  type CaptureInfo,
  type CaptureSource,
} from "../../mate/screenCapture";
import { useBackHandler } from "../../lib/back";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";

export default function ScreenSharePicker({
  mate,
  onShot,
  onSelect,
  onClose,
}: {
  mate?: Mate;
  /** the pictures taken (all screens: one per screen, the one in use first) */
  onShot?: (files: File[]) => void;
  onSelect?: (source: CaptureSource) => void;
  onClose: () => void;
}) {
  const t = useT();
  const settings = useDevicePreferences().screen;
  const alive = useRef(true);
  const captureId = useRef(`manual-${crypto.randomUUID()}`);
  const [operation, setOperation] = useState<"once" | "ongoing">("once");
  const close = () => {
    alive.current = false;
    void captureBridge()?.cancel(captureId.current);
    onClose();
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      void captureBridge()?.cancel(captureId.current);
    };
  }, []);
  const [list, setList] = useState<CaptureSource[] | null>(null);
  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useBackHandler(true, close);

  const load = () => {
    const b = captureBridge();
    if (!b) return;
    setList(null);
    void b.info().then(setInfo, () => {});
    b.sources({ thumbnails: true, size: 320 }).then(
      (all) => {
        setList(all);
        const many = canShareAllScreens(all);
        const last = settings.all_screens && many ? ALL_SCREENS : settings.source?.id || lastShared();
        setPick((cur) =>
          cur && (all.some((s) => s.id === cur) || (cur === ALL_SCREENS && many))
            ? cur
            : (last === ALL_SCREENS && many ? ALL_SCREENS : "") ||
              all.find((s) => s.id === last)?.id ||
              all.find((s) => s.primary)?.id ||
              all[0]?.id ||
              "",
        );
      },
      () => setList([]),
    );
  };
  useEffect(load, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const share = async (sourceId = pick) => {
    const b = captureBridge();
    if (!b || !sourceId) return;
    setBusy(true);
    setError("");
    const all = sourceId === ALL_SCREENS;
    const selected = all ? allScreensSource() : list?.find((s) => s.id === sourceId);
    if (onSelect && selected && (!onShot || operation === "ongoing")) {
      onSelect(selected);
      return;
    }
    const s = settings;
    try {
      await patchDevicePreferences({
        screen: all ? { source: null, all_screens: true } : { source: selected || null, all_screens: false },
      });
      if (!alive.current) return;
      // Close the source chooser as normal UI; never hide/move the application window.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (!alive.current) return;
      const shot = await b.grab({
        id: captureId.current,
        mateId: mate?.id,
        sourceId,
        maxEdge: s.max_edge,
        hideAvatar: false,
        hideConsole: false,
        multi: all,
      });
      if (!alive.current) return;
      if (!shot.ok) {
        setError(captureError(shot.code));
        return;
      }
      rememberShared(sourceId);
      onShot?.(shotPictures(shot).map((p) => p.file));
    } catch {
      if (alive.current) setError(t("mate.shareFailed"));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const screens = (list ?? []).filter((s) => s.kind === "screen");
  const windows = (list ?? []).filter((s) => s.kind === "window");
  const many = canShareAllScreens(list ?? []);
  const tile = (s: CaptureSource, preview?: ReactNode, label?: string) => (
    <button
      key={s.id}
      onClick={() => setPick(s.id)}
      onDoubleClick={() => {
        setPick(s.id);
        void share(s.id);
      }}
      className={`flex min-w-0 flex-col gap-1 rounded-lg border p-1.5 text-left transition ${
        pick === s.id
          ? "border-accent bg-accent-soft"
          : "border-border hover:border-border-strong bg-surface"
      }`}
      aria-pressed={pick === s.id}
      data-testid="share-source"
      data-source-id={s.id}
    >
      <span className="grid aspect-video w-full place-items-center overflow-hidden rounded-md bg-surface-3">
        {preview ?? (s.thumbnail ? (
          <img
            src={s.thumbnail}
            alt=""
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <Icon name="monitor" size={18} className="text-content-faint" />
        ))}
      </span>
      <span className="truncate text-[11.5px] text-content-dim" title={label ?? s.name}>
        {label ?? (s.kind === "screen"
          ? s.primary
            ? t("mate.shareMainScreen", { name: s.name })
            : s.name
          : s.name)}
      </span>
    </button>
  );
  // every screen side by side (each is its own picture)
  const allTile = () =>
    tile(
      allScreensSource(),
      <span className="flex h-full w-full items-center justify-center gap-0.5 p-0.5" data-testid="share-all-screens">
        {screens.slice(0, 4).map((x) =>
          x.thumbnail ? (
            <img key={x.id} src={x.thumbnail} alt="" className="min-w-0 max-h-full flex-1 object-contain" />
          ) : (
            <Icon key={x.id} name="monitor" size={14} className="text-content-faint" />
          ),
        )}
      </span>,
      t("screen.allScreensCount", { count: screens.length }),
    );

  if (busy)
    return (
      <div
        className="fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-surface-2 px-4 py-2 text-xs shadow-float"
        data-testid="share-picker"
      >
        <Icon name="spinner" size={14} spin />
        <span>{t("screen.capturing")}</span>
        <button
          className="text-danger"
          onClick={close}
          data-testid="share-cancel"
        >
          {t("common.cancel")}
        </button>
      </div>
    );
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] animate-fade-in"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      data-testid="share-picker"
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface-2 shadow-float"
        role="dialog"
        aria-label={t("composer.shareScreen")}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <Icon name="monitor" size={15} className="text-danger" />
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold">
            {t("mate.shareTitle", {
              name: mate?.name || t("screen.thisConversation"),
            })}
          </h2>
          <button
            onClick={load}
            className="btn-ghost !px-2"
            title={t("mate.shareRefresh")}
            aria-label={t("mate.shareRefresh")}
          >
            <Icon name="refresh" size={14} />
          </button>
          <button
            onClick={close}
            className="btn-ghost !px-2"
            aria-label={t("common.close")}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {onShot && onSelect && (
            <div className="flex gap-2" data-testid="share-operation">
              <button
                type="button"
                className={operation === "once" ? "btn-primary" : "btn-ghost"}
                onClick={() => setOperation("once")}
              >
                {t("screen.once")}
              </button>
              <button
                type="button"
                className={
                  operation === "ongoing" ? "btn-primary" : "btn-ghost"
                }
                onClick={() => setOperation("ongoing")}
              >
                {t("screen.start")}
              </button>
            </div>
          )}
          {info &&
            info.permission !== "granted" &&
            info.permission !== "not-determined" && (
              <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">
                <Icon name="warning" size={13} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  {t("mate.sharePermission")}
                </span>
                <button
                  className="shrink-0 underline"
                  onClick={() => void captureBridge()?.openPrivacySettings()}
                >
                  {t("mateSettings.screenOpenPrivacy")}
                </button>
              </div>
            )}
          {info?.wayland && (
            <p className="text-[11.5px] text-content-faint">
              {t("mateSettings.screenWayland")}
            </p>
          )}
          {list === null ? (
            <p className="py-6 text-center text-[12.5px] text-content-faint">
              <Icon name="spinner" size={13} spin /> {t("mate.shareLoading")}
            </p>
          ) : !list.length ? (
            <p className="py-6 text-center text-[12.5px] text-content-faint">
              {t("mate.shareNothing")}
            </p>
          ) : (
            <>
              {!!screens.length && (
                <div>
                  <p className="mb-1.5 text-[11.5px] font-medium text-content-faint">
                    {t("mate.shareScreens")}
                  </p>
                  <div className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3">
                    {many && allTile()}
                    {screens.map((s) => tile(s))}
                  </div>
                  {pick === ALL_SCREENS && (
                    <p className="mt-1.5 text-[11px] text-content-faint">{t("screen.allScreensHint")}</p>
                  )}
                </div>
              )}
              {!!windows.length && (
                <div>
                  <p className="mb-1.5 text-[11.5px] font-medium text-content-faint">
                    {t("mate.shareWindows")}
                  </p>
                  <div className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3">
                    {windows.map((s) => tile(s))}
                  </div>
                </div>
              )}
            </>
          )}
          {error && (
            <p
              className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger"
              data-testid="share-error"
            >
              {error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          <span className="min-w-0 flex-1 basis-full text-[11px] text-content-faint sm:basis-0">
            {t("mate.shareNote")}
          </span>
          <button
            onClick={close}
            className="btn-ghost !py-1.5 text-[12.5px]"
            data-testid="share-cancel"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => void share()}
            disabled={!pick || busy}
            className="btn-primary !py-1.5 text-[12.5px]"
            data-testid="share-go"
          >
            {busy ? (
              <Icon name="spinner" size={13} spin />
            ) : (
              <Icon name="monitor" size={13} />
            )}{" "}
            {t("mate.shareGo")}
          </button>
        </div>
      </div>
    </div>
  );
}
