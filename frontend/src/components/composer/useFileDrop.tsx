/**
 * A conversation area that takes files: drag & drop anywhere over it, and Ctrl/⌘+V anywhere on the page (not just
 * in the composer's text field) attaches clipboard images/files to that conversation's composer (composerStore).
 * Used by the Chat view and the Mate views alike.
 */
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useComposerStore } from "../../stores/composerStore";
import Icon from "../ui/Icon";
import { useT } from "../../i18n";
import { dragHasFiles, filesFromClipboard, pastedIntoField } from "./files";

export function useFileDrop(sid: string | null) {
  const add = useComposerStore((s) => s.add);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    if (!sid) return;
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || pastedIntoField(e.target)) return;
      const files = filesFromClipboard(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        add(sid, files);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [sid, add]);

  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (!sid || !dragHasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!sid || !dragHasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!sid || !dragHasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!sid || !dragHasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      add(sid, Array.from(e.dataTransfer.files || []));
    },
  };
  return { dragging, dropProps };
}

export function DropOverlay({ hint, compact = false }: { hint: string; compact?: boolean }) {
  const t = useT();
  return (
    <div
      className={`pointer-events-none absolute z-50 grid place-items-center rounded-2xl border-2 border-dashed border-accent/70 bg-bg/80 backdrop-blur-sm animate-fade-in ${
        compact ? "inset-1.5" : "inset-3"
      }`}
      data-testid="drop-overlay"
    >
      <div className="text-center">
        <div className={`mx-auto grid place-items-center rounded-2xl bg-accent-soft text-accent ${compact ? "mb-2 h-10 w-10" : "mb-3 h-14 w-14"}`}>
          <Icon name="upload" size={compact ? 20 : 26} />
        </div>
        <div className={`${compact ? "text-sm" : "text-base"} font-semibold text-content`}>{t("composer.dropToAttach")}</div>
        <div className="mt-1 px-4 text-xs text-content-faint">{hint}</div>
      </div>
    </div>
  );
}
