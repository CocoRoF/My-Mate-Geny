import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import Icon from "../ui/Icon";
import { useT } from "../../i18n";

// pdf.js everywhere (not the browser's viewer): the Android WebView has none,
// and sandboxed blob iframes break Chrome's. Legacy build = older WebViews too.
GlobalWorkerOptions.workerSrc = workerUrl;

function Page({ doc, n, scale, ratio }: { doc: PDFDocumentProxy; n: number; scale: number; ratio: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    let alive = true;
    doc.getPage(n).then((page) => {
      if (!alive || !canvas.current) return;
      const vp = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const c = canvas.current;
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      setSize({ w: vp.width, h: vp.height });
      task = page.render({ canvas: c, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      task.promise.catch(() => {});
    });
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [visible, doc, n, scale]);

  const w = size?.w ?? 612 * scale;
  const h = size?.h ?? w * ratio;
  return (
    <div ref={box} className="relative mx-auto mb-4 bg-white shadow-card" style={{ width: w, height: h }}>
      <canvas ref={canvas} style={{ width: w, height: h }} className="block" />
      <span className="absolute -bottom-4 right-0 text-[10px] text-content-faint">{n}</span>
    </div>
  );
}

export default function PdfView({ data }: { data: ArrayBuffer }) {
  const t = useT();
  const outer = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [base, setBase] = useState<{ w: number; ratio: number } | null>(null); // page 1 at scale 1
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [width, setWidth] = useState(800);

  useEffect(() => {
    let alive = true;
    // pdf.js transfers the buffer to its worker: hand it a copy.
    const task = getDocument({ data: new Uint8Array(data.slice(0)) });
    task.promise
      .then(async (d) => {
        if (!alive) return;
        const p1 = await d.getPage(1);
        const vp = p1.getViewport({ scale: 1 });
        setBase({ w: vp.width, ratio: vp.height / vp.width });
        setDoc(d);
      })
      .catch((e) => alive && setError(String(e?.message || e)));
    return () => {
      alive = false;
      task.destroy();
    };
  }, [data]);

  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (error) return <p className="p-6 text-sm text-danger">{t("files.pdfError", { error })}</p>;
  const fitScale = base ? Math.min(2, Math.max(0.3, (width - 32) / base.w)) : 1;
  const scale = zoom === "fit" ? fitScale : zoom;
  const step = (d: number) => setZoom(Math.min(4, Math.max(0.25, Math.round((scale + d) * 100) / 100)));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-1 text-[11.5px] text-content-faint">
        <span>{doc ? t("files.nPages", { count: doc.numPages }) : t("files.pdfLoading")}</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => step(-0.1)} className="btn-ghost px-1.5 py-0.5" title={t("files.zoomOut")}>
            −
          </button>
          <span className="w-11 text-center font-mono">{Math.round(scale * 100)}%</span>
          <button onClick={() => step(0.1)} className="btn-ghost px-1.5 py-0.5" title={t("files.zoomIn")}>
            +
          </button>
          <button
            onClick={() => setZoom("fit")}
            className={`btn-ghost px-1.5 py-0.5 ${zoom === "fit" ? "text-accent" : ""}`}
            title={t("files.fitWidth")}
          >
            <Icon name="arrow-up" size={11} className="rotate-90" /> {t("files.fit")}
          </button>
        </div>
      </div>
      <div ref={outer} className="min-h-0 flex-1 overflow-auto bg-surface-2/40 py-4">
        {doc && base &&
          Array.from({ length: doc.numPages }, (_, i) => (
            <Page key={i} doc={doc} n={i + 1} scale={scale} ratio={base.ratio} />
          ))}
      </div>
    </div>
  );
}
