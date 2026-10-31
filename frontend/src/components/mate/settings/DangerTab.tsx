import { useState } from "react";
import type { Mate } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { ErrorLine, Section } from "./ui";

export default function DangerTab({ mate, onDeleted }: { mate: Mate; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
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
      setRestored(n ? `Restored ${n} built-in mate${n === 1 ? "" : "s"}.` : "All built-in mates are already here.");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <>
      <Section
        title={`Delete ${mate.name}`}
        hint={
          <>
            Removes the mate, its conversation, memories and avatar files. Your chats (and anything it sent to them) stay.
            {mate.builtin && (
              <>
                {" "}
                <b className="text-content-dim">{mate.name} ships with the app:</b> “Restore built-in mates” brings it back
                (fresh — without this conversation and memories).
              </>
            )}
          </>
        }
      >
        <label className="block text-[12px] text-content-dim">
          Type <b className="text-content">{mate.name}</b> to confirm
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
            {busy ? <Icon name="spinner" size={14} spin /> : <Icon name="trash" size={14} />} Delete mate
          </button>
        </div>
      </Section>
      <Section title="Built-in mates" hint="Estelle, Chaerin and Seoa ship with the app. Bring back any you deleted.">
        <div className="flex items-center justify-end gap-3">
          {restored && <span className="text-[12px] text-success">{restored}</span>}
          <button className="btn-soft" onClick={restore} data-testid="mate-restore-builtins-settings">
            <Icon name="rotate" size={13} /> Restore built-in mates
          </button>
        </div>
      </Section>
    </>
  );
}
