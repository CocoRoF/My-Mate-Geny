/**
 * The quick ways to a new mate, secondary to the Mate Create studio (docs/avatar-create.md §11) — opened from the
 * studio's ⋯ menu: a blank mate with just a name, or a mate pack / content folder imported from the server
 * (`POST /api/mates/import-local`).
 */
import { useEffect, useRef, useState } from "react";
import { importLocal } from "../../api/mates";
import { useBackHandler } from "../../lib/back";
import { useMateStore } from "../../stores/mateStore";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";

export type NewMateTab = "blank" | "import";

export default function NewMateDialog({ open, initialTab = "blank", onClose, onDone }: {
  open: boolean;
  initialTab?: NewMateTab;
  onClose: () => void;
  /** a mate was made: the message to show ("Imported …"; empty for a blank one) */
  onDone: (msg: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<NewMateTab>(initialTab);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useBackHandler(open, onClose);
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);
  useEffect(() => {
    if (open) {
      setErr(null);
      setTimeout(() => input.current?.focus(), 30);
    }
  }, [open, tab]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (tab === "blank") {
        if (!name.trim()) throw new Error(t("mate.needName"));
        await useMateStore.getState().create(name.trim());
        onDone("");
      } else {
        if (!path.trim()) throw new Error(t("mate.needPath"));
        const r = await importLocal({ path: path.trim() });
        const all = r.mates?.length ? r.mates : [r.mate];
        for (const m of all) useMateStore.getState().upsert(m);
        useMateStore.getState().setActive(all[0].id);
        onDone(all.length > 1 ? t("mate.importedMany", { count: all.length, names: all.map((m) => m.name).join(", ") }) : t("mate.importedOne", { name: all[0].name }));
      }
      setName("");
      setPath("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center p-4">
      <div className="absolute inset-0 bg-scrim/55 animate-fade-in" onClick={onClose} />
      <div className="card relative w-full max-w-md p-5 animate-fade-in" role="dialog" aria-modal="true" aria-label={t("studio.quickTitle")} data-testid="mate-new-dialog">
        <h2 className="text-[15px] font-semibold">{t("studio.quickTitle")}</h2>
        <p className="mt-1 text-[12px] text-content-faint">{t("studio.quickHint")}</p>
        <div className="mt-3 flex gap-1" role="tablist">
          <button role="tab" aria-selected={tab === "blank"} className="nav-tab" data-active={tab === "blank"} onClick={() => setTab("blank")} data-testid="mate-new-tab-blank">
            {t("mate.startBlank")}
          </button>
          <button role="tab" aria-selected={tab === "import"} className="nav-tab" data-active={tab === "import"} onClick={() => setTab("import")} data-testid="mate-new-tab-import">
            {t("mate.importFromServer")}
          </button>
        </div>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {tab === "blank" ? (
            <label className="block text-[12.5px] text-content-dim">
              {t("mate.name")}
              <input ref={input} className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("mate.namePlaceholder")} />
            </label>
          ) : (
            <label className="block text-[12.5px] text-content-dim">
              {t("mate.importPathLabel")}
              <input
                ref={input}
                className="field mt-1 font-mono text-[12.5px]"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t("mate.importPathPlaceholder")}
                data-testid="mate-import-path"
              />
              <span className="mt-1 block text-[11.5px] text-content-faint">{t("mate.importPathHint")}</span>
            </label>
          )}
          {err && <p className="text-[12px] text-danger">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn-primary" disabled={busy} data-testid="mate-new-submit">
              {busy && <Icon name="spinner" size={14} spin />} {tab === "blank" ? t("mate.create") : t("mate.import")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
