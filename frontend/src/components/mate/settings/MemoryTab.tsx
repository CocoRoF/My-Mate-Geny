/**
 * Memory (this mate, docs/mate-memory-affinity.md §4): browse / search / filter by kind, add with kind, importance,
 * a date (plans) and a pin, edit in place, mark plans done, archive, delete, select several. "Always known" marks the
 * core (in her system prompt); the rest is recalled when a message is about it — "Test recall" shows exactly what she
 * would get. Memory use (how much to recall, saving on her own) applies from her next message. Edits by the mate or in
 * another window arrive by the server's push (memoryRev).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addMemory,
  bulkMemories,
  deleteMemory,
  listMemories,
  memoryStats,
  memoryStyleOk,
  memoryToStyle,
  MEMORY_KINDS,
  prefsOf,
  previewRecall,
  updateMemory,
  type Mate,
  type Memory,
  type MemoryAdded,
  type MemoryKind,
  type MemoryQuery,
  type MemoryStats,
  type RecallLevel,
  type RecallPreview,
} from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import { relTime } from "../../../i18n/format";
import { useT, type MsgKey } from "../../../i18n";
import Icon from "../../ui/Icon";
import { Banner, ErrorLine, Field, Section, Segmented, Toggle } from "./ui";

const KIND_LABEL: Record<MemoryKind, MsgKey> = {
  profile: "mateSettings.memKindProfile",
  preference: "mateSettings.memKindPreference",
  fact: "mateSettings.memKindFact",
  plan: "mateSettings.memKindPlan",
  context: "mateSettings.memKindContext",
};
const KIND_TONE: Record<MemoryKind, string> = {
  profile: "bg-accent-soft text-content",
  preference: "bg-surface-3 text-content",
  fact: "bg-surface-3 text-content-dim",
  plan: "bg-warning/15 text-content",
  context: "bg-surface-2 text-content-faint",
};
const RECALL: { id: RecallLevel; label: MsgKey }[] = [
  { id: "off", label: "mateSettings.memRecallOff" },
  { id: "light", label: "mateSettings.memRecallLight" },
  { id: "normal", label: "mateSettings.styleNormal" },
  { id: "rich", label: "mateSettings.memRecallRich" },
];

/** "2026-11-03T15:00" → is it in the past (local) */
const overdue = (due: string | null) => !!due && new Date(due.includes("T") ? due : `${due}T23:59`).getTime() < Date.now();
const dueText = (due: string) => due.replace("T", " ");

function Importance({ value, onChange, testId }: { value: number; onChange?: (v: number) => void; testId?: string }) {
  const t = useT();
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" title={t("mateSettings.memImportance", { n: value })} data-testid={testId} data-value={value}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onChange}
          onClick={() => onChange?.(n)}
          aria-label={t("mateSettings.memImportance", { n })}
          className={`h-2 w-2 rounded-full ${n <= value ? "bg-accent" : "bg-surface-3"} ${onChange ? "hover:scale-125" : "cursor-default"}`}
        />
      ))}
    </span>
  );
}

function KindBadge({ kind }: { kind: MemoryKind }) {
  const t = useT();
  return <span className={`shrink-0 rounded px-1.5 py-px text-[10.5px] font-medium ${KIND_TONE[kind]}`}>{t(KIND_LABEL[kind])}</span>;
}

export default function MemoryTab({ mate, onOpenStyle }: { mate: Mate; onOpenStyle?: () => void }) {
  const t = useT();
  const [items, setItems] = useState<Memory[] | null>(null);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState<MemoryQuery>({ sort: "recent", status: "active" });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  // the add form
  const [text, setText] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [imp, setImp] = useState(3);
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<MemoryAdded | null>(null);
  const [moved, setMoved] = useState(false);

  // search as you type (debounced)
  useEffect(() => {
    const h = setTimeout(() => setQuery((x) => ({ ...x, q: q.trim() || undefined })), 250);
    return () => clearTimeout(h);
  }, [q]);

  const seq = useRef(0);
  const load = () => {
    const n = ++seq.current;
    Promise.all([listMemories(mate.id, query), memoryStats(mate.id)])
      .then(([rows, st]) => {
        if (n !== seq.current) return;
        setItems(rows);
        setStats(st);
        setSel((s) => new Set([...s].filter((id) => rows.some((r) => r.id === id))));
      })
      .catch((e) => setErr((e as Error).message));
  };
  // (its memories changed in another window / on another device, or the mate remembered something: server push)
  const rev = useMateStore((s) => s.memoryRev[mate.id] ?? 0);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mate.id, rev, JSON.stringify(query)]);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const due = kind === "plan" && dueDate ? (dueTime ? `${dueDate}T${dueTime}` : dueDate) : null;
      const m = await addMemory(mate.id, { text: text.trim(), kind, importance: imp, pinned: pin, due_at: due });
      setAdded(m);
      setText("");
      setPin(false);
      setDueDate("");
      setDueTime("");
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // "Merge" a just-added memory into the similar one: the older keeps its id with the new text
  const merge = (into: Memory) =>
    run(async () => {
      if (!added) return;
      await updateMemory(mate.id, into.id, { text: added.text, importance: Math.max(into.importance, added.importance) });
      await deleteMemory(mate.id, added.id);
      setAdded(null);
    });

  // a memory that is really a rule about how she talks: the user moves it into the conversation style or keeps it
  const toStyle = (m: Memory) =>
    run(async () => {
      const out = await memoryToStyle(mate.id, m.id);
      useMateStore.getState().upsert(out.mate);
      setMoved(true);
    });
  const keepMemory = (m: Memory) => run(() => memoryStyleOk(mate.id, m.id));

  const saveEdit = () =>
    editing &&
    run(async () => {
      const e = editing;
      setEditing(null);
      if (e.text.trim()) await updateMemory(mate.id, e.id, { text: e.text.trim() });
    });

  const toggleSel = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const bulk = (action: "delete" | "archive" | "restore" | "pin" | "unpin") =>
    run(async () => {
      await bulkMemories(mate.id, [...sel], action);
      setSel(new Set());
    });

  // memory use: saved at once (her next message follows it)
  const prefs = prefsOf(mate);
  const setMemPrefs = (patch: Partial<typeof prefs.memory>) =>
    run(() => useMateStore.getState().patch(mate.id, { prefs: { memory: patch } }));

  const [probe, setProbe] = useState("");
  const [preview, setPreview] = useState<RecallPreview | null>(null);
  const test = () => run(async () => setPreview(await previewRecall(mate.id, probe)));

  const title = stats
    ? t("mateSettings.memTitleCount", { name: t("mateSettings.memTitle"), active: stats.active, core: stats.core })
    : t("mateSettings.memTitle");
  const showing = query.status ?? "active";
  const empty = useMemo(() => (items ? items.length === 0 : false), [items]);

  return (
    <>
      <Section
        title={title}
        hint={t("mateSettings.memHint", { name: mate.name })}
        testId="mate-memory"
        right={
          <button className="btn-ghost !px-2" onClick={load} title={t("common.reload")}>
            <Icon name="refresh" size={14} />
          </button>
        }
      >
        <form
          className="space-y-2 rounded-lg border border-border bg-surface-2/30 p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("mateSettings.memPh")} maxLength={1000} data-testid="mate-memory-input" />
          <div className="flex flex-wrap items-center gap-2">
            <select className="field !w-auto !py-1 text-[12.5px]" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} aria-label={t("mateSettings.memKind")} data-testid="mate-memory-kind">
              {MEMORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(KIND_LABEL[k])}
                </option>
              ))}
            </select>
            <Importance value={imp} onChange={setImp} testId="mate-memory-importance" />
            {kind === "plan" && (
              <>
                <input type="date" className="field !w-auto !py-1 text-[12.5px]" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label={t("mateSettings.memDue")} data-testid="mate-memory-due" />
                <input type="time" className="field !w-auto !py-1 text-[12.5px]" value={dueTime} disabled={!dueDate} onChange={(e) => setDueTime(e.target.value)} aria-label={t("mateSettings.memDueTime")} />
              </>
            )}
            <button type="button" onClick={() => setPin((p) => !p)} className={`rounded p-1 ${pin ? "text-accent" : "text-content-faint hover:text-content"}`} title={t("mateSettings.memPin")} aria-pressed={pin} data-testid="mate-memory-pin">
              <Icon name="pin" size={13} />
            </button>
            <button className="btn-soft ml-auto shrink-0" disabled={busy || !text.trim()} data-testid="mate-memory-add">
              <Icon name="plus" size={14} /> {t("common.add")}
            </button>
          </div>
        </form>
        {added?.merged && (
          <Banner tone="info" testId="mate-memory-merged">
            {t("mateSettings.memMerged")}
          </Banner>
        )}
        {added && !added.merged && added.similar.length > 0 && (
          <Banner
            tone="warn"
            testId="mate-memory-similar"
            action={
              <span className="flex gap-1.5">
                <button className="btn-soft !px-2 !py-0.5 text-[12px]" onClick={() => void merge(added.similar[0])} data-testid="mate-memory-merge">
                  {t("mateSettings.memMerge")}
                </button>
                <button className="btn-ghost !px-2 !py-0.5 text-[12px]" onClick={() => setAdded(null)}>
                  {t("mateSettings.memKeepBoth")}
                </button>
              </span>
            }
          >
            {t("mateSettings.memSimilar", { text: added.similar[0].text })}
          </Banner>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input className="field min-w-[10rem] flex-1 !py-1 text-[12.5px]" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("mateSettings.memSearch")} data-testid="mate-memory-search" />
          <select className="field !w-auto !py-1 text-[12.5px]" value={query.sort} onChange={(e) => setQuery((x) => ({ ...x, sort: e.target.value as MemoryQuery["sort"] }))} aria-label={t("mateSettings.memSort")} data-testid="mate-memory-sort">
            <option value="recent">{t("mateSettings.memSortRecent")}</option>
            <option value="importance">{t("mateSettings.memSortImportance")}</option>
            <option value="due">{t("mateSettings.memSortDue")}</option>
            <option value="created">{t("mateSettings.memSortCreated")}</option>
          </select>
          <select className="field !w-auto !py-1 text-[12.5px]" value={showing} onChange={(e) => setQuery((x) => ({ ...x, status: e.target.value as MemoryQuery["status"] }))} aria-label={t("mateSettings.memShow")} data-testid="mate-memory-status">
            <option value="active">{t("mateSettings.memShowActive")}</option>
            <option value="done">{t("mateSettings.memShowDone")}</option>
            <option value="archived">{t("mateSettings.memShowArchived")}</option>
            <option value="all">{t("mateSettings.memShowAll")}</option>
          </select>
        </div>
        <div className="no-scrollbar flex gap-1 overflow-x-auto" role="tablist" data-testid="mate-memory-kinds">
          {(["", ...MEMORY_KINDS] as (MemoryKind | "")[]).map((k) => (
            <button
              key={k || "all"}
              type="button"
              role="tab"
              aria-selected={(query.kind ?? "") === k}
              onClick={() => setQuery((x) => ({ ...x, kind: k }))}
              className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[12px] ${(query.kind ?? "") === k ? "border-accent bg-accent-soft text-content" : "border-border text-content-dim hover:bg-surface-3"}`}
              data-kind={k || "all"}
            >
              {k ? t(KIND_LABEL[k]) : t("mateSettings.memKindAll")}
            </button>
          ))}
        </div>
        <ErrorLine text={err} />
        {moved && (
          <Banner
            tone="info"
            testId="mate-memory-moved"
            action={
              onOpenStyle && (
                <button className="btn-soft !px-2 !py-0.5 text-[12px]" onClick={onOpenStyle}>
                  {t("mateSettings.profToStyle")}
                </button>
              )
            }
          >
            {t("mateSettings.memMovedToStyle")}
          </Banner>
        )}
        {sel.size > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-[12px]" data-testid="mate-memory-bulk">
            <span className="text-content-dim">{t("mateSettings.memSelected", { count: sel.size })}</span>
            <span className="flex-1" />
            {showing === "active" ? (
              <button className="btn-ghost !px-2 !py-0.5" onClick={() => void bulk("archive")}>
                {t("mateSettings.memArchive")}
              </button>
            ) : (
              <button className="btn-ghost !px-2 !py-0.5" onClick={() => void bulk("restore")}>
                {t("mateSettings.memRestore")}
              </button>
            )}
            <button className="btn-ghost !px-2 !py-0.5 text-danger" onClick={() => void bulk("delete")} data-testid="mate-memory-bulk-delete">
              {t("common.delete")}
            </button>
            <button className="btn-ghost !px-2 !py-0.5" onClick={() => setSel(new Set())}>
              {t("common.cancel")}
            </button>
          </div>
        )}
        {items === null ? (
          <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
        ) : empty ? (
          <p className="text-[12px] text-content-faint">{query.q || query.kind ? t("mateSettings.memNoMatch") : t("mateSettings.memEmpty")}</p>
        ) : (
          <ul className="divide-y divide-border/70 rounded-lg border border-border" data-testid="mate-memory-list">
            {items.map((m) => (
              <li key={m.id} className="group flex items-start gap-2 px-2.5 py-2" data-testid="mate-memory-item" data-id={m.id} data-kind={m.kind}>
                <input type="checkbox" className="mt-1 shrink-0" checked={sel.has(m.id)} onChange={() => toggleSel(m.id)} aria-label={t("mateSettings.memSelect")} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <KindBadge kind={m.kind} />
                    {m.core && m.status === "active" && <span className="text-[10.5px] text-accent">{t("mateSettings.memCore")}</span>}
                    {m.due_at && (
                      <span className={`rounded px-1.5 py-px text-[10.5px] ${m.status === "active" && overdue(m.due_at) ? "bg-danger/15 text-danger" : "bg-surface-3 text-content-dim"}`} data-testid="mate-memory-due-chip">
                        {t("mateSettings.memDueOn", { when: dueText(m.due_at) })}
                      </span>
                    )}
                    {m.status !== "active" && <span className="text-[10.5px] text-content-faint">{t(m.status === "done" ? "mateSettings.memShowDone" : "mateSettings.memShowArchived")}</span>}
                  </div>
                  {editing?.id === m.id ? (
                    <textarea
                      className="field resize-y text-[13px] leading-relaxed"
                      rows={2}
                      autoFocus
                      value={editing.text}
                      onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                      onBlur={() => void saveEdit()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void saveEdit();
                        } else if (e.key === "Escape") setEditing(null);
                      }}
                      data-testid="mate-memory-edit"
                    />
                  ) : (
                    <p className="cursor-text text-[13px] text-content break-words" onClick={() => setEditing({ id: m.id, text: m.text })} title={t("mateSettings.memEdit")} data-testid="mate-memory-text">
                      {m.text}
                    </p>
                  )}
                  {m.style_flag && m.status === "active" && (
                    <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-warning/10 px-2 py-1 text-[11px] text-content-dim" data-testid="mate-memory-style-flag" data-reason={m.style_flag.reason}>
                      <Icon name="sliders" size={11} className="shrink-0 text-warning" />
                      <span className="min-w-[12rem] flex-1 basis-[12rem]">
                        {t("mateSettings.memStyleFlag")}
                        {m.style_flag.conflict && <> {t("mateSettings.memStyleConflict")}</>}
                      </span>
                      <button type="button" className="btn-soft !px-2 !py-0.5 text-[11px]" onClick={() => void toStyle(m)} data-testid="mate-memory-to-style">
                        {t("mateSettings.memToStyle")}
                      </button>
                      <button type="button" className="btn-ghost !px-2 !py-0.5 text-[11px]" onClick={() => void keepMemory(m)} data-testid="mate-memory-style-ok">
                        {t("mateSettings.memStyleOk")}
                      </button>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-content-faint">
                    <Importance value={m.importance} onChange={(n) => void run(() => updateMemory(mate.id, m.id, { importance: n }))} testId="mate-memory-item-importance" />
                    <span>
                      {t(m.source === "user" ? "mateSettings.memByYou" : "mateSettings.memByMate", { name: mate.name })} · {relTime(m.updated_at)}
                    </span>
                    {m.use_count > 0 && <span>{t("mateSettings.memUsed", { count: m.use_count })}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button onClick={() => void run(() => updateMemory(mate.id, m.id, { pinned: !m.pinned }))} className={`rounded p-1 hover:bg-surface-3 ${m.pinned ? "text-accent" : "text-content-faint hover:text-content"}`} title={t(m.pinned ? "mateSettings.memUnpin" : "mateSettings.memPin")} aria-pressed={m.pinned} data-testid="mate-memory-item-pin">
                    <Icon name="pin" size={13} />
                  </button>
                  {m.kind === "plan" && m.status === "active" && (
                    <button onClick={() => void run(() => updateMemory(mate.id, m.id, { status: "done" }))} className="rounded p-1 text-content-faint hover:bg-surface-3 hover:text-content" title={t("mateSettings.memDone")} data-testid="mate-memory-item-done">
                      <Icon name="check" size={13} />
                    </button>
                  )}
                  {m.status === "active" ? (
                    <button onClick={() => void run(() => updateMemory(mate.id, m.id, { status: "archived" }))} className="rounded p-1 text-content-faint hover:bg-surface-3 hover:text-content" title={t("mateSettings.memArchive")}>
                      <Icon name="archive" size={13} />
                    </button>
                  ) : (
                    <button onClick={() => void run(() => updateMemory(mate.id, m.id, { status: "active" }))} className="rounded p-1 text-content-faint hover:bg-surface-3 hover:text-content" title={t("mateSettings.memRestore")}>
                      <Icon name="refresh" size={13} />
                    </button>
                  )}
                  <button onClick={() => void run(() => deleteMemory(mate.id, m.id))} className="rounded p-1 text-content-faint hover:bg-surface-3 hover:text-danger" title={t("mateSettings.memForget")} aria-label={t("mateSettings.memForget")} data-testid="mate-memory-item-delete">
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t("mateSettings.memUse")} hint={t("mateSettings.memUseHint", { name: mate.name })} testId="mate-memory-use">
        <Field label={t("mateSettings.memRecall")} hint={t("mateSettings.memRecallHint")} as="div">
          <Segmented value={prefs.memory.recall} onChange={(v) => void setMemPrefs({ recall: v })} options={RECALL.map((o) => ({ id: o.id, label: t(o.label) }))} testId="mate-memory-recall" />
        </Field>
        <Toggle on={prefs.memory.self_save} onChange={(on) => void setMemPrefs({ self_save: on })} label={t("mateSettings.memSelfSave", { name: mate.name })} hint={t("mateSettings.memSelfSaveHint")} testId="mate-memory-self-save" />
        <Field label={t("mateSettings.memTest")} hint={t("mateSettings.memTestHint")} as="div">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void test();
            }}
          >
            <input className="field" value={probe} onChange={(e) => setProbe(e.target.value)} placeholder={t("mateSettings.memTestPh")} data-testid="mate-memory-probe" />
            <button className="btn-soft shrink-0" data-testid="mate-memory-probe-run">
              {t("mateSettings.memTestRun")}
            </button>
          </form>
        </Field>
        {preview && (
          <div className="space-y-1.5" data-testid="mate-memory-preview">
            <p className="text-[12px] text-content-dim">
              {preview.recalled.length ? t("mateSettings.memTestFound", { count: preview.recalled.length }) : t("mateSettings.memTestNone")}
            </p>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-2/50 p-2 text-[11.5px] leading-relaxed text-content-dim">{preview.block}</pre>
          </div>
        )}
      </Section>
    </>
  );
}
