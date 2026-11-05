import { useEffect, useRef, useState } from "react";
import {
  forgetEvidence, knowledgeStatus, listTaskRecords, memoryHistory, processMemorySource,
  readEvidence, restoreMemoryVersion, searchHistory,
  type EvidenceView, type HistorySearch, type KnowledgeStatus, type Memory, type MemoryHistory, type TaskRecord,
} from "../../../api/mates";
import { useSessionStore } from "../../../stores/sessionStore";
import { useUIStore } from "../../../stores/uiStore";
import { useT, type MsgKey } from "../../../i18n";
import { relTime } from "../../../i18n/format";
import { ErrorLine, Section } from "./ui";

function Evidence({ mateId, source, revision, offset = 0, onForgot }: { mateId: string; source: string; revision?: number; offset?: number; onForgot?: () => void }) {
  const t = useT();
  const [value, setValue] = useState<EvidenceView | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState(offset);
  useEffect(() => {
    let alive = true;
    readEvidence(mateId, source, revision, position).then(v => { if (alive) setValue(v); }).catch(e => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [mateId, source, revision, position]);
  const forget = async () => {
    setBusy(true); setErr("");
    try { await forgetEvidence(mateId, source); setValue(null); onForgot?.(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="space-y-2 rounded-lg border border-border bg-surface-2/50 p-3" data-testid="memory-evidence">
    <ErrorLine text={err} />
    {value?.messages.map(m => <div key={m.source_id} className="space-y-1">
      <p className="text-[11px] text-content-faint">{relTime(m.observed_at)} · {m.role === "assistant" ? t("mateSettings.knowledgeReported") : t("mateSettings.knowledgeAsserted")}</p>
      <p className="whitespace-pre-wrap break-words text-[13px]">{m.text}</p>
      {m.truncated && <p className="text-[11px] text-warning">{t("mateSettings.knowledgeTruncated")}</p>}
    </div>)}
    {value?.next_offset != null && <button type="button" className="btn-soft" onClick={() => setPosition(value.next_offset!)}>{t("mateSettings.knowledgeMore")}</button>}
    {value && <>
      <p className="text-[11px] text-content-faint">{t("mateSettings.knowledgeForgetHint")}</p>
      <button type="button" className="btn-ghost text-danger" disabled={busy} onClick={() => void forget()}>{t("mateSettings.knowledgeForgetSource")}</button>
    </>}
  </div>;
}

export function MemoryHistoryDetails({ mateId, memory, onChanged }: { mateId: string; memory: Memory; onChanged: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<MemoryHistory | null>(null);
  const [source, setSource] = useState<{ id: string; rev: number; offset?: number } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    memoryHistory(mateId, memory.id).then(v => { if (alive) setData(v); }).catch(e => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [mateId, memory.id, memory.revision, open]);
  const restore = async (rev: number) => {
    setBusy(true); setErr("");
    try { await restoreMemoryVersion(mateId, memory.id, rev, memory.revision); onChanged(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  return <details onToggle={e => setOpen(e.currentTarget.open)} className="text-[12px]" data-testid="memory-history">
    <summary className="cursor-pointer py-1 text-content-dim">{t("mateSettings.knowledgeHistory")}</summary>
    <ErrorLine text={err} />
    {open && data && <div className="space-y-2 pt-1">
      {!data.evidence.length && <p className="text-content-faint">{t("mateSettings.knowledgeNoEvidence")}</p>}
      {data.evidence.map(e => <button type="button" key={`${e.source_id}:${e.source_revision}`} className="block w-full rounded-lg bg-surface-2 p-2 text-left hover:bg-surface-3" onClick={() => setSource({ id: e.source_id, rev: e.source_revision, offset: Math.max(0, e.start - 120) })}>
        <span className="block text-accent">{e.title} · {relTime(e.observed_at)}</span><span className="block break-words">{e.quote}</span>
      </button>)}
      {source && <Evidence key={`${source.id}:${source.offset ?? 0}`} mateId={mateId} source={source.id} revision={source.rev} offset={source.offset} onForgot={onChanged} />}
      {data.versions.map(v => <div key={v.revision} className="rounded-lg border border-border p-2">
        <p className="text-content-faint">{t("mateSettings.knowledgeRevision", { revision: v.revision })} · {relTime(v.recorded_at)}</p>
        <p className="whitespace-pre-wrap break-words">{v.snapshot.text}</p>
        {v.evidence?.map(e => <button type="button" key={e.source_id} className="block py-1 text-left text-accent" onClick={() => setSource({ id: e.source_id, rev: e.source_revision, offset: Math.max(0, e.start - 120) })}>{e.title} · {relTime(e.observed_at)}</button>)}
        {v.revision !== memory.revision && <button type="button" className="btn-soft mt-1" disabled={busy} onClick={() => void restore(v.revision)}>{t("mateSettings.knowledgeRestore")}</button>}
      </div>)}
    </div>}
  </details>;
}

const TASK_LABELS: Record<string, MsgKey> = {
  requested: "mateSettings.knowledgeTaskRequested", background: "mateSettings.knowledgeTaskBackground",
  reported: "mateSettings.knowledgeTaskReported", interrupted: "mateSettings.knowledgeTaskInterrupted",
  delivery_failed: "mateSettings.knowledgeTaskFailed",
};

export default function KnowledgePanel({ mateId, rev }: { mateId: string; rev: number }) {
  const t = useT();
  const [tab, setTab] = useState("history");
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("mate");
  const [result, setResult] = useState<HistorySearch | null>(null);
  const [source, setSource] = useState<{ id: string; rev: number; offset?: number } | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [stats, setStats] = useState<KnowledgeStatus | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => {
    let alive = true;
    setSource(null); setResult(null); setErr("");
    Promise.all([knowledgeStatus(mateId), listTaskRecords(mateId)]).then(([s, ts]) => { if (alive) { setStats(s); setTasks(ts); } }).catch(e => { if (alive) setErr(e.message); });
    return () => { alive = false; request.current += 1; };
  }, [mateId, rev]);
  const search = async (more = false) => {
    const n = ++request.current;
    setBusy(true); setErr(""); setSource(null);
    try {
      const data = await searchHistory(mateId, q, scope, more ? result?.next_offset ?? 0 : 0);
      if (n === request.current) setResult(more && result ? { ...data, items: [...result.items, ...data.items] } : data);
    } catch (e) { if (n === request.current) setErr((e as Error).message); }
    finally { if (n === request.current) setBusy(false); }
  };
  const process = async (id: string) => {
    try { await processMemorySource(mateId, id); setQueued(id); }
    catch (e) { setErr((e as Error).message); }
  };
  return <Section title={t("mateSettings.knowledgeTitle")} hint={t("mateSettings.knowledgeHint")} testId="mate-knowledge">
    <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("mateSettings.knowledgeTitle")}>
      {["history", "tasks"].map(id => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "btn-soft" : "btn-ghost"} onClick={() => setTab(id)}>{t(id === "history" ? "mateSettings.knowledgeSearch" : "mateSettings.knowledgeTasks")}</button>)}
    </div>
    <ErrorLine text={err} />
    {tab === "history" ? <div className="space-y-3" role="tabpanel">
      <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); void search(); }}>
        <input type="search" className="field min-w-0 flex-1" value={q} onChange={e => setQ(e.target.value)} placeholder={t("mateSettings.knowledgeSearchPh")} aria-label={t("mateSettings.knowledgeSearch")} data-testid="knowledge-query" />
        <select className="field !w-auto" value={scope} onChange={e => { setScope(e.target.value); setResult(null); }} aria-label={t("mateSettings.knowledgeScope")}>
          <option value="mate">{t("mateSettings.knowledgeOwn")}</option><option value="sessions">{t("mateSettings.knowledgeSessions")}</option><option value="all">{t("mateSettings.knowledgeAll")}</option>
        </select>
        <button className="btn-soft" disabled={busy || !q.trim()} data-testid="knowledge-search">{t("mateSettings.knowledgeSearch")}</button>
      </form>
      {result && !result.items.length && <p className="text-[12px] text-content-faint">{t(result.indexing_pending ? "mateSettings.knowledgeIndexing" : "mateSettings.knowledgeNone")}</p>}
      {result?.items.map(h => <div key={h.source_id} className="space-y-1 rounded-lg border border-border p-3" data-testid="knowledge-hit">
        <button type="button" className="block w-full space-y-1 text-left" onClick={() => setSource({ id: h.source_id, rev: h.revision, offset: h.offset })}>
          <span className="block text-[12px] text-accent">{h.title} · {relTime(h.observed_at)}</span>
          <span className="block whitespace-pre-wrap break-words text-[13px]">{h.excerpt}</span>
        </button>
        {scope === "mate" && <button type="button" className="btn-ghost !px-0 text-[11px]" disabled={queued === h.source_id} onClick={() => void process(h.source_id)}>{t(queued === h.source_id ? "mateSettings.knowledgeQueued" : "mateSettings.knowledgeProcess")}</button>}
        {source?.id === h.source_id && <Evidence key={`${source.id}:${source.offset ?? 0}`} mateId={mateId} source={source.id} revision={source.rev} offset={source.offset} onForgot={() => { setSource(null); void search(); }} />}
      </div>)}
      {result?.next_offset != null && <button type="button" className="btn-soft" disabled={busy} onClick={() => void search(true)}>{t("mateSettings.knowledgeMore")}</button>}
    </div> : <div role="tabpanel" className="space-y-2">
      <p className="text-[12px] text-content-faint">{t("mateSettings.knowledgeTaskHint")}</p>
      {!tasks.length && <p className="text-[12px] text-content-faint">{t("mateSettings.knowledgeNone")}</p>}
      {tasks.map(task => <details key={task.id} className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-[13px]">{task.title} · {t(TASK_LABELS[task.state] ?? "mateSettings.knowledgeTaskInterrupted")} · {relTime(task.created_at)}</summary>
        <p className="mt-2 whitespace-pre-wrap break-words text-[12px]">{task.instruction}</p>
        {task.result?.text && <p className="mt-2 whitespace-pre-wrap break-words text-[12px] text-content-dim">{task.result.text}</p>}
        {task.result?.error && <ErrorLine text={task.result.error} />}
        <p className="mt-2 text-[11px] text-content-faint">{t("mateSettings.knowledgeReceipts", { n: task.receipts.length })}</p>
        <button type="button" className="btn-soft mt-2" onClick={() => { useSessionStore.getState().setActive(task.worker_sid); useUIStore.getState().setView("chat"); }}>{t("mateSettings.knowledgeOpenWorker")}</button>
      </details>)}
    </div>}
    {stats && <p className="text-[11px] text-content-faint" data-testid="knowledge-status">{t("mateSettings.knowledgeStatus", { episodes: stats.episodes, evidence: stats.evidence, pending: (stats.jobs.pending ?? 0) + (stats.jobs.running ?? 0), failed: stats.jobs.failed ?? 0, unindexed: stats.unindexed })}</p>}
  </Section>;
}
