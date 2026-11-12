/**
 * A profile picture's crop dialog — a mate's icon (her Profile tab) and the user's (Settings → 계정), the same one: a
 * square of a picture, seen round as the app shows it. The picture is her avatar's (starting on her face) or one picked
 * from this device; a drag (or the arrow keys) moves it, the slider (or the wheel) zooms. Saving draws the square at
 * ICON_PX and hands it over as WebP (PNG where the browser writes no WebP); the server keeps it (app/mate/files.py
 * make_icon). Esc or a press outside closes it, nothing saved.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { centreCrop, clampCrop, cropBoxStyle, faceCrop, maxZoom, panCrop, zoomCrop, zoomOf, type Crop } from "../../lib/iconCrop";
import { useT } from "../../i18n";
import { Segmented } from "../mate/settings/ui";
import Icon from "./Icon";

/** the side of the saved square */
export const ICON_PX = 256;

/** a picture to crop: where it is, and where to start (her face) */
export interface IconPicture {
  src: string;
  /** the rig's face (centre x, centre y, height in fractions of the picture), when it knows */
  face?: number[] | null;
  /** start on the middle (a picture that is already a portrait) rather than the top */
  centre?: boolean;
}

type Loaded = { el: HTMLImageElement; w: number; h: number; src: string };

function startCrop(p: IconPicture | null, w: number, h: number): Crop {
  if (!p || p.centre) return centreCrop(w, h);
  return faceCrop(w, h, p.face);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** the crop as a small square picture (WebP, else PNG) */
async function draw(img: Loaded, crop: Crop): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ICON_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas"); // (no 2D canvas: shown as the error)
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img.el, crop.x, crop.y, crop.size, crop.size, 0, 0, ICON_PX, ICON_PX);
  const webp = await toBlob(canvas, "image/webp", 0.92);
  if (webp && webp.type === "image/webp") return webp;
  const png = await toBlob(canvas, "image/png");
  if (!png) throw new Error("canvas");
  return png;
}

export default function IconCropDialog({
  title,
  avatar,
  avatarLabel,
  onSave,
  onReset,
  resetLabel,
  onClose,
  testId = "icon-crop",
}: {
  title: string;
  /** her avatar's picture: one of the two sources (none: only a picture of one's own) */
  avatar?: IconPicture | null;
  /** what the avatar source is called ("Her avatar") */
  avatarLabel?: string;
  onSave: (picture: Blob) => Promise<unknown>;
  /** back to the default (her face, the initial); shown when given */
  onReset?: () => Promise<unknown>;
  resetLabel?: string;
  onClose: () => void;
  testId?: string;
}) {
  const t = useT();
  const [source, setSource] = useState<"avatar" | "upload">(avatar ? "avatar" : "upload");
  const [upload, setUpload] = useState<string | null>(null);
  const [img, setImg] = useState<Loaded | null>(null);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, size: 0 });
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; crop: Crop; side: number } | null>(null);
  const pressedOutside = useRef(false);

  const src = source === "avatar" ? avatar?.src ?? null : upload;
  useEffect(() => {
    setImg(null);
    setErr(null);
    if (!src) return;
    let alive = true;
    const el = new Image();
    el.decoding = "async";
    el.onload = () => {
      if (!alive) return;
      const w = el.naturalWidth;
      const h = el.naturalHeight;
      if (!w || !h) return setErr(t("profile.cropLoadFailed"));
      setImg({ el, w, h, src });
      setCrop(startCrop(source === "avatar" ? avatar ?? null : null, w, h));
    };
    el.onerror = () => alive && setErr(t("profile.cropLoadFailed"));
    el.src = src;
    return () => {
      alive = false;
    };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps
  // (the picked picture's URL lives as long as it is the one)
  useEffect(() => () => void (upload && URL.revokeObjectURL(upload)), [upload]);

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) return setErr(t("profile.cropNotPicture"));
    setUpload(URL.createObjectURL(f));
    setSource("upload");
  };

  // Esc closes (capture: before the panel under it closes with it); focus goes back where it was
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, []);

  // the wheel zooms at the pointer (not passive: the dialog must not scroll under it)
  useEffect(() => {
    const el = view.current;
    if (!el || !img) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      setCrop((c) => zoomCrop(c, zoomOf(c, img.w, img.h) * Math.exp(-e.deltaY * 0.0015), img.w, img.h, fx, fy));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [img]);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!img || e.button > 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, crop, side: e.currentTarget.getBoundingClientRect().width };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !img) return;
    setCrop(panCrop(d.crop, e.clientX - d.x, e.clientY - d.y, d.side, img.w, img.h));
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!img) return;
    const step = crop.size * (e.shiftKey ? 0.1 : 0.03);
    const by: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (by[e.key]) {
      e.preventDefault();
      setCrop(clampCrop({ ...crop, x: crop.x + by[e.key][0], y: crop.y + by[e.key][1] }, img.w, img.h));
    } else if (e.key === "+" || e.key === "=" || e.key === "-") {
      e.preventDefault();
      setCrop(zoomCrop(crop, zoomOf(crop, img.w, img.h) * (e.key === "-" ? 1 / 1.1 : 1.1), img.w, img.h));
    }
  };

  const save = async () => {
    if (!img || busy) return;
    setBusy("save");
    setErr(null);
    try {
      await onSave(await draw(img, crop));
      onClose();
    } catch (e) {
      setErr((e as Error).message || t("common.couldNotSave"));
    } finally {
      setBusy(null);
    }
  };
  const reset = async () => {
    if (!onReset || busy) return;
    setBusy("reset");
    setErr(null);
    try {
      await onReset();
      onClose();
    } catch (e) {
      setErr((e as Error).message || t("common.couldNotSave"));
    } finally {
      setBusy(null);
    }
  };

  const shown = (cls: string) =>
    img && crop.size > 0 ? (
      <img src={img.src} alt="" draggable={false} className={`pointer-events-none absolute max-w-none select-none ${cls}`} style={cropBoxStyle(crop, img.w, img.h)} />
    ) : null;
  const zoom = img ? zoomOf(crop, img.w, img.h) : 1;

  return createPortal(
    <div
      className="fixed inset-0 top-[var(--window-chrome-height,0px)] z-[115] flex items-end justify-center bg-scrim/60 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm animate-fade-in sm:items-center sm:p-4"
      onPointerDown={(e) => (pressedOutside.current = e.target === e.currentTarget)}
      onClick={(e) => e.target === e.currentTarget && pressedOutside.current && onClose()}
      data-testid={testId}
    >
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`} className="flex max-h-full w-full max-w-sm flex-col gap-3 overflow-y-auto rounded-2xl border border-border bg-surface-2 p-5 shadow-xl outline-none">
        <div className="flex items-center gap-2">
          <h2 id={`${testId}-title`} className="min-w-0 flex-1 truncate text-[15px] font-semibold">
            {title}
          </h2>
          <button type="button" className="btn-ghost !px-2" onClick={onClose} aria-label={t("common.close")} data-testid={`${testId}-close`}>
            <Icon name="x" size={15} />
          </button>
        </div>
        {avatar && (
          <Segmented
            value={source}
            onChange={(v) => (v === "upload" && !upload ? file.current?.click() : setSource(v))}
            options={[
              { id: "avatar", label: avatarLabel ?? t("profile.cropFromAvatar") },
              { id: "upload", label: t("profile.cropFromFile") },
            ]}
            testId={`${testId}-source`}
          />
        )}
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ""))} data-testid={`${testId}-file`} />
        {src ? (
          <>
            <div
              ref={view}
              className="relative mx-auto aspect-square w-full max-w-[260px] cursor-grab touch-none overflow-hidden rounded-xl bg-surface-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70 active:cursor-grabbing"
              tabIndex={0}
              role="img"
              aria-label={t("profile.cropArea")}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onKeyDown={key}
              data-testid={`${testId}-area`}
            >
              {shown("")}
              {/* the round icon it makes, the rest of the square dimmed */}
              <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_999px_rgb(0_0_0/0.5)] ring-2 ring-white/80" />
              {!img && !err && (
                <div className="absolute inset-0 grid place-items-center text-content-faint">
                  <Icon name="spinner" size={18} spin />
                </div>
              )}
            </div>
            <p className="text-center text-[11.5px] text-content-faint">{t("profile.cropHint")}</p>
            <label className="flex items-center gap-2 text-[12px] text-content-dim">
              <Icon name="image" size={13} className="shrink-0 text-content-faint" />
              <span className="shrink-0">{t("profile.cropZoom")}</span>
              <input
                type="range"
                min={1}
                max={img ? maxZoom(img.w, img.h) : 1}
                step={0.01}
                value={zoom}
                disabled={!img}
                onChange={(e) => img && setCrop(zoomCrop(crop, Number(e.target.value), img.w, img.h))}
                className="min-w-0 flex-1 accent-accent"
                data-testid={`${testId}-zoom`}
              />
            </label>
            <div className="flex items-center justify-center gap-3" aria-label={t("profile.cropPreview")}>
              <span className="relative h-16 w-16 overflow-hidden rounded-full border border-border bg-surface-3" data-testid={`${testId}-preview`}>
                {shown("")}
              </span>
              <span className="relative h-8 w-8 overflow-hidden rounded-full border border-border bg-surface-3">{shown("")}</span>
              <span className="relative h-6 w-6 overflow-hidden rounded-full border border-border bg-surface-3">{shown("")}</span>
            </div>
            {source === "upload" && (
              <button type="button" className="btn-ghost mx-auto !py-1 text-[12px]" onClick={() => file.current?.click()}>
                <Icon name="upload" size={13} /> {t("profile.cropOtherFile")}
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="grid aspect-square w-full max-w-[260px] place-items-center self-center rounded-xl border border-dashed border-border-strong text-content-dim hover:bg-surface-3/50 hover:text-content"
            onClick={() => file.current?.click()}
            data-testid={`${testId}-pick`}
          >
            <span className="flex flex-col items-center gap-2 text-[13px]">
              <Icon name="upload" size={20} />
              {t("profile.cropPick")}
              <span className="text-[11px] text-content-faint">{t("profile.cropPickHint")}</span>
            </span>
          </button>
        )}
        {err && <p className="text-[12px] text-danger break-words" role="alert">{err}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {onReset && (
            <button type="button" className="btn-ghost mr-auto !px-2 text-[12.5px] text-content-dim" onClick={() => void reset()} disabled={!!busy} data-testid={`${testId}-reset`}>
              {busy === "reset" ? <Icon name="spinner" size={13} spin /> : <Icon name="rotate" size={13} />} {resetLabel ?? t("common.reset")}
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={onClose} disabled={!!busy}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={!img || !!busy} data-testid={`${testId}-save`}>
            {busy === "save" && <Icon name="spinner" size={14} spin />} {t("common.save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
