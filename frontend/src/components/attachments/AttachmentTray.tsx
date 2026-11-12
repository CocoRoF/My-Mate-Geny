import { useState } from "react";
import { useComposerStore, type PendingFile } from "../../stores/composerStore";
import Icon from "../ui/Icon";
import Lightbox from "./Lightbox";
import { useT } from "../../i18n";
import { extOf, fileVisual, formatBytes } from "./fileMeta";
import ScrollRow from "../ui/ScrollRow";

function Ring({ value }: { value: number }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" className="-rotate-90">
      <circle cx="17" cy="17" r={r} fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="3" />
      <circle
        cx="17" cy="17" r={r} fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.04, value))}
        className="transition-[stroke-dashoffset] duration-200"
      />
    </svg>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      onClick={onClick}
      title={t("common.remove")}
      aria-label={t("common.remove")}
      className="absolute -right-1.5 -top-1.5 z-10 grid place-items-center w-5 h-5 rounded-full bg-surface-3 border border-border-strong text-content-dim hover:text-content hover:bg-danger/80 transition sm:opacity-0 group-hover:opacity-100 focus:opacity-100"
    >
      <Icon name="x" size={11} />
    </button>
  );
}

function ImageTile({ it, onOpen }: { it: PendingFile; onOpen: () => void }) {
  const remove = useComposerStore((s) => s.remove);
  const retry = useComposerStore((s) => s.retry);
  // The local preview first (instant); if it can't be read (an Android picker's content URI can refuse a second
  // read), the server's thumbnail once the upload is in; else an icon.
  const [failed, setFailed] = useState<string[]>([]);
  const src = [it.previewUrl, it.attachment?.preview_url].find((u) => u && !failed.includes(u));
  return (
    <div className="group relative shrink-0" title={it.error ? `${it.name} — ${it.error}` : it.name}>
      <button
        onClick={it.status === "done" ? onOpen : it.status === "error" ? () => retry(it.localId) : undefined}
        className={`relative block w-16 h-16 overflow-hidden rounded-xl border bg-surface-3 ${
          it.status === "error" ? "border-danger/60" : "border-border"
        }`}
      >
        {src ? (
          <img src={src} alt="" onError={() => setFailed((f) => [...f, src])} className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full w-full place-items-center text-content-faint">
            <Icon name="image" size={20} />
          </span>
        )}
        {it.status === "uploading" && (
          <span className="absolute inset-0 grid place-items-center bg-black/45">
            <Ring value={it.progress} />
          </span>
        )}
        {it.status === "error" && (
          <span className="absolute inset-0 grid place-items-center bg-danger/35 text-white">
            <Icon name="refresh" size={16} />
          </span>
        )}
      </button>
      <RemoveButton onClick={() => remove(it.localId)} />
    </div>
  );
}

function FileChip({ it }: { it: PendingFile }) {
  const remove = useComposerStore((s) => s.remove);
  const retry = useComposerStore((s) => s.retry);
  const t = useT();
  const { icon, tone } = fileVisual(it.name, it.mime);
  return (
    <div className="group relative shrink-0" title={it.error ? `${it.name} — ${it.error}` : it.name}>
      <div
        className={`relative flex items-center gap-2.5 h-16 w-[210px] overflow-hidden rounded-xl border bg-surface-3/70 px-2.5 ${
          it.status === "error" ? "border-danger/60" : "border-border"
        }`}
      >
        <span className={`grid place-items-center w-9 h-9 shrink-0 rounded-lg ${tone}`}>
          <Icon name={icon} size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-content">{it.name}</div>
          {it.status === "error" ? (
            <button onClick={() => retry(it.localId)} className="flex items-center gap-1 text-[11px] text-danger truncate max-w-full">
              <Icon name="alert-circle" size={11} /> <span className="truncate">{it.error}</span>
            </button>
          ) : (
            <div className="text-[11px] text-content-faint">
              {it.status === "uploading"
                ? t("files.uploadingPct", { pct: Math.round(it.progress * 100) })
                : [extOf(it.name), formatBytes(it.size)].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
        {it.status === "uploading" && (
          <span className="absolute inset-x-0 bottom-0 h-[3px] bg-surface">
            <span className="block h-full bg-accent transition-[width] duration-200" style={{ width: `${Math.max(4, it.progress * 100)}%` }} />
          </span>
        )}
      </div>
      <RemoveButton onClick={() => remove(it.localId)} />
    </div>
  );
}

/** Pending attachments inside the composer box. */
export default function AttachmentTray({ items }: { items: PendingFile[] }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const doneImages = items.filter((i) => i.kind === "image" && i.status === "done" && i.attachment);
  if (!items.length) return null;
  return (
    <>
      <ScrollRow className="gap-2.5 px-1.5 pb-1.5 pt-2.5">
        {items.map((it) =>
          it.kind === "image" ? (
            <ImageTile
              key={it.localId}
              it={it}
              onOpen={() => setViewing(doneImages.findIndex((d) => d.localId === it.localId))}
            />
          ) : (
            <FileChip key={it.localId} it={it} />
          ),
        )}
      </ScrollRow>
      {viewing !== null && viewing >= 0 && (
        <Lightbox images={doneImages.map((d) => d.attachment!)} start={viewing} onClose={() => setViewing(null)} />
      )}
    </>
  );
}
