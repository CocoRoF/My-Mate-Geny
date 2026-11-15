/**
 * The heart panel's 네트워크 tab (docs/mate-memory-graph.md "The map"): her memory network as a map — what she knows,
 * what connects to what, and how vivid each thing is in her mind now — with a search, a filter (everything / her
 * memories of the user / what she learned), fading on or off, a full-screen view, and the selected thing's details.
 * It follows the server's pushes (a study filing facts, an edit elsewhere).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getMemoryGraph, searchMemoryGraph, type GraphKind, type GraphSearch, type GraphSnapshot, type Mate } from "../../../api/mates";
import { useT, type MsgKey } from "../../../i18n";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import MemoryGraph, { KIND_COLOR, type MemoryGraphHandle } from "./MemoryGraph";
import NodeDetail, { kindLabel } from "./NodeDetail";

type Origin = "all" | "personal" | "knowledge";
const LEGEND: GraphKind[] = ["user", "person", "place", "game", "work", "org", "topic", "concept", "thing", "event"];

export default function MemoryNetwork({ mate, onStudy }: { mate: Mate; onStudy?: () => void }) {
  const t = useT();
  const rev = useMateStore((s) => s.graphRev[mate.id] ?? 0);
  const [snap, setSnap] = useState<GraphSnapshot | null>(null);
  const [err, setErr] = useState("");
  const [origin, setOrigin] = useState<Origin>("all");
  const [fade, setFade] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<GraphSearch | null>(null);
  const [full, setFull] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const graph = useRef<MemoryGraphHandle>(null);
  useEffect(() => {
    let dead = false;
    getMemoryGraph(mate.id, { origin, limit: 400 })
      .then((s) => {
        if (dead) return;
        setSnap(s);
        setErr("");
      })
      .catch((e) => !dead && setErr((e as Error).message));
    return () => {
      dead = true;
    };
  }, [mate.id, origin, rev, refresh]);
  useEffect(() => {
    if (!query.trim()) {
      setFound(null);
      return;
    }
    let dead = false;
    const timer = setTimeout(() => {
      searchMemoryGraph(mate.id, query.trim())
        .then((r) => !dead && setFound(r))
        .catch(() => !dead && setFound(null));
    }, 300);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [query, mate.id, rev]);
  const highlight = useMemo(() => new Set((found?.nodes ?? []).map((n) => n.id)), [found]);
  const select = useCallback((id: string | null) => setSelected(id), []);
  const go = (id: string) => {
    setSelected(id);
    setTimeout(() => graph.current?.center(id), 50);
  };
  const empty = snap && snap.nodes.filter((n) => n.kind !== "user" && n.kind !== "self").length === 0;
  const body = (big: boolean) => (
    <div className={big ? "flex h-full min-h-0 flex-col gap-3 lg:flex-row" : "space-y-3"}>
      <div className={big ? "min-h-0 min-w-0 flex-1 space-y-2" : "space-y-2"}>
        <div className="flex items-center gap-1.5">
          <label className="relative min-w-0 flex-1">
            <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-faint" />
            <input className="field !py-1.5 !pl-8 text-[12.5px]" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("memgraph.search")} data-testid="memory-graph-search" />
          </label>
          <button className="btn-ghost !px-2 !py-1" onClick={() => graph.current?.fit()} title={t("memgraph.fit")} aria-label={t("memgraph.fit")}>
            <Icon name="crosshair" size={14} />
          </button>
          {!big && (
            <button className="btn-ghost !px-2 !py-1" onClick={() => setFull(true)} title={t("memgraph.full")} aria-label={t("memgraph.full")} data-testid="memory-graph-full">
              <Icon name="external" size={14} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex overflow-hidden rounded-lg border border-border text-[12px]" role="group">
            {(["all", "personal", "knowledge"] as const).map((o) => (
              <button key={o} type="button" className={`px-2.5 py-1 ${origin === o ? "bg-accent text-white" : "text-content-dim hover:bg-surface-3"}`} aria-pressed={origin === o} onClick={() => setOrigin(o)} data-testid={`memory-graph-origin-${o}`}>
                {t(`memgraph.origin_${o}` as MsgKey)}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-[12px] text-content-dim" title={t("memgraph.fadeHint")}>
            <input type="checkbox" checked={fade} onChange={(e) => setFade(e.target.checked)} data-testid="memory-graph-fade" /> {t("memgraph.fade")}
          </label>
        </div>
        {err && <p className="text-[12px] text-danger">{err}</p>}
        {!snap ? (
          <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
        ) : (
          <MemoryGraph
            ref={graph}
            mateId={mate.id}
            nodes={snap.nodes}
            links={snap.links}
            selected={selected}
            onSelect={select}
            highlight={highlight}
            fade={fade}
            height={big ? Math.max(360, window.innerHeight - 190) : 340}
            userLabel={t("memgraph.userNode")}
            selfLabel={mate.name}
            label={t("memgraph.mapLabel", { name: mate.name })}
          />
        )}
        {snap && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-content-faint" data-testid="memory-graph-stats">
            <span>{t("memgraph.statNodes", { n: snap.stats.nodes })}</span>
            <span>{t("memgraph.statFacts", { n: snap.stats.facts })}</span>
            <span>{t("memgraph.statDocs", { n: snap.stats.docs })}</span>
            {snap.stats.shown < snap.stats.nodes && <span>{t("memgraph.statShown", { n: snap.stats.shown })}</span>}
            {!!snap.stats.unlinked && <span className="text-accent">{t("memgraph.linking", { n: snap.stats.unlinked })}</span>}
          </div>
        )}
        <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-[11px] text-content-faint">
          {LEGEND.map((k) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLOR[k] }} />
              {k === "user" ? t("memgraph.userNode") : kindLabel(t, k)}
            </span>
          ))}
          <span className="inline-flex items-center gap-1"><span className="inline-block w-4 border-t border-dashed border-content-faint" />{t("memgraph.legendMemory")}</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block w-4 border-t border-content-faint" />{t("memgraph.legendFact")}</span>
        </div>
        {empty && (
          <div className="rounded-xl border border-dashed border-border p-4 text-center text-[12.5px] text-content-dim" data-testid="memory-graph-empty">
            <p>{t("memgraph.empty", { name: mate.name })}</p>
            {onStudy && (
              <button className="btn-soft mt-2 !py-1 text-[12.5px]" onClick={onStudy}>
                <Icon name="book" size={13} /> {t("memgraph.emptyStudy")}
              </button>
            )}
          </div>
        )}
      </div>
      <div className={big ? "min-h-0 w-full shrink-0 space-y-2 overflow-y-auto lg:w-[400px]" : "space-y-2"}>
        {found && !selected && (
          <SearchResults found={found} onPick={go} selfName={mate.name} />
        )}
        {selected && (
          <NodeDetail key={selected} mateId={mate.id} nodeId={selected} selfName={mate.name} onNavigate={go}
            onClose={() => setSelected(null)} onChanged={() => setRefresh((n) => n + 1)} />
        )}
      </div>
    </div>
  );
  return (
    <div className="space-y-3" data-testid="memory-network">
      <p className="text-[12px] leading-relaxed text-content-dim">{t("memgraph.hint", { name: mate.name })}</p>
      {!full && body(false)}
      {full &&
        createPortal(
          <div className="fixed inset-0 z-[60] flex flex-col bg-surface p-3 sm:p-4" data-testid="memory-graph-fullscreen">
            <div className="mb-2 flex items-center gap-2">
              <Icon name="brain" size={16} className="text-accent" />
              <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{t("memgraph.fullTitle", { name: mate.name })}</h2>
              <button className="btn-ghost !px-2" onClick={() => setFull(false)} aria-label={t("common.close")} data-testid="memory-graph-full-close">
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1">{body(true)}</div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function SearchResults({ found, onPick, selfName }: { found: GraphSearch; onPick: (id: string) => void; selfName: string }) {
  const t = useT();
  if (!found.nodes.length && !found.facts.length && !found.passages.length)
    return <p className="text-[12px] text-content-faint">{t("memgraph.noResults")}</p>;
  return (
    <div className="space-y-2 text-[12.5px]" data-testid="memory-graph-results">
      {found.nodes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {found.nodes.map((n) => (
            <button key={n.id} className="pill border border-border bg-surface-3/50 text-content-dim hover:text-content" onClick={() => onPick(n.id)}>
              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
              {n.kind === "user" ? t("memgraph.userNode") : n.kind === "self" ? selfName : n.name}
            </button>
          ))}
        </div>
      )}
      {found.facts.slice(0, 8).map((f) => (
        <button key={f.id} className="block w-full rounded-lg border border-border/60 px-2.5 py-1.5 text-left hover:bg-surface-3/40" onClick={() => onPick(f.subject)}>
          <span className="font-medium text-content">{f.subject_name}</span> <span className="text-content-dim">{f.statement}</span>
        </button>
      ))}
      {found.passages.slice(0, 4).map((p) => (
        <div key={p.chunk_id} className="rounded-lg border border-border/40 px-2.5 py-1.5 text-[12px] text-content-faint">
          <a className="text-link underline" href={p.url} target="_blank" rel="noreferrer">{p.title}</a>
          <p className="mt-0.5 line-clamp-3">{p.text}</p>
        </div>
      ))}
    </div>
  );
}
