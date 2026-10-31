import { useEffect, useState } from "react";
import { addMemory, deleteMemory, listMemories, type Mate, type Memory } from "../../../api/mates";
import { relTime } from "../../admin/format";
import Icon from "../../ui/Icon";
import { ErrorLine, Section } from "./ui";

export default function MemoryTab({ mate }: { mate: Mate }) {
  const [items, setItems] = useState<Memory[] | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    listMemories(mate.id)
      .then(setItems)
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mate.id]);

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const m = await addMemory(mate.id, text.trim());
      setItems((xs) => [...(xs ?? []), m]);
      setText("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setErr(null);
    try {
      await deleteMemory(mate.id, id);
      setItems((xs) => (xs ?? []).filter((m) => m.id !== id));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Section
      title={items ? `Memory · ${items.length} / 200` : "Memory"}
      hint={`What ${mate.name} keeps in mind across conversations — it is part of every reply. ${mate.name} adds and forgets things itself too ("remember that…"); you can add or remove them here.`}
      right={
        <button className="btn-ghost !px-2" onClick={load} title="Reload">
          <Icon name="refresh" size={14} />
        </button>
      }
    >
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add something to remember…" data-testid="mate-memory-input" />
        <button className="btn-soft shrink-0" disabled={busy || !text.trim()} data-testid="mate-memory-add">
          <Icon name="plus" size={14} /> Add
        </button>
      </form>
      <ErrorLine text={err} />
      {items === null ? (
        <p className="text-[12px] text-content-faint">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-[12px] text-content-faint">Nothing yet.</p>
      ) : (
        <ul className="divide-y divide-border/70 rounded-lg border border-border" data-testid="mate-memory-list">
          {items.map((m) => (
            <li key={m.id} className="group flex items-start gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-content break-words">{m.text}</p>
                <p className="text-[10.5px] text-content-faint">{relTime(m.created_at)}</p>
              </div>
              <button onClick={() => remove(m.id)} className="rounded p-1 text-content-faint hover:bg-surface-3 hover:text-danger" title="Forget" aria-label="Forget">
                <Icon name="trash" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
