import { useEffect, useRef } from "react";
import type { Session } from "../../../types";
import { useWorkbench } from "../../../stores/workbenchStore";
import { useT } from "../../../i18n";
import ExplorerPanel from "../../explorer/ExplorerPanel";
import SessionPanel from "./SessionPanel";

/** One stable shell and width. Switching only changes the visible body; scroll and section state survive. */
export default function RightSidebar({ session }: { session: Session }) {
  const t = useT();
  const kind = useWorkbench(s => s.sidePanel);
  const width = useWorkbench(s => s.panelWidth);
  const setWidth = useWorkbench(s => s.setPanelWidth);
  const setPanel = useWorkbench(s => s.setSidePanel);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const opened = useRef(false);
  if (kind) opened.current = true;
  useEffect(() => () => { document.body.style.cursor = ""; }, []);
  return <>
    <div hidden={!kind} className={`${kind ? "" : "hidden"} fixed inset-0 z-30 bg-scrim/45 xl:hidden`} onClick={() => setPanel(null)} data-testid="right-sidebar-backdrop" />
    <aside hidden={!kind} data-testid="right-sidebar" data-panel={kind ?? "closed"} style={{ width }}
      className={`${kind ? "flex" : "hidden"} fixed inset-y-0 top-[var(--window-chrome-height,0px)] right-0 z-40 max-w-[92vw] shrink-0 flex-col border-l border-border bg-surface pt-safe pb-safe shadow-float xl:relative xl:top-auto xl:z-auto xl:pt-0 xl:shadow-none`}>
      <div role="separator" aria-orientation="vertical" aria-label={t("files.dragResize")} aria-valuemin={220} aria-valuemax={640} aria-valuenow={width} tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize hover:bg-accent/30 focus:bg-accent/30 xl:block"
        onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, width }; document.body.style.cursor = "col-resize"; }}
        onPointerMove={e => { if (drag.current) setWidth(drag.current.width + drag.current.x - e.clientX); }}
        onPointerUp={e => { drag.current = null; document.body.style.cursor = ""; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={() => { drag.current = null; document.body.style.cursor = ""; }}
        onLostPointerCapture={() => { drag.current = null; document.body.style.cursor = ""; }}
        onKeyDown={e => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
          e.preventDefault(); setWidth(e.key === "Home" ? 220 : e.key === "End" ? 640 : width + (e.key === "ArrowLeft" ? 20 : -20));
        }} />
      {opened.current && <>
        <div hidden={kind !== "explorer"} className="h-full min-h-0" data-sidebar-body="explorer">
          <ExplorerPanel session={session} active={kind === "explorer"} onClose={() => setPanel(null)} onOpened={() => window.innerWidth < 1280 && setPanel(null)} />
        </div>
        <div hidden={kind !== "session"} className="h-full min-h-0" data-sidebar-body="session">
          <SessionPanel session={session} onClose={() => setPanel(null)} />
        </div>
      </>}
    </aside>
  </>;
}
