/**
 * The heart panel's 네트워크 tab (docs/mate-memory-graph.md "The heart panel"): her memory network as a map — what she
 * knows, what connects to what, and how vivid each thing is in her mind now — with a search, a filter (everything /
 * about the user / what she learned), fading on or off, a legend that highlights one kind, a full-screen view, and
 * the selected thing's details: beside the map when there is room, under it otherwise. It follows the server's pushes
 * (a study filing facts, an edit elsewhere).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getMemoryGraph, searchMemoryGraph, type GraphKind, type GraphNode, type GraphSearch, type GraphSnapshot, type Mate } from "../../../api/mates";
import { useT, type MsgKey } from "../../../i18n";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import MemoryGraph, { KIND_COLOR, type MemoryGraphHandle } from "./MemoryGraph";
import NodeDetail, { kindLabel, strengthWord } from "./NodeDetail";

type Origin = "all" | "personal" | "knowledge";
const LEGEND: GraphKind[] = ["user", "person", "place", "game", "work", "org", "topic", "concept", "event", "thing"];
/** from this width the details sit beside the map */
const SIDE_BY_SIDE = 820;

function useWindowHeight() {
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return h;
}

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
  const [kind, setKind] = useState<GraphKind | null>(null);
  const [full, setFull] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [width, setWidth] = useState(0);
  const winH = useWindowHeight();
  const graph = useRef<MemoryGraphHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
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
    // (a kind's name — "게임", "people" — finds the things of that kind too)
    const q = query.trim().toLowerCase();
    const byKind = LEGEND.filter((k) => k !== "user" && (kindLabel(t, k).toLowerCase() === q || k === q));
    const timer = setTimeout(() => {
      searchMemoryGraph(mate.id, query.trim())
        .then((r) => {
          if (dead) return;
          const extra = (snap?.nodes ?? []).filter((n) => byKind.includes(n.kind) && !r.nodes.some((x) => x.id === n.id));
          setFound(extra.length ? { ...r, nodes: [...r.nodes, ...extra] } : r);
        })
        .catch(() => !dead && setFound(null));
    }, 300);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [query, mate.id, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const kinds = useMemo(() => {
    const m = new Map<GraphKind, number>();
    for (const n of snap?.nodes ?? []) if (n.kind !== "self") m.set(n.kind, (m.get(n.kind) ?? 0) + 1);
    return m;
  }, [snap]);
  const highlight = useMemo(() => {
    if (found) return new Set(found.nodes.map((n) => n.id));
    if (kind) return new Set((snap?.nodes ?? []).filter((n) => n.kind === kind).map((n) => n.id));
    return new Set<string>();
  }, [found, kind, snap]);
  const select = useCallback((id: string | null) => setSelected(id), []);
  const go = (id: string) => {
    setSelected(id);
    setTimeout(() => graph.current?.center(id), 50);
  };
  const nameOf = (n: GraphNode) => (n.kind === "user" ? t("memgraph.userNode") : n.kind === "self" ? mate.name : n.name);
  const tooltip = (n: GraphNode) => (
    <>
      <span className="flex items-center gap-1.5 font-semibold text-content">
        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
        <span className="truncate">{nameOf(n)}</span>
      </span>
      <span className="mt-0.5 block text-content-faint">
        {kindLabel(t, n.kind)} · {strengthWord(t, n.strength)}
        {n.facts > 0 && <> · {t("memgraph.facts", { n: n.facts })}</>}
        {n.memories > 0 && <> · {t("memgraph.tipMemories", { n: n.memories })}</>}
      </span>
      {n.summary && <span className="mt-0.5 block text-content-dim line-clamp-2">{n.summary}</span>}
    </>
  );
  const empty = snap && snap.nodes.filter((n) => n.kind !== "user" && n.kind !== "self").length === 0;

  const body = (big: boolean) => {
    const side = big ? window.innerWidth >= 900 : width >= SIDE_BY_SIDE;
    const mapH = big ? Math.max(360, winH - 200) : side ? Math.round(Math.min(700, Math.max(420, winH * 0.62))) : Math.round(Math.min(480, Math.max(300, winH * 0.48)));
    const details = (
      <>
        {found && !selected && <SearchResults found={found} onPick={go} selfName={mate.name} />}
        {selected && (
          <NodeDetail key={selected} mateId={mate.id} nodeId={selected} selfName={mate.name} onNavigate={go}
            onClose={() => setSelected(null)} onChanged={() => setRefresh((n) => n + 1)} />
        )}
        {side && !selected && !found && !empty && (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-[12.5px] leading-relaxed text-content-faint" data-testid="memory-graph-pick">
            {t("memgraph.pickHint")}
          </p>
        )}
      </>
    );
    return (
      <div className={side ? "flex min-h-0 gap-4" : "space-y-3"} style={big ? { height: "100%" } : undefined}>
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[12rem] flex-1">
              <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-faint" />
              <input className="field !py-1.5 !pl-8 text-[12.5px]" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("memgraph.search")} data-testid="memory-graph-search" />
            </label>
            <div className="flex overflow-hidden rounded-lg border border-border text-[12px]" role="group">
              {(["all", "personal", "knowledge"] as const).map((o) => (
                <button key={o} type="button" className={`px-2.5 py-1.5 ${origin === o ? "bg-accent text-white" : "text-content-dim hover:bg-surface-3"}`} aria-pressed={origin === o} onClick={() => setOrigin(o)} data-testid={`memory-graph-origin-${o}`}>
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
            <div className="flex items-center justify-center rounded-xl border border-border bg-surface/60 text-[12px] text-content-faint" style={{ height: mapH }}>{t("common.loading")}</div>
          ) : empty ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 text-center text-[12.5px] leading-relaxed text-content-dim" style={{ height: Math.min(mapH, 260) }} data-testid="memory-graph-empty">
              <Icon name="network" size={22} className="text-content-faint" />
              <p className="max-w-sm">{t("memgraph.empty", { name: mate.name })}</p>
              {onStudy && (
                <button className="btn-soft !py-1 text-[12.5px]" onClick={onStudy}>
                  <Icon name="book" size={13} /> {t("memgraph.emptyStudy")}
                </button>
              )}
            </div>
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
              height={mapH}
              userLabel={t("memgraph.userNode")}
              selfLabel={mate.name}
              label={t("memgraph.mapLabel", { name: mate.name })}
              tooltip={tooltip}
              controls={{
                zoomIn: t("memgraph.zoomIn"),
                zoomOut: t("memgraph.zoomOut"),
                fit: t("memgraph.fit"),
                extra: !big && (
                  <button type="button" className="mem-graph-btn" onClick={() => setFull(true)} title={t("memgraph.full")} aria-label={t("memgraph.full")} data-testid="memory-graph-full">
                    <Icon name="maximize" size={14} />
                  </button>
                ),
              }}
            />
          )}
          {snap && !empty && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-content-faint">
              <span className="flex flex-wrap gap-x-2.5" data-testid="memory-graph-stats">
                <span>{t("memgraph.statNodes", { n: snap.stats.nodes })}</span>
                <span>{t("memgraph.statFacts", { n: snap.stats.facts })}</span>
                <span>{t("memgraph.statDocs", { n: snap.stats.docs })}</span>
                {snap.stats.shown < snap.stats.nodes && <span>{t("memgraph.statShown", { n: snap.stats.shown })}</span>}
                {!!snap.stats.unlinked && <span className="text-accent">{t("memgraph.linking", { n: snap.stats.unlinked })}</span>}
              </span>
            </div>
          )}
          {snap && !empty && (
            <div className="flex flex-wrap items-center gap-1" data-testid="memory-graph-legend">
              {LEGEND.filter((k) => kinds.has(k)).map((k) => (
                <button key={k} type="button" aria-pressed={kind === k} title={t("memgraph.legendHint")}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${kind === k ? "border-accent/60 bg-accent-soft text-content" : "border-transparent text-content-faint hover:bg-surface-3 hover:text-content-dim"}`}
                  onClick={() => setKind(kind === k ? null : k)} data-testid={`memory-graph-kind-${k}`}>
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLOR[k] }} />
                  {k === "user" ? t("memgraph.userNode") : kindLabel(t, k)}
                  <span className="text-content-faint">{kinds.get(k)}</span>
                </button>
              ))}
              <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-content-faint"><span className="inline-block w-4 border-t border-dashed border-content-faint" />{t("memgraph.legendMemory")}</span>
              <span className="ml-1.5 inline-flex items-center gap-1 text-[11px] text-content-faint"><span className="inline-block w-4 border-t border-content-faint" />{t("memgraph.legendFact")}</span>
            </div>
          )}
        </div>
        {side ? (
          <div className="w-[360px] shrink-0 space-y-2 overflow-y-auto pr-0.5" style={{ maxHeight: big ? "100%" : mapH + 96 }}>{details}</div>
        ) : (
          <div className="space-y-2">{details}</div>
        )}
      </div>
    );
  };
  return (
    <div ref={box} className="space-y-3" data-testid="memory-network">
      <p className="text-[12.5px] leading-relaxed text-content-dim">{t("memgraph.hint", { name: mate.name })}</p>
      {!full && body(false)}
      {full &&
        createPortal(
          <div className="fixed inset-0 z-[60] flex flex-col bg-surface p-3 sm:p-4" data-testid="memory-graph-fullscreen">
            <div className="mb-3 flex items-center gap-2">
              <Icon name="network" size={16} className="text-accent" />
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
    return <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-[12px] text-content-faint">{t("memgraph.noResults")}</p>;
  return (
    <div className="space-y-2.5 rounded-xl border border-border bg-surface-2/50 p-3 text-[12.5px]" data-testid="memory-graph-results">
      {found.nodes.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-[11.5px] font-semibold text-content-dim">{t("memgraph.resultsThings")}</h4>
          <div className="flex flex-wrap gap-1">
            {found.nodes.map((n) => (
              <button key={n.id} className="pill border border-border bg-surface-3/50 text-content-dim hover:text-content" onClick={() => onPick(n.id)}>
                <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
                {n.kind === "user" ? t("memgraph.userNode") : n.kind === "self" ? selfName : n.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {found.facts.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-[11.5px] font-semibold text-content-dim">{t("memgraph.resultsFacts")}</h4>
          {found.facts.slice(0, 8).map((f) => (
            <button key={f.id} className="block w-full rounded-lg border border-border/60 px-2.5 py-1.5 text-left hover:bg-surface-3/40" onClick={() => onPick(f.subject)}>
              <span className="font-medium text-content">{f.subject_name}</span> <span className="text-content-dim">{f.statement}</span>
            </button>
          ))}
        </div>
      )}
      {found.passages.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-[11.5px] font-semibold text-content-dim">{t("memgraph.resultsPages")}</h4>
          {found.passages.slice(0, 4).map((p) => (
            <div key={p.chunk_id} className="rounded-lg border border-border/40 px-2.5 py-1.5 text-[12px] text-content-faint">
              <a className="text-link underline" href={p.url} target="_blank" rel="noreferrer">{p.title}</a>
              <p className="mt-0.5 line-clamp-3">{p.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
