import { useState } from "react";
import { wipeMateMemory, type Mate } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { ErrorLine, Section } from "./ui";
import { useT } from "../../../i18n";

/** [Reset her memory]: as if they had never talked. She stays who she is. (Mate settings → 관계와 기억) */
export function WipeMemory({ mate }: { mate: Mate }) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const wipe = async () => {
    setBusy(true);
    setErr(null);
    setDone(false);
    try {
      useMateStore.getState().upsert(await wipeMateMemory(mate.id, typed));
      setTyped("");
      setDone(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("mateSettings.dangerWipeTitle", { name: mate.name })} hint={t("mateSettings.dangerWipeHint")} testId="mate-wipe">
      <label className="block text-[12px] text-content-dim">
        {t.rich("mateSettings.dangerTypeToConfirm", { b: (s) => <b className="text-content">{s}</b>, name: mate.name })}
        <input
          className="field mt-1"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setDone(false);
          }}
          data-testid="mate-wipe-confirm"
        />
      </label>
      <ErrorLine text={err} />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {done && (
          <span className="min-w-0 flex-1 text-[12px] text-success" data-testid="mate-wipe-done">
            {t("mateSettings.dangerWiped", { name: mate.name })}
          </span>
        )}
        <button className="btn bg-danger/15 text-danger hover:bg-danger/25" disabled={busy || typed.trim() !== mate.name.trim()} onClick={() => void wipe()} data-testid="mate-wipe">
          {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="rotate" size={14} />} {t("mateSettings.dangerWipeBtn")}
        </button>
      </div>
    </Section>
  );
}

export default function DangerTab({ mate, onDeleted }: { mate: Mate; onDeleted: () => void }) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
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
  return (
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
  );
}
