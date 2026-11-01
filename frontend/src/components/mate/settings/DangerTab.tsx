import { useState } from "react";
import type { Mate } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { ErrorLine, Section } from "./ui";
import { useT } from "../../../i18n";

/** the characters bundled with the app (backend/app/mate/builtin) */
const BUILTINS: Record<string, string> = { estelle: "Estelle", chaerin: "Chaerin", seoa: "Seoa" };

export default function DangerTab({ mate, onDeleted }: { mate: Mate; onDeleted: () => void }) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const mates = useMateStore((s) => s.mates);
  const present = new Set(mates.map((m) => m.builtin).filter(Boolean));
  const missing = Object.entries(BUILTINS)
    .filter(([k]) => !present.has(k))
    .map(([, n]) => n);
  const del = async () => {
    setBusy(true);
    setErr(null);
    try {
      await useMateStore.getState().remove(mate.id);
      onDeleted();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const restore = async () => {
    setErr(null);
    try {
      const n = await useMateStore.getState().restoreBuiltins();
      setRestored(n ? t("mateSettings.dangerRestored", { count: n }) : t("mateSettings.dangerAllHere"));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <>
      <Section
        title={t("mateSettings.dangerDeleteTitle", { name: mate.name })}
        hint={
          <>
            {t("mateSettings.dangerDeleteHint")}
            {mate.builtin && (
              <>
                {" "}
                {t.rich("mateSettings.dangerBuiltinHint", { b: (s) => <b className="text-content-dim">{s}</b>, name: mate.name })}
              </>
            )}
          </>
        }
      >
        <label className="block text-[12px] text-content-dim">
          {t.rich("mateSettings.dangerTypeToConfirm", { b: (s) => <b className="text-content">{s}</b>, name: mate.name })}
          <input className="field mt-1" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="mate-delete-confirm" />
        </label>
        <ErrorLine text={err} />
        <div className="flex justify-end">
          <button
            className="btn bg-danger/15 text-danger hover:bg-danger/25"
            disabled={busy || typed.trim() !== mate.name.trim()}
            onClick={del}
            data-testid="mate-delete"
          >
            {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="trash" size={14} />} {t("mateSettings.dangerDeleteBtn")}
          </button>
        </div>
      </Section>
      <Section title={t("mateSettings.dangerBuiltins")} hint={t("mateSettings.dangerBuiltinsHint")}>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="min-w-0 flex-1 text-[12px] text-content-faint" data-testid="mate-builtins-missing">
            {restored ? <span className="text-success">{restored}</span> : missing.length ? t("mateSettings.dangerMissing", { list: missing.join(", ") }) : t("mateSettings.dangerAllOfThem")}
          </span>
          <button className="btn-soft" onClick={restore} data-testid="mate-restore-builtins-settings">
            <Icon name="rotate" size={13} /> {t("mateSettings.dangerRestoreBtn")}
          </button>
        </div>
      </Section>
    </>
  );
}
