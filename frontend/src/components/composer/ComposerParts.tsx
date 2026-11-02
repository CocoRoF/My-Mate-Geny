/** Pieces of the composer shared by the Chat view's InputBar and the Mate composer. */
import { useEffect, useRef, type RefObject } from "react";
import { useTouchFirst } from "../../lib/device";
import type { QueuedMessage } from "../../stores/draftStore";
import Icon from "../ui/Icon";
import { useT } from "../../i18n";

export type PickKind = "photo" | "camera" | "file";

/** The + menu: Photos / Camera (touch screens) / Files, and Share screen where the page can (the Mate composer). */
export function AttachMenu({
  onPick,
  onClose,
  onShareScreen,
  className = "bottom-[calc(100%+8px)] left-0",
}: {
  onPick: (kind: PickKind) => void;
  onClose: () => void;
  /** offered only when given (mate/screenCapture.ts canShareScreen: the desktop app or a desktop browser) */
  onShareScreen?: () => void;
  className?: string;
}) {
  const t = useT();
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
          <span className="block font-medium">{t("composer.photos")}</span>
          <span className="block text-[11px] text-content-faint">{t("composer.photosHint")}</span>
        </span>
      </button>
      {touch && (
        <button onClick={() => onPick("camera")} className="flex w-full items-center gap-3 px-3 py-2.5 text-[13px] text-content hover:bg-surface-3" data-testid="attach-camera">
          <span className="grid place-items-center w-7 h-7 rounded-lg bg-cyan/12 text-cyan">
            <Icon name="camera" size={15} />
          </span>
          <span className="text-left">
            <span className="block font-medium">{t("composer.camera")}</span>
            <span className="block text-[11px] text-content-faint">{t("composer.cameraHint")}</span>
          </span>
        </button>
      )}
      <button onClick={() => onPick("file")} className="flex w-full items-center gap-3 px-3 py-2.5 text-[13px] text-content hover:bg-surface-3" data-testid="attach-files">
        <span className="grid place-items-center w-7 h-7 rounded-lg bg-accent/12 text-accent">
          <Icon name="paperclip" size={15} />
        </span>
        <span className="text-left">
          <span className="block font-medium">{t("composer.files")}</span>
          <span className="block text-[11px] text-content-faint">{t("composer.filesHint")}</span>
        </span>
      </button>
      {onShareScreen && (
        <button
          onClick={() => {
            onClose();
            onShareScreen();
          }}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-[13px] text-content hover:bg-surface-3"
          data-testid="attach-share-screen"
        >
          <span className="grid place-items-center w-7 h-7 rounded-lg bg-danger/12 text-danger">
            <Icon name="monitor" size={15} />
          </span>
          <span className="text-left">
            <span className="block font-medium">{t("composer.shareScreen")}</span>
            <span className="block text-[11px] text-content-faint">{t("composer.shareScreenHint")}</span>
          </span>
        </button>
      )}
      {!touch && (
        <div className="border-t border-border/70 px-3 py-2 text-[11px] text-content-faint">
          {t("composer.pasteHint")}
        </div>
      )}
    </div>
  );
}

/** Messages waiting for the running turn to finish. */
export function QueuedList({ queue, onRemove, className = "mb-2" }: { queue: QueuedMessage[]; onRemove: (id: string) => void; className?: string }) {
  const t = useT();
  if (!queue.length) return null;
  return (
    <div className={`space-y-1 ${className}`} data-testid="composer-queue">
      {queue.map((q) => (
        <div key={q.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-1.5 text-[12px]">
          <Icon name="clock" size={12} className="shrink-0 text-content-faint" />
          <span className="text-content-faint shrink-0">{t("composer.queued")}</span>
          <span className="truncate text-content-dim">
            {q.text || t("composer.nAttachments", { count: q.attachments.length })}
            {q.text && q.attachments.length ? ` · ${t("composer.plusFiles", { count: q.attachments.length })}` : ""}
          </span>
          <button onClick={() => onRemove(q.id)} className="ml-auto shrink-0 text-content-faint hover:text-danger touch:-m-2 touch:p-2" title={t("composer.removeFromQueue")}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The hidden pickers behind the + menu. On Android (app WebView and Chrome) `accept="image/*"` opens the photo
 * picker / gallery, `capture` the camera app (the app declares CAMERA; Capacitor asks for it on first use), and
 * no `accept` the system file chooser. */
export function FileInputs({
  photoRef,
  cameraRef,
  fileRef,
  onFiles,
}: {
  photoRef: RefObject<HTMLInputElement>;
  cameraRef?: RefObject<HTMLInputElement>;
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
      {cameraRef && <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={take} data-testid="composer-camera-input" />}
      <input ref={fileRef} type="file" multiple hidden onChange={take} data-testid="composer-file-input" />
    </>
  );
}
