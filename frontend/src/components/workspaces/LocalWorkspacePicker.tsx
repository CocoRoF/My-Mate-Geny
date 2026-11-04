import { useRef, useState } from "react";
import { useT } from "../../i18n";
import { folderBridge } from "../../lib/localFolder";
import Icon from "../ui/Icon";

/** A real working folder, chosen here when creating a chat, after provider setup. */
export default function LocalWorkspacePicker({ path, onChange, onError }: {
  path: string | null;
  onChange: (path: string) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const picking = useRef(false);
  const name = path?.split(/[\\/]/).filter(Boolean).pop() || path;

  const pick = async () => {
    if (picking.current) return;
    picking.current = true;
    setBusy(true);
    onError("");
    try {
      const bridge = folderBridge();
      if (!bridge) throw new Error(t("setup.folderNative"));
      const result = await bridge.pick();
      if (result) {
        try { onChange(result.path); }
        finally { await bridge.release(result.path); }
      }
    } catch (e: any) {
      onError(String(e.message || e));
    } finally {
      picking.current = false;
      setBusy(false);
    }
  };

  return <div className="mt-5" data-testid="local-workspace-picker">
    <p className="mb-1.5 text-[11px] font-medium tracking-wider text-content-faint">{t("setup.workspace")}</p>
    <button type="button" onClick={() => void pick()} disabled={busy} aria-busy={busy}
      aria-label={path ? t("setup.changeFolder") : t("setup.pickFolder")}
      className="group flex min-h-20 w-full items-center gap-3 rounded-xl border border-border-strong bg-surface/60 p-3.5 text-left transition hover:border-accent/60 hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-2 disabled:cursor-wait disabled:opacity-60">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
        <Icon name={busy ? "spinner" : "folder-open"} size={23} spin={busy}/>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-all text-sm font-medium text-content">{name || t("setup.pickFolder")}</span>
        <span className={`mt-1 block text-xs text-content-muted ${path ? "break-all" : ""}`} title={path || undefined}>{path || t("setup.folderHint")}</span>
      </span>
      {path ? <span className="shrink-0 rounded-md bg-accent-soft px-2 py-1 text-xs font-medium text-accent">{t("setup.changeFolderShort")}</span>
        : <Icon name="chevron" size={18} className="shrink-0 text-content-faint group-hover:text-accent"/>}
    </button>
  </div>;
}
