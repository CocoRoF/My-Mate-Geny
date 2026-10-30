import { useState } from "react";
import type { Attachment } from "../../types";
import { downloadUrl } from "../../api/attachments";
import Icon from "../ui/Icon";
import Lightbox from "./Lightbox";
import { extOf, fileVisual, formatBytes, opensInline } from "./fileMeta";

/** Attachments shown in a sent message: image grid + file cards. */
export default function MessageAttachments({
  attachments,
  align = "end",
}: {
  attachments: Attachment[];
  align?: "start" | "end";
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind !== "image");
  if (!attachments.length) return null;

  const single = images.length === 1;
  const cols = images.length === 2 || images.length === 4 ? "grid-cols-2" : "grid-cols-3";

  return (
    <div className={`flex flex-col gap-1.5 ${align === "end" ? "items-end" : "items-start"}`}>
      {images.length > 0 &&
        (single ? (
          <button
            onClick={() => setViewing(0)}
            className="group relative overflow-hidden rounded-xl border border-border bg-surface-2"
            title={images[0].name}
          >
            <img
              src={images[0].preview_url}
              alt={images[0].name}
              loading="lazy"
              style={
                images[0].width && images[0].height
                  ? { aspectRatio: `${images[0].width} / ${images[0].height}` }
                  : undefined
              }
              className="block max-h-[320px] max-w-[min(360px,70vw)] object-contain transition group-hover:brightness-110"
            />
          </button>
        ) : (
          <div className={`grid ${cols} gap-1.5`}>
            {images.map((img, i) => (
              <button
                key={img.id}
                onClick={() => setViewing(i)}
                className="group relative w-[112px] h-[112px] sm:w-[128px] sm:h-[128px] overflow-hidden rounded-xl border border-border bg-surface-2"
                title={img.name}
              >
                <img
                  src={img.preview_url}
                  alt={img.name}
                  loading="lazy"
                  className="h-full w-full object-cover transition group-hover:scale-[1.03] group-hover:brightness-110"
                />
              </button>
            ))}
          </div>
        ))}

      {files.map((f) => {
        const { icon, tone } = fileVisual(f.name, f.mime);
        const inline = opensInline(f.mime);
        return (
          <div
            key={f.id}
            className="flex items-center gap-2.5 w-[min(300px,75vw)] rounded-xl border border-border bg-surface-2/80 p-2 pr-1.5"
          >
            <span className={`grid place-items-center w-9 h-9 shrink-0 rounded-lg ${tone}`}>
              <Icon name={icon} size={17} />
            </span>
            <a
              href={inline ? f.url : downloadUrl(f)}
              target={inline ? "_blank" : undefined}
              rel="noreferrer"
              className="min-w-0 flex-1 text-left"
              title={inline ? `Open ${f.name}` : `Download ${f.name}`}
            >
              <div className="truncate text-[13px] font-medium text-content hover:underline">{f.name}</div>
              <div className="text-[11px] text-content-faint">
                {[extOf(f.name), formatBytes(f.size)].filter(Boolean).join(" · ")}
              </div>
            </a>
            <a href={downloadUrl(f)} className="btn-ghost px-2 py-1.5 shrink-0" title="Download">
              <Icon name="download" size={15} />
            </a>
          </div>
        );
      })}

      {viewing !== null && <Lightbox images={images} start={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
