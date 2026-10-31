/** Pieces of the composer shared by the Chat view's InputBar and the Mate composer. */
import { useEffect, useRef, type RefObject } from "react";
import { useTouchFirst } from "../../lib/device";
import type { QueuedMessage } from "../../stores/draftStore";
import Icon from "../ui/Icon";

/** The + menu: Photos / Files. */
export function AttachMenu({
  onPick,
  onClose,
  className = "bottom-[calc(100%+8px)] left-0",
}: {
  onPick: (kind: "photo" | "file") => void;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const touch = useTouchFirst();
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", h);
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("mousedown", h);
      window.removeEventListener("keydown", k);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className={`absolute z-40 w-60 overflow-hidden rounded-xl border border-border bg-surface-2 shadow-float animate-fade-in ${className}`}
      data-testid="attach-menu"
    >
      <button onClick={() => onPick("photo")} className="flex w-full items-center gap-3 px-3 py-2.5 text-[13px] text-content hover:bg-surface-3" data-testid="attach-photos">
        <span className="grid place-items-center w-7 h-7 rounded-lg bg-violet/12 text-violet">
          <Icon name="image" size={15} />
        </span>
        <span className="text-left">
          <span className="block font-medium">Photos</span>
          <span className="block text-[11px] text-content-faint">PNG, JPG, GIF, WebP…</span>
        </span>
      </button>
      <button onClick={() => onPick("file")} className="flex w-full items-center gap-3 px-3 py-2.5 text-[13px] text-content hover:bg-surface-3" data-testid="attach-files">
        <span className="grid place-items-center w-7 h-7 rounded-lg bg-accent/12 text-accent">
          <Icon name="paperclip" size={15} />
        </span>
        <span className="text-left">
          <span className="block font-medium">Files</span>
          <span className="block text-[11px] text-content-faint">PDF, code, docs, archives…</span>
        </span>
      </button>
      {!touch && (
        <div className="border-t border-border/70 px-3 py-2 text-[11px] text-content-faint">
          You can also paste (Ctrl/⌘+V) or drag & drop.
        </div>
      )}
    </div>
  );
}

/** Messages waiting for the running turn to finish. */
export function QueuedList({ queue, onRemove, className = "mb-2" }: { queue: QueuedMessage[]; onRemove: (id: string) => void; className?: string }) {
  if (!queue.length) return null;
  return (
    <div className={`space-y-1 ${className}`} data-testid="composer-queue">
      {queue.map((q) => (
        <div key={q.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-1.5 text-[12px]">
          <Icon name="clock" size={12} className="shrink-0 text-content-faint" />
          <span className="text-content-faint shrink-0">Queued</span>
          <span className="truncate text-content-dim">
            {q.text || `${q.attachments.length} attachment(s)`}
            {q.text && q.attachments.length ? ` · +${q.attachments.length} file(s)` : ""}
          </span>
          <button onClick={() => onRemove(q.id)} className="ml-auto shrink-0 text-content-faint hover:text-danger touch:-m-2 touch:p-2" title="Remove from queue">
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The hidden pickers behind the + menu. */
export function FileInputs({
  photoRef,
  fileRef,
  onFiles,
}: {
  photoRef: RefObject<HTMLInputElement>;
  fileRef: RefObject<HTMLInputElement>;
  onFiles: (files: File[]) => void;
}) {
  const take = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiles(Array.from(e.target.files || []));
    e.target.value = "";
  };
  return (
    <>
      <input ref={photoRef} type="file" accept="image/*" multiple hidden onChange={take} data-testid="composer-photo-input" />
      <input ref={fileRef} type="file" multiple hidden onChange={take} data-testid="composer-file-input" />
    </>
  );
}
