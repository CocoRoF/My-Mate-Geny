import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import FileTree from "../../workspaces/FileTree";
import Icon from "../../ui/Icon";
import { useBackHandler } from "../../../lib/back";
import { useT } from "../../../i18n";

/** Modal folder browser (local host or the session's SSH host). */
export default function FolderPicker({
  connectionId,
  hostLabel,
  initialPath,
  exclude,
  onAdd,
  onClose,
}: {
  connectionId: string | null;
  hostLabel: string;
  initialPath: string;
  exclude: string[];
  onAdd: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useBackHandler(true, onClose);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const add = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await onAdd(selected);
      onClose();
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const dup = selected ? exclude.includes(selected.replace(/\/+$/, "")) : false;

  // Portal: the panel uses backdrop-filter, which would otherwise become the
  // containing block of this fixed overlay and clip it to the panel.
  return createPortal(
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-xl card p-5 animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 mb-1">
          <Icon name="folder" size={18} className="text-accent" />
          <h3 className="text-base font-semibold flex-1">{t("workspace.addFolderTitle")}</h3>
          <button onClick={onClose} className="text-content-faint hover:text-content" aria-label={t("common.close")}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <p className="text-[12.5px] text-content-dim mb-3">
          {t.rich("workspace.addFolderHint", { b: (s) => <b>{s}</b>, host: hostLabel })}
        </p>
        <FileTree connectionId={connectionId} initialPath={initialPath} onPick={setSelected} selected={selected} />
        <div className="mt-3 flex items-center gap-2">
          <span className="min-w-0 truncate font-mono text-[12px] text-content-dim">
            {selected || t("workspace.navigateHint")}
          </span>
          <button onClick={onClose} className="btn-ghost ml-auto">
            {t("common.cancel")}
          </button>
          <button onClick={add} disabled={!selected || busy || dup} className="btn-primary">
            {busy ? <Icon name="spinner" size={15} spin /> : <Icon name="plus" size={15} />} {dup ? t("workspace.alreadyAdded") : t("workspace.addFolder")}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    </div>,
    document.body,
  );
}
