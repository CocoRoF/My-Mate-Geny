import { useState } from "react";
import type { Attachment } from "../../types";
import { downloadUrl } from "../../api/attachments";
import Icon from "../ui/Icon";
import Lightbox from "./Lightbox";
import { extOf, fileVisual, formatBytes, freshImg, opensInline } from "./fileMeta";

/** An image that can't load (lost on the server): a clear tile instead of a broken icon. */
function Unavailable({ name, big }: { name: string; big?: boolean }) {
  return (
    <span
      className={`flex flex-col items-center justify-center gap-1 px-2 text-center text-[10.5px] text-content-faint ${
        big ? "h-[120px] w-[220px]" : "h-full w-full"
      }`}
    >
      <Icon name="image" size={18} />
      <span className="line-clamp-2 break-all">{name}</span>
      <span className="text-content-faint/70">image unavailable</span>
    </span>
  );
}

/** Attachments shown in a sent message: image grid + file cards. */
export default function MessageAttachments({
  attachments,
  align = "end",
}: {
  attachments: Attachment[];
  align?: "start" | "end";
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  const [broken, setBroken] = useState<Record<string, true>>({});
  const fail = (id: string) => setBroken((b) => (b[id] ? b : { ...b, [id]: true }));
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
            {broken[images[0].id] ? (
              <Unavailable name={images[0].name} big />
            ) : (
              <img
                src={freshImg(images[0].preview_url)}
                alt={images[0].name}
                loading="lazy"
                onError={() => fail(images[0].id)}
                style={
                  images[0].width && images[0].height
                    ? { aspectRatio: `${images[0].width} / ${images[0].height}` }
                    : undefined
                }
                className="block max-h-[320px] max-w-[min(360px,70vw)] object-contain transition group-hover:brightness-110"
              />
            )}
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
                {broken[img.id] ? (
                  <Unavailable name={img.name} />
                ) : (
                  <img
                    src={freshImg(img.preview_url)}
                    alt={img.name}
                    loading="lazy"
                    onError={() => fail(img.id)}
                    className="h-full w-full object-cover transition group-hover:scale-[1.03] group-hover:brightness-110"
                  />
                )}
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
