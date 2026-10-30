import { useState } from "react";
import type { TurnChanges } from "../../types";
import { useSessionStore } from "../../stores/sessionStore";
import Icon from "../ui/Icon";
import ChangesModal, { STATUS } from "./ChangesModal";

const MAX = 5;

/** "3 files changed +173 −1" at the end of a turn (Claude Code style). */
export default function TurnChangesCard({ changes }: { changes: TurnChanges }) {
  const sid = useSessionStore((s) => s.activeId);
  const [open, setOpen] = useState<{ repo: number; path: string } | null | "all">(null);
  if (!sid || !changes.files) return null;
  const flat = changes.repos.flatMap((r, ri) => r.files.map((f) => ({ ri, f })));
  const shown = flat.slice(0, MAX);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface/60">
      <div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2">
        <span className="text-[13px] font-medium text-content">
          {changes.files} file{changes.files === 1 ? "" : "s"} changed
        </span>
        <span className="ml-auto font-mono text-[11.5px]">
          <span className="text-success">+{changes.added}</span> <span className="text-danger">−{changes.removed}</span>
        </span>
      </div>
      <div className="py-1">
        {shown.map(({ ri, f }) => {
          const st = STATUS[f.status] || STATUS.M;
          return (
            <button
              key={`${ri}:${f.path}`}
              onClick={() => setOpen({ repo: ri, path: f.path })}
              className="flex w-full items-center gap-2.5 px-3.5 py-1 text-left hover:bg-surface-2/70"
            >
              <Icon name="file-code" size={13} className="shrink-0 text-content-faint" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-content-dim">
                {f.path.split("/").pop()}
                <span className="ml-1.5 text-[11px] text-content-faint">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
              </span>
              <span className={`w-3 font-mono text-[10.5px] ${st.cls}`}>{st.label}</span>
              <span className="w-16 shrink-0 text-right font-mono text-[11px]">
                {f.binary ? (
                  <span className="text-content-faint">bin</span>
                ) : (
                  <>
                    <span className="text-success">+{f.added ?? 0}</span> <span className="text-danger">−{f.removed ?? 0}</span>
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <button
        onClick={() => setOpen("all")}
        className="flex w-full items-center gap-2 border-t border-border/70 px-3.5 py-2 text-left text-[12.5px] text-content-dim hover:bg-surface-2/70 hover:text-content"
      >
        {flat.length > MAX ? `View all ${flat.length} files` : "View all changes"}
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <ChangesModal
          sid={sid}
          changes={changes}
          initial={
            open === "all"
              ? undefined
              : (() => {
                  const f = changes.repos[open.repo].files.find((x) => x.path === open.path);
                  return f ? { repo: open.repo, file: f } : undefined;
                })()
          }
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
