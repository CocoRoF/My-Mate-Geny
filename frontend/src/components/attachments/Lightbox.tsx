import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../../types";
import { downloadUrl } from "../../api/attachments";
import { freshImg } from "./fileMeta";
import Icon from "../ui/Icon";
import { useBackHandler } from "../../lib/back";
import { formatBytes } from "./fileMeta";
import { useT } from "../../i18n";
import ZoomableImage from "./ZoomableImage";

/** Full-screen image viewer: ←/→ to browse, Esc / backdrop to close. */
export default function Lightbox({
  images,
  start,
  onClose,
}: {
  images: Attachment[];
  start: number;
  onClose: () => void;
}) {
  const t = useT();
  const [i, setI] = useState(start);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const img = images[i];
  const many = images.length > 1;
  useBackHandler(true, onClose);

  const go = useCallback(
    (d: number) => {
      setI((cur) => (cur + d + images.length) % images.length);
    },
    [images.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') || [])].filter(el => el.getClientRects().length);
        const first=items[0],last=items[items.length-1];
        if (e.shiftKey && (document.activeElement===first || document.activeElement===dialog.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement===last) { e.preventDefault(); first?.focus(); }
      }
      else if (e.key === "Escape") onClose();
      else if (many && e.key === "ArrowRight") go(1);
      else if (many && e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [go, many, onClose]);

  if (!img) return null;

  return createPortal(
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={img.name} data-testid="image-lightbox" className="fixed inset-0 top-[var(--window-chrome-height,0px)] z-[100] flex flex-col pt-safe pb-safe text-white bg-black/90 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="flex items-center gap-3 px-4 h-14 shrink-0 text-sm" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 truncate font-medium text-white">{img.name}</span>
        <span className="hidden sm:inline shrink-0 text-xs text-white/60">
          {img.width && img.height ? `${img.width}×${img.height}` : ""}
          {img.size ? `${img.width ? " · " : ""}${formatBytes(img.size)}` : ""}
          {many ? ` · ${i + 1} / ${images.length}` : ""}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <a href={img.url} target="_blank" rel="noreferrer" className="btn-ghost !text-white/75 hover:!text-white" title={t("files.openOriginal")}>
            <Icon name="external" size={16} />
          </a>
          <a href={downloadUrl(img)} className="btn-ghost !text-white/75 hover:!text-white" title={t("common.download")}>
            <Icon name="download" size={16} />
          </a>
          <button onClick={onClose} className="btn-ghost !text-white/75 hover:!text-white" title={t("files.closeEsc")}>
            <Icon name="x" size={18} />
          </button>
        </span>
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden">
        <ZoomableImage key={img.id} url={freshImg(img.url)} name={img.name} onBackdrop={onClose} />
        {many && (
          <>
            <button
              onClick={(e) => (e.stopPropagation(), go(-1))}
              className="absolute left-3 top-1/2 -translate-y-1/2 grid place-items-center w-11 h-11 rounded-full bg-black/60 border border-white/20 text-white hover:bg-black/80"
              title={t("files.previous")}
            >
              <Icon name="chevron-left" size={20} />
            </button>
            <button
              onClick={(e) => (e.stopPropagation(), go(1))}
              className="absolute right-3 top-1/2 -translate-y-1/2 grid place-items-center w-11 h-11 rounded-full bg-black/60 border border-white/20 text-white hover:bg-black/80"
              title={t("files.next")}
            >
              <Icon name="chevron" size={20} />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
