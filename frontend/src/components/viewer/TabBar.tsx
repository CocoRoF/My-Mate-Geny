import { useEffect, useState, type DragEvent } from "react";
import { create } from "zustand";
import { baseName } from "../../lib/fileView";
import { CHAT, type Group, type Side } from "../../lib/editorLayout";
import { useSessionTabs, useWorkbench } from "../../stores/workbenchStore";
import Icon from "../ui/Icon";
import { fileIcon } from "./fileIcon";
import { useT } from "../../i18n";
import ScrollRow from "../ui/ScrollRow";

/** a tab being dragged (to another place in a bar, into another group, or onto a group's edge to split — EditorGrid) */
export const TAB_MIME = "application/x-geny-tab";
export const useTabDrag = create<{ tab: string | null; from: string | null }>(() => ({ tab: null, from: null }));
export const draggingTab = (e: DragEvent) => !!useTabDrag.getState().tab || e.dataTransfer.types.includes(TAB_MIME);

/**
 * One group's tabs (components/viewer/EditorGrid.tsx): the chat (always open, in one group) and files. Preview tabs
 * (italic) are reused by the next single-click open; double-click pins one; middle-click closes. A tab drags: within
 * the bar to reorder, onto another group's bar to move it there, onto a group's edge to split (the right-click menu
 * and the split button do the same without a drag — a phone). The focused group's shown tab has the accent line.
 */
export default function TabBar({ sid, group, focused, split }: { sid: string; group: Group; focused: boolean; split: boolean }) {
  const t = useT();
  const { tabs: files } = useSessionTabs(sid);
  const wb = useWorkbench.getState();
  const drag = useTabDrag();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [over, setOver] = useState<number | null>(null); // where a dragged tab would go (an index in this group)
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const byId = new Map(files.map((f) => [f.id, f]));
  const shown = group.tabs.filter((id) => id === CHAT || byId.has(id));
  // the same name twice → show the parent folder too
  const dup = (name: string) => files.filter((f) => baseName(f.path) === name).length > 1;

  const start = (e: DragEvent, id: string) => {
    e.dataTransfer.setData(TAB_MIME, id);
    e.dataTransfer.setData("text/plain", id === CHAT ? t("files.chatTab") : id);
    e.dataTransfer.effectAllowed = "move";
    // (a moment later: Chrome drops a drag whose page changes under it as it starts — the drop layers appear then)
    setTimeout(() => useTabDrag.setState({ tab: id, from: group.id }), 0);
  };
  const end = () => {
    useTabDrag.setState({ tab: null, from: null });
    setOver(null);
  };
  const overTab = (e: DragEvent, i: number) => {
    if (!draggingTab(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOver(e.clientX < r.left + r.width / 2 ? i : i + 1);
  };
  const drop = (e: DragEvent, index: number) => {
    const id = useTabDrag.getState().tab || e.dataTransfer.getData(TAB_MIME);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    // (the index among the bar's tabs → among the group's)
    const at = index >= shown.length ? group.tabs.length : group.tabs.indexOf(shown[index]);
    wb.moveTab(sid, id, group.id, at);
    end();
  };
  const splitAway = (id: string, side: Side) => wb.splitTab(sid, id, group.id, side);
  // (a group's only tab can't leave it for a split of its own — unless there are other groups to sit beside)
  const canSplit = group.tabs.length > 1 || split;
  type Item = { label: string; run: () => void; id?: string } | "-";
  const menuItems = (id: string): Item[] => {
    const out: Item[] = [];
    if (id !== CHAT)
      out.push(
        { label: t("common.close"), run: () => wb.closeTab(sid, id) },
        { label: t("files.closeOthers"), run: () => wb.closeOthers(sid, id) },
        { label: t("files.closeAll"), run: () => wb.closeOthers(sid, null, group.id) },
        { label: t("files.keepOpen"), run: () => wb.pinTab(sid, id) },
        { label: t("files.copyPath"), run: () => void navigator.clipboard?.writeText(id) },
      );
    const more: Item[] = [];
    if (canSplit)
      more.push(
        { label: t("files.splitRight"), run: () => splitAway(id, "right"), id: "split-right" },
        { label: t("files.splitDown"), run: () => splitAway(id, "bottom"), id: "split-down" },
      );
    if (split) more.push({ label: t("files.unsplit"), run: () => wb.unsplit(sid), id: "unsplit" });
    return out.length && more.length ? [...out, "-", ...more] : [...out, ...more];
  };

  return (
    <div
      className={`flex h-9 shrink-0 items-stretch border-b border-border/70 touch:h-11 ${focused ? "bg-surface/30" : "bg-surface/15"}`}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as globalThis.Node | null) && setOver(null)}
      data-testid="tab-bar"
      data-group={group.id}
    >
      <ScrollRow className="min-w-0 flex-1 items-stretch" watch={group.active} drag={false}>
        {shown.map((id, i) => {
          const chat = id === CHAT;
          const file = byId.get(id);
          const name = chat ? t("files.chatTab") : baseName(file!.path);
          const parent = !chat && dup(name) ? file!.path.split("/").slice(-2, -1)[0] : "";
          const on = group.active === id;
          const { icon, tone } = chat ? { icon: "chat" as const, tone: "" } : fileIcon(name);
          return (
            <div
              key={id}
              data-tab={chat ? "chat" : id}
              data-active={on}
              draggable
              onDragStart={(e) => start(e, id)}
              onDragEnd={end}
              onDragOver={(e) => overTab(e, i)}
              onDrop={(e) => drop(e, over ?? i)}
              onClick={() => wb.activate(sid, chat ? null : id)}
              onDoubleClick={() => !chat && wb.pinTab(sid, id)}
              onAuxClick={(e) => e.button === 1 && !chat && wb.closeTab(sid, id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id, x: e.clientX, y: e.clientY });
              }}
              title={chat ? undefined : `${file!.path}${file!.preview ? ` — ${t("files.previewTabHint")}` : ""}`}
              className={`group relative flex shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-border/60 text-[12.5px] transition ${
                chat ? "px-3" : "max-w-[220px] pl-3 pr-1.5"
              } ${on ? "bg-bg text-content" : "text-content-faint hover:bg-surface-2/60 hover:text-content-dim"} ${drag.tab === id ? "opacity-50" : ""}`}
            >
              {on && <span className={`absolute inset-x-0 top-0 h-[2px] ${focused ? "bg-accent" : "bg-content-faint/40"}`} />}
              {/* (where the dragged tab would go) */}
              {over === i && <span className="pointer-events-none absolute inset-y-1 -left-px w-[2px] rounded-full bg-accent" data-testid="tab-insert" />}
              {over === i + 1 && i === shown.length - 1 && <span className="pointer-events-none absolute inset-y-1 -right-px w-[2px] rounded-full bg-accent" data-testid="tab-insert" />}
              <Icon name={icon} size={13} className={`shrink-0 ${tone}`} />
              <span className={`truncate ${file?.preview ? "italic" : ""}`}>{name}</span>
              {parent && <span className="truncate text-[11px] text-content-faint">{parent}</span>}
              {!chat && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    wb.closeTab(sid, id);
                  }}
                  className={`ml-0.5 shrink-0 rounded p-0.5 touch:p-2 hover:bg-surface-3 hover:text-content ${
                    on ? "opacity-100" : "opacity-60 sm:can-hover:opacity-0 group-hover:opacity-100"
                  }`}
                  title={t("common.close")}
                  aria-label={t("common.close")}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          );
        })}
        {/* (the rest of the bar: a tab dropped here goes last) */}
        <div
          className="min-w-6 flex-1"
          onDragOver={(e) => {
            if (!draggingTab(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setOver(shown.length);
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => drop(e, shown.length)}
        />
      </ScrollRow>
      {canSplit && (
        <button
          onClick={() => splitAway(group.active, "right")}
          className="grid w-8 shrink-0 place-items-center text-content-faint transition hover:bg-surface-2/60 hover:text-content touch:w-11"
          title={t("files.splitRightTitle")}
          aria-label={t("files.splitRight")}
          data-testid="split-right"
        >
          <Icon name="split-right" size={14} />
        </button>
      )}
      {menu && (
        <div
          className="fixed z-[70] min-w-[190px] overflow-hidden rounded-lg border border-border bg-surface-2 py-1 text-[12.5px] shadow-float"
          style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 280) }}
          data-testid="tab-menu"
        >
          {menuItems(menu.id).map((item, i) =>
            item === "-" ? (
              <div key={`-${i}`} className="my-1 h-px bg-border" />
            ) : (
              <button
                key={item.label}
                onClick={item.run}
                className="block w-full px-3 py-1.5 text-left text-content-dim hover:bg-surface-3 hover:text-content"
                data-testid={item.id ? `tab-menu-${item.id}` : undefined}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
