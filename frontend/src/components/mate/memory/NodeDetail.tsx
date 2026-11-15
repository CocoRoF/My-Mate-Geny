/**
 * One thing in her memory network (docs/mate-memory-graph.md "The map"): what it is, its other names, how vivid it is
 * in her mind now, every fact about it with where it came from (a page — its title, its exact quote, a link — or a
 * conversation), what she used to believe before a newer fact replaced it, the user's memories about it, what it
 * connects to, the pages she read and the studies that touched it. Edit, pin, merge with another node, forget.
 */
import { useEffect, useState } from "react";
import {
  editGraphNode,
  forgetGraphFact,
  forgetGraphNode,
  getGraphNode,
  GRAPH_KINDS,
  mergeGraphNode,
  searchMemoryGraph,
  type GraphKind,
  type GraphNode,
  type GraphNodeDetail,
} from "../../../api/mates";
import { useT, type MsgKey } from "../../../i18n";
import { relTime } from "../../../i18n/format";
import { confirmDialog } from "../../ui/ConfirmDialog";
import Icon from "../../ui/Icon";
import { KIND_COLOR } from "./MemoryGraph";

export function kindLabel(t: ReturnType<typeof useT>, k: GraphKind) {
  return t(`memgraph.kind_${k}` as MsgKey);
}

export function strengthWord(t: ReturnType<typeof useT>, value: number) {
  const pct = Math.round(value * 100);
  return pct >= 85 ? t("memgraph.vivid") : pct >= 40 ? t("memgraph.clear") : pct >= 20 ? t("memgraph.fading") : t("memgraph.faded");
}

export function Strength({ value, testId }: { value: number; testId?: string }) {
  const t = useT();
  const pct = Math.round(value * 100);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-content-faint" title={t("memgraph.strengthHint")} data-testid={testId}>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-3">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(4, pct)}%`, opacity: 0.35 + 0.65 * value }} />
      </span>
      {strengthWord(t, value)}
    </span>
  );
}

export default function NodeDetail({ mateId, nodeId, selfName, onNavigate, onClose, onChanged }: {
  mateId: string;
  nodeId: string;
  selfName: string;
  onNavigate: (id: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [d, setD] = useState<GraphNodeDetail | null>(null);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState(0);
  const [openQuote, setOpenQuote] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    setErr("");
    getGraphNode(mateId, nodeId)
      .then((x) => !dead && setD(x))
      .catch((e) => !dead && setErr((e as Error).message));
    return () => {
      dead = true;
    };
  }, [mateId, nodeId, rev]);
  const act = async (f: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setErr("");
    try {
      await f();
      onChanged();
      if (after) after();
      else setRev((n) => n + 1);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!d) return err ? <p className="text-[12px] text-danger">{err}</p> : <p className="text-[12px] text-content-faint">{t("common.loading")}</p>;
  const n = d.node;
  const special = n.kind === "user" || n.kind === "self";
  const name = n.kind === "user" ? t("memgraph.userNode") : n.kind === "self" ? selfName : n.name;
  const active = d.facts.filter((f) => f.status === "active");
  const old = d.facts.filter((f) => f.status !== "active");
  return (
    <section className="space-y-3 rounded-xl border border-border bg-surface-2/50 p-3.5" data-testid="memory-node-detail" data-node={n.id}>
      <div className="flex items-start gap-2">
        <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-[15px] font-semibold text-content">
            {name} {!!n.pinned && <Icon name="pin" size={12} className="inline text-accent" />}
          </h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span className="pill border border-border bg-surface-3/60 text-content-faint">{kindLabel(t, n.kind)}</span>
            <Strength value={n.strength} testId="memory-node-strength" />
            {n.last_access && <span className="text-[11px] text-content-faint">{t("memgraph.lastThought", { when: relTime(n.last_access) })}</span>}
          </div>
        </div>
        <button className="btn-ghost !px-1.5" onClick={onClose} aria-label={t("common.close")}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {n.aliases.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {n.aliases.map((a) => (
            <span key={a} className="pill border border-border/70 bg-surface-3/40 text-content-dim">{a}</span>
          ))}
        </div>
      )}
      {n.summary && <p className="text-[12.5px] leading-relaxed text-content-dim">{n.summary}</p>}

      {editing ? (
        <NodeEditor node={n} busy={busy} onCancel={() => setEditing(false)} onSave={(patch) => act(() => editGraphNode(mateId, n.id, patch), () => { setEditing(false); setRev((x) => x + 1); })} />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {!special && (
            <button className="btn-ghost !py-1 text-[12px]" onClick={() => setEditing(true)} data-testid="memory-node-edit">
              <Icon name="pencil" size={12} /> {t("memgraph.edit")}
            </button>
          )}
          {!special && (
            <button className="btn-ghost !py-1 text-[12px]" disabled={busy} title={t("memgraph.pinHint")} onClick={() => act(() => editGraphNode(mateId, n.id, { pinned: !n.pinned }))} data-testid="memory-node-pin">
              <Icon name="pin" size={12} /> {n.pinned ? t("memgraph.unpin") : t("memgraph.pin")}
            </button>
          )}
          {!special && (
            <button className="btn-ghost !py-1 text-[12px]" onClick={() => setMerging((v) => !v)} data-testid="memory-node-merge">
              <Icon name="layers" size={12} /> {t("memgraph.merge")}
            </button>
          )}
          {!special && (
            <button
              className="btn-ghost !py-1 text-[12px] text-danger"
              disabled={busy}
              data-testid="memory-node-forget"
              onClick={async () => {
                if (await confirmDialog({ body: t("memgraph.forgetConfirm", { name: n.name }), confirmLabel: t("memgraph.forget"), danger: true }))
                  void act(() => forgetGraphNode(mateId, n.id), onClose);
              }}
            >
              <Icon name="trash" size={12} /> {t("memgraph.forget")}
            </button>
          )}
        </div>
      )}
      {merging && <MergePicker mateId={mateId} node={n} busy={busy} onMerge={(into) => act(() => mergeGraphNode(mateId, n.id, into), () => { setMerging(false); onNavigate(into); })} />}

      {active.length > 0 && (
        <div className="space-y-1.5" data-testid="memory-node-facts">
          <h4 className="text-[12px] font-semibold text-content">{t("memgraph.facts", { n: active.length })}</h4>
          <ul className="space-y-1.5">
            {active.map((f) => (
              <li key={f.id} className="rounded-lg border border-border/60 bg-surface/50 px-2.5 py-2 text-[12.5px]" data-testid="memory-node-fact">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 leading-relaxed text-content">
                    {f.object && f.subject !== n.id ? (
                      <button className="mr-1 text-link underline" onClick={() => onNavigate(f.subject)}>{f.subject_name}</button>
                    ) : null}
                    {f.statement}
                    {f.valid_from && <span className="ml-1.5 pill border border-border/60 bg-surface-3/50 text-[10.5px] text-content-faint">{t("memgraph.validFrom", { v: f.valid_from })}</span>}
                  </span>
                  <button className="btn-ghost shrink-0 !p-1 text-content-faint" disabled={busy} aria-label={t("memgraph.forgetFact")} title={t("memgraph.forgetFact")}
                    onClick={async () => {
                      if (await confirmDialog({ body: t("memgraph.forgetFactConfirm"), confirmLabel: t("memgraph.forget"), danger: true }))
                        void act(() => forgetGraphFact(mateId, f.id));
                    }}>
                    <Icon name="x" size={11} />
                  </button>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-content-faint">
                  <Strength value={f.strength} />
                  {f.doc_id ? (
                    <>
                      <span>{t("memgraph.fromPage")}</span>
                      {f.doc_url ? <a className="max-w-[16rem] truncate text-link underline" href={f.doc_url} target="_blank" rel="noreferrer">{f.doc_title || f.doc_url}</a> : <span>{f.doc_title}</span>}
                    </>
                  ) : (
                    <span>{t("memgraph.fromChat")}</span>
                  )}
                  <span>· {relTime(f.recorded_at)}</span>
                  {f.quote && (
                    <button className="text-link underline" onClick={() => setOpenQuote(openQuote === f.id ? null : f.id)}>
                      {openQuote === f.id ? t("memgraph.hideQuote") : t("memgraph.showQuote")}
                    </button>
                  )}
                  {f.object && f.object !== n.id && (
                    <button className="text-link underline" onClick={() => onNavigate(f.object!)}>→ {f.object_name}</button>
                  )}
                </div>
                {openQuote === f.id && <blockquote className="mt-1.5 border-l-2 border-accent/50 pl-2 text-[11.5px] italic leading-relaxed text-content-dim">{f.quote}</blockquote>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {old.length > 0 && (
        <details className="text-[12px]">
          <summary className="cursor-pointer select-none text-content-faint">{t("memgraph.oldFacts", { n: old.length })}</summary>
          <ul className="mt-1 space-y-1 pl-3 text-content-faint">
            {old.map((f) => (
              <li key={f.id} className="line-through decoration-content-faint/50">{f.statement}{f.invalidated_at ? ` (${relTime(f.invalidated_at)})` : ""}</li>
            ))}
          </ul>
        </details>
      )}
      {d.memories.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-[12px] font-semibold text-content">{t("memgraph.memoriesAbout", { n: d.memories.length })}</h4>
          <ul className="space-y-1 text-[12.5px] text-content-dim">
            {d.memories.map((m) => (
              <li key={m.id} className="flex gap-1.5"><Icon name="brain" size={12} className="mt-0.5 shrink-0 text-accent" /><span>{m.text}</span></li>
            ))}
          </ul>
        </div>
      )}
      {d.neighbors.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-[12px] font-semibold text-content">{t("memgraph.connected")}</h4>
          <div className="flex flex-wrap gap-1">
            {d.neighbors.map((x) => (
              <button key={x.id} className="pill border border-border bg-surface-3/50 text-content-dim hover:text-content" onClick={() => onNavigate(x.id)} data-testid="memory-node-neighbor">
                <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLOR[x.kind] }} />
                {x.kind === "user" ? t("memgraph.userNode") : x.kind === "self" ? selfName : x.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {d.docs.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-[12px] font-semibold text-content">{t("memgraph.pages", { n: d.docs.length })}</h4>
          <ul className="space-y-0.5 text-[12px]">
            {d.docs.map((doc) => (
              <li key={doc.id} className="flex items-center gap-1.5">
                <Icon name="book" size={11} className="shrink-0 text-content-faint" />
                <a className="truncate text-link underline" href={doc.url} target="_blank" rel="noreferrer">{doc.title || doc.url}</a>
                <span className="shrink-0 text-[11px] text-content-faint">{relTime(doc.fetched_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {err && <p className="text-[12px] text-danger">{err}</p>}
    </section>
  );
}

function NodeEditor({ node, busy, onSave, onCancel }: { node: GraphNode; busy: boolean; onSave: (patch: Partial<GraphNode>) => void; onCancel: () => void }) {
  const t = useT();
  const [name, setName] = useState(node.name);
  const [aliases, setAliases] = useState(node.aliases.join(", "));
  const [summary, setSummary] = useState(node.summary);
  const [kind, setKind] = useState<GraphKind>(node.kind);
  const [importance, setImportance] = useState(node.importance);
  return (
    <form
      className="space-y-2 rounded-lg border border-border/60 p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ name: name.trim(), aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean), summary: summary.trim(), kind, importance });
      }}
      data-testid="memory-node-editor"
    >
      <input className="field !py-1 text-[12.5px]" value={name} onChange={(e) => setName(e.target.value)} aria-label={t("memgraph.name")} placeholder={t("memgraph.name")} />
      <input className="field !py-1 text-[12.5px]" value={aliases} onChange={(e) => setAliases(e.target.value)} aria-label={t("memgraph.aliases")} placeholder={t("memgraph.aliasesHint")} />
      <textarea className="field min-h-16 text-[12.5px]" value={summary} onChange={(e) => setSummary(e.target.value)} aria-label={t("memgraph.summary")} placeholder={t("memgraph.summary")} />
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-content-dim">
        <select className="field !w-auto !py-1" value={kind} onChange={(e) => setKind(e.target.value as GraphKind)} aria-label={t("memgraph.kind")}>
          {GRAPH_KINDS.map((k) => <option key={k} value={k}>{kindLabel(t, k)}</option>)}
        </select>
        <label className="flex items-center gap-2">
          {t("memgraph.importance", { n: importance })}
          <input type="range" min={1} max={5} value={importance} onChange={(e) => setImportance(Number(e.target.value))} className="w-24" />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost !py-1 text-[12px]" onClick={onCancel}>{t("common.cancel")}</button>
        <button className="btn-soft !py-1 text-[12px]" disabled={busy || !name.trim()}>{t("common.save")}</button>
      </div>
    </form>
  );
}

function MergePicker({ mateId, node, busy, onMerge }: { mateId: string; node: GraphNode; busy: boolean; onMerge: (into: string) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<GraphNode[]>([]);
  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    let dead = false;
    const timer = setTimeout(() => {
      searchMemoryGraph(mateId, q)
        .then((r) => !dead && setHits(r.nodes.filter((x) => x.id !== node.id && x.kind !== "user" && x.kind !== "self").slice(0, 8)))
        .catch(() => !dead && setHits([]));
    }, 250);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [q, mateId, node.id]);
  return (
    <div className="space-y-1.5 rounded-lg border border-border/60 p-2.5" data-testid="memory-node-merge-picker">
      <p className="text-[11.5px] text-content-faint">{t("memgraph.mergeHint", { name: node.name })}</p>
      <input className="field !py-1 text-[12.5px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("memgraph.mergeSearch")} autoFocus />
      <ul className="space-y-1">
        {hits.map((h) => (
          <li key={h.id}>
            <button className="btn-ghost w-full !justify-start !py-1 text-left text-[12.5px]" disabled={busy} onClick={() => onMerge(h.id)}>
              <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLOR[h.kind] }} />
              {h.name} <span className="text-content-faint">· {kindLabel(t, h.kind)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
