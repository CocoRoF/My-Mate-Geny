import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../../types";
import { downloadUrl } from "../../api/attachments";
import { freshImg } from "./fileMeta";
import Icon from "../ui/Icon";
import { useBackHandler } from "../../lib/back";
import { formatBytes } from "./fileMeta";
import { useT } from "../../i18n";
import { useImageView } from "./useImageView";

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
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={img.name} data-testid="image-lightbox" className="fixed inset-0 z-[100] flex flex-col text-white bg-black/90 backdrop-blur-sm animate-fade-in" onClick={onClose}>
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
        <ZoomImage key={img.id} image={img} onClose={onClose} />
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

/** Each image owns its gesture state; browsing always starts fitted, including cached images. */
function ZoomImage({image,onClose}:{image:Attachment;onClose:()=>void}) {
  const t=useT(),[size,setSize]=useState({width:0,height:0}),[failed,setFailed]=useState(false);
  const zoom=useImageView(size),loaded=!!size.width;
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if(e.key==='+'||e.key==='='){e.preventDefault();zoom.zoom(1.25)}
      else if(e.key==='-'){e.preventDefault();zoom.zoom(1/1.25)}
      else if(e.key==='0'){e.preventDefault();zoom.reset()}
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  });
  return <>
    <div ref={zoom.area} data-testid="image-zoom-area" data-scale={zoom.view.scale} className="absolute inset-x-4 top-0 bottom-16 flex items-center justify-center overflow-hidden select-none" style={{touchAction:'none',cursor:zoom.view.scale>1?(zoom.dragging?'grabbing':'grab'):'default'}}
      onClick={e=>{e.stopPropagation();if(zoom.backdropClick())onClose()}}
      onDoubleClick={e=>{e.stopPropagation();zoom.doubleClick(e.clientX,e.clientY)}}>
      {!loaded&&!failed&&<Icon name="spinner" size={26} spin className="absolute text-white/60"/>}
      {failed&&<span className="text-sm text-white/70">{t('files.imageUnavailable')}</span>}
      <img src={freshImg(image.url)} alt={image.name} draggable={false} data-testid="lightbox-image"
        onLoad={e=>setSize({width:e.currentTarget.naturalWidth,height:e.currentTarget.naturalHeight})} onError={()=>setFailed(true)}
        className="shrink-0 rounded-lg shadow-float" style={{width:zoom.fit.width,height:zoom.fit.height,opacity:loaded?1:0,transform:`translate(${zoom.view.x}px,${zoom.view.y}px) scale(${zoom.view.scale})`}}/>
    </div>
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-xl border border-white/15 bg-black/70 px-2 py-1.5 text-white shadow-float" onClick={e=>e.stopPropagation()}>
      <button className="grid h-9 w-9 place-items-center rounded-lg hover:bg-white/15 disabled:opacity-30" onClick={()=>zoom.zoom(1/1.25)} disabled={!loaded||zoom.view.scale<=1} title={t('files.zoomOut')} aria-label={t('files.zoomOut')} data-testid="image-zoom-out">−</button>
      <button className="min-w-16 rounded-lg px-2 py-2 text-xs tabular-nums hover:bg-white/15" onClick={zoom.reset} title={t('files.zoomReset')} aria-label={t('files.zoomReset')} data-testid="image-zoom-reset">{Math.round(zoom.view.scale*100)}%</button>
      <button className="grid h-9 w-9 place-items-center rounded-lg hover:bg-white/15 disabled:opacity-30" onClick={()=>zoom.zoom(1.25)} disabled={!loaded||zoom.view.scale>=8} title={t('files.zoomIn')} aria-label={t('files.zoomIn')} data-testid="image-zoom-in">+</button>
    </div>
    <span className="sr-only" role="status">{t('files.zoomHelp')}</span>
  </>;
}
