import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../../types";
import { downloadUrl } from "../../api/attachments";
import Icon from "../ui/Icon";
import { useBackHandler } from "../../lib/back";
import { formatBytes } from "./fileMeta";

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
  const [i, setI] = useState(start);
  const [loaded, setLoaded] = useState(false);
  const img = images[i];
  const many = images.length > 1;
  useBackHandler(true, onClose);

  const go = useCallback(
    (d: number) => {
      setLoaded(false);
      setI((cur) => (cur + d + images.length) % images.length);
    },
    [images.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
    <div className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="flex items-center gap-3 px-4 h-14 shrink-0 text-sm" onClick={(e) => e.stopPropagation()}>
        <span className="truncate font-medium text-content">{img.name}</span>
        <span className="shrink-0 text-xs text-content-faint">
          {img.width && img.height ? `${img.width}×${img.height}` : ""}
          {img.size ? `${img.width ? " · " : ""}${formatBytes(img.size)}` : ""}
          {many ? ` · ${i + 1} / ${images.length}` : ""}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <a href={img.url} target="_blank" rel="noreferrer" className="btn-ghost" title="Open original in a new tab">
            <Icon name="external" size={16} />
          </a>
          <a href={downloadUrl(img)} className="btn-ghost" title="Download">
            <Icon name="download" size={16} />
          </a>
          <button onClick={onClose} className="btn-ghost" title="Close (Esc)">
            <Icon name="x" size={18} />
          </button>
        </span>
      </div>

      <div className="relative flex-1 min-h-0 grid place-items-center px-4 pb-6">
        {!loaded && <Icon name="spinner" size={26} spin className="absolute text-content-faint" />}
        <img
          key={img.id}
          src={img.url}
          alt={img.name}
          onLoad={() => setLoaded(true)}
          onClick={(e) => e.stopPropagation()}
          className={`max-h-full max-w-full rounded-lg object-contain shadow-float transition-opacity ${loaded ? "opacity-100" : "opacity-0"}`}
        />
        {many && (
          <>
            <button
              onClick={(e) => (e.stopPropagation(), go(-1))}
              className="absolute left-3 top-1/2 -translate-y-1/2 grid place-items-center w-11 h-11 rounded-full bg-surface-2/80 border border-border text-content hover:bg-surface-3"
              title="Previous (←)"
            >
              <Icon name="chevron-left" size={20} />
            </button>
            <button
              onClick={(e) => (e.stopPropagation(), go(1))}
              className="absolute right-3 top-1/2 -translate-y-1/2 grid place-items-center w-11 h-11 rounded-full bg-surface-2/80 border border-border text-content hover:bg-surface-3"
              title="Next (→)"
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
