import { useEffect, useRef, useState } from "react";
import { baseName } from "../../lib/fileView";
import { useSessionTabs, useWorkbench } from "../../stores/workbenchStore";
import Icon from "../ui/Icon";
import { fileIcon } from "./fileIcon";
import { useT } from "../../i18n";

/**
 * [Chat] [file tabs…] — the chat is always the first, fixed tab. Preview tabs
 * (italic) are reused by the next single-click open; double-click pins one.
 * Middle-click closes; drag reorders.
 */
export default function TabBar({ sid }: { sid: string }) {
  const t = useT();
  const { tabs, active } = useSessionTabs(sid);
  const { activate, closeTab, pinTab, moveTab, closeOthers } = useWorkbench.getState();
  const [drag, setDrag] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  // the same name twice → show the parent folder too
  const dup = (name: string) => tabs.filter((t) => baseName(t.path) === name).length > 1;

  return (
    <div ref={strip} className="no-scrollbar flex h-9 touch:h-11 shrink-0 items-stretch overflow-x-auto border-b border-border/70 bg-surface/30">
      <button
        data-tab="chat"
        data-active={active === null}
        onClick={() => activate(sid, null)}
        className={`relative flex shrink-0 items-center gap-1.5 border-r border-border/60 px-3 text-[12.5px] transition ${
          active === null ? "bg-bg text-content" : "text-content-faint hover:bg-surface-2/60 hover:text-content-dim"
        }`}
      >
        {active === null && <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
        <Icon name="chat" size={13} /> {t("files.chatTab")}
      </button>
      {tabs.map((tb, i) => {
        const name = baseName(tb.path);
        const parent = dup(name) ? tb.path.split("/").slice(-2, -1)[0] : "";
        const on = active === tb.id;
        const { icon, tone } = fileIcon(name);
        return (
          <div
            key={tb.id}
            data-active={on}
            draggable
            onDragStart={() => setDrag(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (drag !== null && drag !== i) moveTab(sid, drag, i);
              setDrag(null);
            }}
            onClick={() => activate(sid, tb.id)}
            onDoubleClick={() => pinTab(sid, tb.id)}
            onAuxClick={(e) => e.button === 1 && closeTab(sid, tb.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id: tb.id, x: e.clientX, y: e.clientY });
            }}
            title={`${tb.path}${tb.preview ? ` — ${t("files.previewTabHint")}` : ""}`}
            className={`group relative flex max-w-[220px] shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-border/60 pl-3 pr-1.5 text-[12.5px] transition ${
              on ? "bg-bg text-content" : "text-content-faint hover:bg-surface-2/60 hover:text-content-dim"
            }`}
          >
            {on && <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
            <Icon name={icon} size={13} className={`shrink-0 ${tone}`} />
            <span className={`truncate ${tb.preview ? "italic" : ""}`}>{name}</span>
            {parent && <span className="truncate text-[11px] text-content-faint">{parent}</span>}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(sid, tb.id);
              }}
              className={`ml-0.5 shrink-0 rounded p-0.5 touch:p-2 hover:bg-surface-3 hover:text-content ${
                on ? "opacity-100" : "opacity-60 sm:can-hover:opacity-0 group-hover:opacity-100"
              }`}
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        );
      })}
      {menu && (
        <div
          className="fixed z-[70] min-w-[170px] overflow-hidden rounded-lg border border-border bg-surface-2 py-1 text-[12.5px] shadow-float"
          style={{ left: Math.min(menu.x, window.innerWidth - 180), top: menu.y }}
        >
          {[
            [t("common.close"), () => closeTab(sid, menu.id)],
            [t("files.closeOthers"), () => closeOthers(sid, menu.id)],
            [t("files.closeAll"), () => closeOthers(sid, null)],
            [t("files.keepOpen"), () => pinTab(sid, menu.id)],
            [t("files.copyPath"), () => navigator.clipboard?.writeText(menu.id)],
          ].map(([label, fn]) => (
            <button
              key={label as string}
              onClick={() => (fn as () => void)()}
              className="block w-full px-3 py-1.5 text-left text-content-dim hover:bg-surface-3 hover:text-content"
            >
              {label as string}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
