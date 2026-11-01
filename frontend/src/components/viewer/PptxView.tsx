import { useEffect, useState } from "react";
import JSZip from "jszip";
import { tr, useT } from "../../i18n";

interface Slide {
  n: number;
  title: string;
  paragraphs: { text: string; level: number }[];
  images: string[]; // blob URLs
  notes: string;
}

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const xml = (s: string) => new DOMParser().parseFromString(s, "application/xml");
const join = (dir: string, target: string) => {
  const parts = (target.startsWith("/") ? target.slice(1) : `${dir}/${target}`).split("/");
  const out: string[] = [];
  for (const p of parts) p === ".." ? out.pop() : p && p !== "." && out.push(p);
  return out.join("/");
};

async function rels(zip: JSZip, part: string): Promise<Map<string, { type: string; target: string }>> {
  const dir = part.slice(0, part.lastIndexOf("/"));
  const file = zip.file(`${dir}/_rels/${part.split("/").pop()}.rels`);
  const map = new Map<string, { type: string; target: string }>();
  if (!file) return map;
  for (const r of Array.from(xml(await file.async("string")).getElementsByTagName("Relationship"))) {
    map.set(r.getAttribute("Id") || "", {
      type: (r.getAttribute("Type") || "").split("/").pop() || "",
      target: join(dir, r.getAttribute("Target") || ""),
    });
  }
  return map;
}

function textOf(doc: Document): { title: string; paragraphs: { text: string; level: number }[] } {
  let title = "";
  const paragraphs: { text: string; level: number }[] = [];
  for (const sp of Array.from(doc.getElementsByTagNameNS(P, "sp"))) {
    const ph = sp.getElementsByTagNameNS(P, "ph")[0];
    const isTitle = !!ph && /title/i.test(ph.getAttribute("type") || "");
    for (const p of Array.from(sp.getElementsByTagNameNS(A, "p"))) {
      const text = Array.from(p.getElementsByTagNameNS(A, "t"))
        .map((t) => t.textContent || "")
        .join("")
        .trim();
      if (!text) continue;
      if (isTitle && !title) title = text;
      else paragraphs.push({ text, level: Number(p.getElementsByTagNameNS(A, "pPr")[0]?.getAttribute("lvl") || 0) });
    }
  }
  // tables
  for (const tr of Array.from(doc.getElementsByTagNameNS(A, "tr"))) {
    const cells = Array.from(tr.getElementsByTagNameNS(A, "tc")).map((tc) =>
      Array.from(tc.getElementsByTagNameNS(A, "t")).map((t) => t.textContent || "").join(" ").trim(),
    );
    if (cells.some(Boolean)) paragraphs.push({ text: cells.join("  |  "), level: 0 });
  }
  return { title, paragraphs };
}

/** .pptx — no browser renders slides, so: an outline per slide (title, text,
 * tables, pictures, speaker notes) read straight from the package. */
export default function PptxView({ data }: { data: ArrayBuffer }) {
  const t = useT();
  const [slides, setSlides] = useState<Slide[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const urls: string[] = [];
    let alive = true;
    (async () => {
      const zip = await JSZip.loadAsync(data);
      const pres = zip.file("ppt/presentation.xml");
      if (!pres) throw new Error(tr("files.notPptx"));
      const presRels = await rels(zip, "ppt/presentation.xml");
      const order = Array.from(xml(await pres.async("string")).getElementsByTagNameNS(P, "sldId"))
        .map((s) => presRels.get(s.getAttributeNS(R, "id") || "")?.target)
        .filter(Boolean) as string[];
      const out: Slide[] = [];
      for (const [i, part] of order.entries()) {
        const f = zip.file(part);
        if (!f) continue;
        const { title, paragraphs } = textOf(xml(await f.async("string")));
        const images: string[] = [];
        let notes = "";
        for (const r of (await rels(zip, part)).values()) {
          if (r.type === "image") {
            const img = zip.file(r.target);
            const ext = r.target.split(".").pop()?.toLowerCase() || "";
            if (img && ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) {
              const blob = new Blob([await img.async("arraybuffer")], { type: ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}` });
              const url = URL.createObjectURL(blob);
              urls.push(url);
              images.push(url);
            }
          } else if (r.type === "notesSlide") {
            const nf = zip.file(r.target);
            if (nf) {
              const t = textOf(xml(await nf.async("string")));
              notes = t.paragraphs.map((p) => p.text).filter((x) => !/^\d+$/.test(x)).join("\n");
            }
          }
        }
        out.push({ n: i + 1, title, paragraphs, images, notes });
      }
      if (alive) setSlides(out);
    })().catch((e) => alive && setError(String(e?.message || e)));
    return () => {
      alive = false;
      urls.forEach(URL.revokeObjectURL);
    };
  }, [data]);

  if (error) return <p className="p-6 text-sm text-danger">{t("files.pptxError", { error })}</p>;
  if (!slides) return <p className="p-6 text-sm text-content-faint">{t("files.pptxReading")}</p>;
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-5">
        <p className="text-[11.5px] text-content-faint">
          {t("files.slidesOutline", { count: slides.length })}
        </p>
        {slides.map((s) => (
          <section key={s.n} className="rounded-xl border border-border bg-surface/60 p-4 shadow-card">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="pill bg-surface-3 font-mono text-content-faint">{s.n}</span>
              <h3 className="text-[15px] font-semibold text-content">{s.title || <span className="text-content-faint">{t("files.untitled")}</span>}</h3>
            </div>
            {s.paragraphs.length > 0 && (
              <ul className="space-y-1 text-[13px] text-content/85">
                {s.paragraphs.map((p, i) => (
                  <li key={i} style={{ marginLeft: p.level * 16 }} className="flex gap-2">
                    <span className="text-content-faint">•</span>
                    <span className="whitespace-pre-wrap">{p.text}</span>
                  </li>
                ))}
              </ul>
            )}
            {s.images.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {s.images.map((u) => (
                  <img key={u} src={u} alt="" loading="lazy" className="max-h-56 max-w-full rounded-lg border border-border bg-white object-contain" />
                ))}
              </div>
            )}
            {s.notes && (
              <p className="mt-3 whitespace-pre-wrap border-t border-border/60 pt-2 text-[12px] text-content-faint">
                <span className="font-medium text-content-dim">{t("files.notes")} · </span>
                {s.notes}
              </p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
