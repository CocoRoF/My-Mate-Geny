import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { useT } from "../../i18n";

/** .docx — docx-preview lays the document out as pages (styles, tables,
 * images, headers/footers). Pages are scaled down to fit narrow screens. */
export default function DocxView({ data }: { data: ArrayBuffer }) {
  const t = useT();
  const outer = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let alive = true;
    el.innerHTML = "";
    setDone(false);
    renderAsync(data, el, undefined, {
      className: "docx",
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      useBase64URL: true,
      experimental: true,
    })
      .then(() => alive && setDone(true))
      .catch((e) => alive && setError(String(e?.message || e)));
    return () => {
      alive = false;
    };
  }, [data]);

  // Fit the widest page to the pane width (never upscale).
  useLayoutEffect(() => {
    const el = outer.current;
    if (!el || !done) return;
    const fit = () => {
      const page = host.current?.querySelector<HTMLElement>("section.docx");
      if (!page) return;
      const natural = page.getBoundingClientRect().width / zoomRef.current; // rect is post-zoom
      const z = Math.min(1, (el.clientWidth - 24) / natural);
      zoomRef.current = z;
      setZoom(z);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [done]);

  if (error) return <p className="p-6 text-sm text-danger">{t("files.docxError", { error })}</p>;
  return (
    <div ref={outer} className="docx-host h-full overflow-auto">
      {!done && <p className="p-6 text-sm text-content-faint">{t("files.docxRendering")}</p>}
      <div ref={host} style={{ zoom } as React.CSSProperties} />
    </div>
  );
}
