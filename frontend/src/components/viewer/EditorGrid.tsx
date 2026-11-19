import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { Session } from "../../types";
import { CHAT, clampRatio, dropZone, groups, isSplit, shownDir, type Group, type Node, type Side, type Split } from "../../lib/editorLayout";
import { layoutOf, useSessionTabs, useWorkbench } from "../../stores/workbenchStore";
import TabBar, { draggingTab, TAB_MIME, useTabDrag } from "./TabBar";
import { useT } from "../../i18n";

const FileViewer = lazy(() => import("./FileViewer"));

/** a side narrower / lower than this is laid out the other way (a row split on a phone is drawn as a column) */
const MIN_W = 260;
const MIN_H = 150;

/**
 * A chat's tabs in groups side by side or one above the other (lib/editorLayout.ts; the store: stores/
 * workbenchStore.ts). Drag a tab onto a group: its edges split it (the side it would take lights up), its middle moves
 * the tab in. The line between two groups drags (double-click: halves; arrow keys when it has the focus). The chat is
 * a tab too: `chat` is drawn in the group that has it (under that group's files when one of them is shown). With one
 * group and no file open, nothing but the chat — as before splits.
 */
export default function EditorGrid({ session, chat }: { session: Session; chat: ReactNode }) {
  const sid = session.id;
  const st = useSessionTabs(sid);
  const layout = layoutOf(st);
  const split = isSplit(layout);
  // Ctrl/⌘ + \ : the focused group's shown tab into a new group on its right (VS Code's key)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "\\" || e.altKey) return;
      const l = layoutOf(useWorkbench.getState().bySession[sid] || { tabs: [], active: null });
      const g = groups(l.root).find((x) => x.id === l.focus) || groups(l.root)[0];
      if (g.tabs.length < 2 && g.active !== CHAT && !isSplit(l)) return;
      e.preventDefault();
      useWorkbench.getState().splitTab(sid, g.active, g.id, e.shiftKey ? "bottom" : "right");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sid]);
  return (
    <div className="relative flex min-h-0 flex-1" data-testid="editor-grid" data-split={split}>
      <NodeView sid={sid} session={session} node={layout.root} focus={layout.focus} split={split} chat={chat} hasFiles={st.tabs.length > 0} />
    </div>
  );
}

function NodeView(p: { sid: string; session: Session; node: Node; focus: string; split: boolean; chat: ReactNode; hasFiles: boolean }) {
  if (p.node.kind === "group") return <GroupView {...p} group={p.node} />;
  return <SplitView {...p} node={p.node} />;
}

function useSize(): [(el: HTMLDivElement | null) => void, { w: number; h: number }, HTMLDivElement | null] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size, el];
}

function SplitView(p: { sid: string; session: Session; node: Split; focus: string; split: boolean; chat: ReactNode; hasFiles: boolean }) {
  const { node } = p;
  const [ref, size, el] = useSize();
  const dir = shownDir(node.dir, size.w, MIN_W);
  const row = dir === "row";
  // (each side keeps its minimum: the ratio a drag can reach at this size)
  const total = row ? size.w : size.h;
  const min = total > 0 ? Math.min(0.45, (row ? MIN_W : MIN_H) / total) : 0;
  const ratio = Math.min(1 - min, Math.max(min, node.ratio));
  return (
    <div ref={ref} className={`flex min-h-0 min-w-0 flex-1 ${row ? "flex-row" : "flex-col"}`} data-testid="split" data-dir={dir}>
      <div className="flex min-h-0 min-w-0" style={{ flex: `${ratio} 1 0%` }} data-testid="split-side">
        <NodeView {...p} node={node.a} />
      </div>
      <Sash sid={p.sid} split={node} row={row} container={el} min={min} ratio={ratio} />
      <div className="flex min-h-0 min-w-0" style={{ flex: `${1 - ratio} 1 0%` }} data-testid="split-side">
        <NodeView {...p} node={node.b} />
      </div>
    </div>
  );
}

/** the line between two groups: drag it (pointer or touch), double-click for halves, arrow keys when focused */
function Sash({ sid, split, row, container, min, ratio }: { sid: string; split: Split; row: boolean; container: HTMLDivElement | null; min: number; ratio: number }) {
  const t = useT();
  const [moving, setMoving] = useState(false);
  const frame = useRef(0);
  const set = useCallback(
    (r: number) => useWorkbench.getState().resizeSplit(sid, split.id, Math.min(1 - min, Math.max(min, clampRatio(r)))),
    [sid, split.id, min],
  );
  const onPointerDown = (e: React.PointerEvent) => {
    if (!container || e.button !== 0) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setMoving(true);
    const rect = container.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => set(row ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height));
    };
    const up = () => {
      setMoving(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const back = row ? "ArrowLeft" : "ArrowUp";
    const fwd = row ? "ArrowRight" : "ArrowDown";
    if (e.key === back) set(ratio - step);
    else if (e.key === fwd) set(ratio + step);
    else if (e.key === "Home") set(min);
    else if (e.key === "End") set(1 - min);
    else if (e.key === "Enter") set(0.5);
    else return;
    e.preventDefault();
  };
  return (
    <>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation={row ? "vertical" : "horizontal"}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round((1 - min) * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        aria-label={t("files.resizeSplit")}
        title={t("files.resizeSplitHint")}
        onPointerDown={onPointerDown}
        onDoubleClick={() => set(0.5)}
        onKeyDown={onKeyDown}
        className={`group/sash relative z-30 shrink-0 touch-none outline-none ${row ? "w-px cursor-col-resize" : "h-px cursor-row-resize"} ${
          moving ? "bg-accent" : "bg-border"
        }`}
        data-testid="sash"
        data-ratio={ratio.toFixed(3)}
      >
        {/* the part a pointer can take (wider than the line — wider still on a touch screen), and in it the accent the
            line shows when held, hovered a moment or focused */}
        <span className={`absolute ${row ? "inset-y-0 -left-[4px] w-[9px] touch:-left-[10px] touch:w-[21px]" : "inset-x-0 -top-[4px] h-[9px] touch:-top-[10px] touch:h-[21px]"}`}>
          <span
            className={`absolute rounded-full transition-colors delay-150 duration-150 ${row ? "inset-y-0 left-1/2 w-[3px] -translate-x-1/2" : "inset-x-0 top-1/2 h-[3px] -translate-y-1/2"} ${
              moving ? "bg-accent/70 delay-0" : "group-hover/sash:bg-accent/50 group-focus-visible/sash:bg-accent/60"
            }`}
          />
        </span>
      </div>
      {/* while it moves, nothing under the pointer (a PDF's frame, an editor) takes its events */}
      {moving && <div className={`fixed inset-0 z-[80] ${row ? "cursor-col-resize" : "cursor-row-resize"}`} />}
    </>
  );
}

function GroupView({ sid, session, group, focus, split, chat, hasFiles }: { sid: string; session: Session; group: Group; focus: string; split: boolean; chat: ReactNode; hasFiles: boolean }) {
  const t = useT();
  const { tabs: files } = useSessionTabs(sid);
  const focused = group.id === focus;
  const hasChat = group.tabs.includes(CHAT);
  const dragging = useTabDrag((s) => s.tab);
  const [zone, setZone] = useState<Side | "center" | null>(null);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (group.active !== CHAT) setVisited((v) => (v.has(group.active) ? v : new Set(v).add(group.active)));
  }, [group.active]);
  useEffect(() => {
    if (!dragging) setZone(null);
  }, [dragging]);
  const mine = files.filter((f) => group.tabs.includes(f.id) && (f.id === group.active || visited.has(f.id)));

  const over = (e: DragEvent) => {
    if (!draggingTab(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setZone(dropZone((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height));
  };
  const drop = (e: DragEvent) => {
    const id = useTabDrag.getState().tab || e.dataTransfer.getData(TAB_MIME);
    const z = zone;
    setZone(null);
    useTabDrag.setState({ tab: null, from: null });
    if (!id || !z) return;
    e.preventDefault();
    const wb = useWorkbench.getState();
    if (z !== "center") wb.splitTab(sid, id, group.id, z);
    else if (group.tabs.includes(id)) wb.activate(sid, id === CHAT ? null : id); // (back where it was)
    else wb.moveTab(sid, id, group.id);
  };
  // the part of the group a drop there would take
  const box: Record<Side | "center", string> = {
    center: "inset-0",
    left: "inset-y-0 left-0 right-1/2",
    right: "inset-y-0 left-1/2 right-0",
    top: "inset-x-0 top-0 bottom-1/2",
    bottom: "inset-x-0 top-1/2 bottom-0",
  };
  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onPointerDownCapture={() => !focused && useWorkbench.getState().focusGroup(sid, group.id)}
      onFocusCapture={() => !focused && useWorkbench.getState().focusGroup(sid, group.id)}
      aria-label={split ? t("files.groupLabel", { n: groupIndex(sid, group.id) }) : undefined}
      data-testid="editor-group"
      data-group={group.id}
      data-focused={focused}
    >
      {(split || hasFiles) && <TabBar sid={sid} group={group} focused={focused || !split} split={split} />}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {hasChat ? chat : group.active === CHAT ? null : <div className="flex-1 bg-bg" />}
        {mine.map((f) => (
          <div key={f.id} className={`absolute inset-0 z-20 bg-bg ${f.id === group.active ? "" : "invisible pointer-events-none"}`}>
            <Suspense fallback={null}>
              <FileViewer session={session} tab={f} />
            </Suspense>
          </div>
        ))}
        {/* a tab being dragged: this layer takes the drag (over a PDF's frame too) and shows where it would go */}
        {dragging && (
          <div className="absolute inset-0 z-40" onDragOver={over} onDragLeave={() => setZone(null)} onDrop={drop} data-testid="drop-layer">
            {zone && (
              <div
                className={`pointer-events-none absolute ${box[zone]} m-1 rounded-lg border-2 border-accent/50 bg-accent/10 backdrop-blur-[1px] transition-all duration-150 ease-out`}
                data-testid="drop-zone"
                data-zone={zone}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const groupIndex = (sid: string, id: string) => {
  const l = layoutOf(useWorkbench.getState().bySession[sid] || { tabs: [], active: null });
  return groups(l.root).findIndex((g) => g.id === id) + 1;
};
