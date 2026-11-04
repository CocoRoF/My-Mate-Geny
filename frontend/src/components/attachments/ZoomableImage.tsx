import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";
import { useImageView } from "./useImageView";

/** The same image canvas for attachment dialogs and filesystem tabs. */
export default function ZoomableImage({
  url, name, onBackdrop, embedded = false,
}: {
  url: string;
  name: string;
  onBackdrop?: () => void;
  embedded?: boolean;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const zoom = useImageView(size);
  const loaded = !!size.width;
  const actual = loaded && Math.abs(zoom.view.scale - zoom.actualScale) < 0.001;
  const handleKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.("input,textarea,[contenteditable=true]")) return;
    if (e.key === "+" || e.key === "=") zoom.zoom(1.25);
    else if (e.key === "-") zoom.zoom(1 / 1.25);
    else if (e.key === "0") zoom.reset();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  useEffect(() => {
    if (embedded) return; // File tabs handle keys only while their canvas/controls have focus.
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  return (
    <div ref={root} className="relative h-full w-full min-h-0 outline-none" tabIndex={embedded ? 0 : undefined}
      role={embedded ? "region" : undefined} aria-label={embedded ? t("files.zoomHelp") : undefined}
      data-testid={embedded ? "file-image-viewer" : undefined}
      onKeyDown={e => { if (embedded) handleKey(e.nativeEvent); }}
      onPointerDownCapture={e => {
        if (embedded && !(e.target as HTMLElement).closest("button,a")) root.current?.focus({ preventScroll: true });
      }}>
      <div ref={zoom.area} data-testid="image-zoom-area" data-scale={zoom.view.scale}
        className="absolute inset-x-4 top-0 bottom-16 flex items-center justify-center overflow-hidden select-none"
        style={{ touchAction: "none", cursor: zoom.view.scale > 1 ? (zoom.dragging ? "grabbing" : "grab") : "default" }}
        onClick={e => { e.stopPropagation(); if (zoom.backdropClick()) onBackdrop?.(); }}
        onDoubleClick={e => { e.stopPropagation(); zoom.doubleClick(e.clientX, e.clientY); }}>
        {!loaded && !failed && <Icon name="spinner" size={26} spin className={`absolute ${embedded ? "text-content-faint" : "text-white/60"}`} />}
        {failed && <span className={`text-sm ${embedded ? "text-content-faint" : "text-white/70"}`}>{t("files.imageUnavailable")}</span>}
        <img src={url} alt={name} draggable={false} data-testid="lightbox-image"
          onLoad={e => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
          className={`shrink-0 ${embedded ? "" : "rounded-lg shadow-float"}`}
          style={{ width: zoom.fit.width, height: zoom.fit.height, opacity: loaded ? 1 : 0,
            transform: `translate(${zoom.view.x}px,${zoom.view.y}px) scale(${zoom.view.scale})` }} />
      </div>
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-xl border border-white/15 bg-black/80 px-2 py-1.5 text-white shadow-float"
        onClick={e => e.stopPropagation()}>
        {embedded && loaded && <span className="whitespace-nowrap px-1 text-[10px] text-white/60">{size.width}×{size.height}</span>}
        <button className="grid h-9 w-9 place-items-center rounded-lg hover:bg-white/15 disabled:opacity-30"
          onClick={() => zoom.zoom(1 / 1.25)} disabled={!loaded || zoom.view.scale <= 1}
          title={t("files.zoomOut")} aria-label={t("files.zoomOut")} data-testid="image-zoom-out">−</button>
        <button className="min-w-16 rounded-lg px-2 py-2 text-xs tabular-nums hover:bg-white/15"
          onClick={zoom.reset} title={t("files.zoomReset")} aria-label={t("files.zoomReset")} data-testid="image-zoom-reset">
          {Math.round(zoom.view.scale * 100)}%
        </button>
        {embedded && <button className="rounded-lg px-2 py-2 text-xs hover:bg-white/15 disabled:opacity-30"
          disabled={!loaded} aria-pressed={actual} data-testid="image-actual-size"
          title={t(actual ? "files.fitToWindow" : "files.actualSize")}
          aria-label={t(actual ? "files.fitToWindow" : "files.actualSize")}
          onClick={() => actual ? zoom.reset() : zoom.actualSize()}>1:1</button>}
        <button className="grid h-9 w-9 place-items-center rounded-lg hover:bg-white/15 disabled:opacity-30"
          onClick={() => zoom.zoom(1.25)} disabled={!loaded || zoom.view.scale >= zoom.maxScale}
          title={t("files.zoomIn")} aria-label={t("files.zoomIn")} data-testid="image-zoom-in">+</button>
      </div>
      <span className="sr-only" role="status">{t("files.zoomHelp")}</span>
    </div>
  );
}
