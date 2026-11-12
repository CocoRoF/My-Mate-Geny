import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { changesDiff, fileText, revertChanges } from "../../api/sessions";
import type { ChangedFile, TurnChanges } from "../../types";
import Icon from "../ui/Icon";
import { useBackHandler } from "../../lib/back";
import { parsePatch, type PatchFile } from "./parsePatch";
import PatchView from "./PatchView";
import { useT } from "../../i18n";
import { confirmDialog } from "../ui/ConfirmDialog";

export const STATUS: Record<string, { label: string; cls: string }> = {
  A: { label: "A", cls: "text-success" },
  M: { label: "M", cls: "text-warning" },
  D: { label: "D", cls: "text-danger" },
  R: { label: "R", cls: "text-accent" },
  C: { label: "C", cls: "text-accent" },
};

const base = (p: string) => p.split("/").pop() || p;
const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

interface Sel {
  repo: number;
  file: ChangedFile;
}

export default function ChangesModal({
  sid,
  changes,
  initial,
  onClose,
  onReverted,
}: {
  sid: string;
  changes: TurnChanges;
  initial?: Sel;
  onClose: () => void;
  onReverted?: () => void;
}) {
  const t = useT();
  const first: Sel | undefined = initial || (changes.repos[0]?.files[0] ? { repo: 0, file: changes.repos[0].files[0] } : undefined);
  const [sel, setSel] = useState<Sel | undefined>(first);
  const [patch, setPatch] = useState<PatchFile | null>(null);
  const [whole, setWhole] = useState<string | null>(null);
  const [mode, setMode] = useState<"diff" | "file">("diff");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reverted, setReverted] = useState<Set<string>>(new Set());
  const multiRepo = changes.repos.length > 1;
  useBackHandler(true, onClose);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  useEffect(() => {
    if (!sel || changes.eid === undefined) return;
    let alive = true;
    setPatch(null);
    setWhole(null);
    setError("");
    changesDiff(sid, changes.eid, sel.repo, sel.file.path)
      .then((r) => alive && setPatch(parsePatch(r.patch)[0] || { path: sel.file.path, binary: false, lines: [] }))
      .catch((e) => alive && setError(String(e.message || e)));
    return () => {
      alive = false;
    };
  }, [sid, changes.eid, sel]);

  useEffect(() => {
    if (mode !== "file" || !sel || whole !== null) return;
    const root = changes.repos[sel.repo].root;
    const repo = changes.repos[sel.repo];
    fileText(sid, `${root}/${sel.file.path}`, "connection_id" in repo ? repo.connection_id : undefined)
      .then((r) => setWhole(r.content + (r.truncated ? `\n… (${t("files.truncated")})` : "")))
      .catch((e) => setWhole(`(${e.message || e})`));
  }, [mode, sel, whole, sid, changes.repos]);

  const revert = async (repo?: number, paths?: string[]) => {
    if (changes.eid === undefined) return;
    const ask = paths
      ? t("files.revertConfirmPaths", { what: paths.map(base).join(", "), count: paths.length })
      : t("files.revertConfirmAll", { count: changes.files });
    if (!(await confirmDialog({ body: ask, confirmLabel: t(paths ? "files.undoFile" : "files.undoTurn"), danger: true }))) return;
    setBusy(paths ? paths[0] : "all");
    try {
      const r = await revertChanges(sid, changes.eid, { repo, paths });
      setReverted((s) => new Set([...s, ...r.reverted]));
      onReverted?.();
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy("");
    }
  };

  const total = useMemo(() => ({ add: changes.added, del: changes.removed }), [changes]);

  return createPortal(
    <div className="fixed inset-0 top-[var(--window-chrome-height,0px)] z-[95] flex flex-col bg-bg/95 pt-safe pb-safe backdrop-blur-sm animate-fade-in" data-testid="changes-modal">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <Icon name="pencil" size={16} className="text-accent" />
        <span className="text-sm font-semibold">
          {t("files.filesChanged", { count: changes.files })}
        </span>
        <span className="font-mono text-[12px]">
          <span className="text-success">+{total.add}</span> <span className="text-danger">−{total.del}</span>
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <button onClick={() => revert()} disabled={!!busy} className="btn-ghost py-1 px-2.5 text-[12px] text-danger hover:text-danger">
            {busy === "all" ? <Icon name="spinner" size={13} spin /> : <Icon name="refresh" size={13} />} {t("files.undoTurn")}
          </button>
          <button onClick={onClose} className="btn-ghost py-1 px-2" title={t("files.closeEsc")}>
            <Icon name="x" size={18} />
          </button>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="max-h-[38vh] shrink-0 overflow-y-auto border-b border-border md:max-h-none md:w-72 md:border-b-0 md:border-r">
          {changes.repos.map((r, ri) => (
            <div key={r.root} className="py-1">
              {multiRepo && <div className="truncate px-3 py-1 font-mono text-[10.5px] text-content-faint">{r.root}</div>}
              {r.files.map((f) => {
                const active = sel && sel.repo === ri && sel.file.path === f.path;
                const st = STATUS[f.status] || STATUS.M;
                return (
                  <button
                    key={f.path}
                    onClick={() => {
                      setSel({ repo: ri, file: f });
                      setMode("diff");
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${active ? "bg-surface-3" : "hover:bg-surface-2"}`}
                  >
                    <span className={`w-3 shrink-0 font-mono text-[11px] ${st.cls}`}>{st.label}</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[12.5px] ${reverted.has(f.path) ? "text-content-faint line-through" : "text-content"}`}>
                        {base(f.path)}
                      </span>
                      {dir(f.path) && <span className="block truncate font-mono text-[10.5px] text-content-faint">{dir(f.path)}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-[10.5px]">
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
              {r.truncated && <p className="px-3 py-1 text-[11px] text-content-faint">{t("files.moreNotShown")}</p>}
            </div>
          ))}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {sel && (
            <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-2">
              <span className="min-w-0 truncate font-mono text-[12px] text-content-dim">
                {sel.file.old_path ? `${sel.file.old_path} → ` : ""}
                {sel.file.path}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <div className="flex rounded-lg border border-border p-0.5">
                  {(["diff", "file"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      disabled={m === "file" && sel.file.status === "D"}
                      className={`rounded-md px-2 py-0.5 text-[11.5px] ${mode === m ? "bg-surface-3 text-content" : "text-content-faint"} disabled:opacity-40`}
                    >
                      {m === "diff" ? t("files.changes") : t("files.wholeFile")}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => revert(sel.repo, [sel.file.path])}
                  disabled={!!busy || reverted.has(sel.file.path)}
                  className="btn-ghost py-1 px-2 text-[11.5px]"
                  title={t("files.undoFileTitle")}
                >
                  {busy === sel.file.path ? <Icon name="spinner" size={12} spin /> : <Icon name="refresh" size={12} />} {t("files.undoFile")}
                </button>
              </span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto">
            {error && <p className="p-4 text-xs text-danger">{error}</p>}
            {!error && mode === "diff" && (patch ? <PatchView file={patch} /> : <Icon name="spinner" size={18} spin className="m-4 text-content-faint" />)}
            {!error && mode === "file" && (
              <pre className="whitespace-pre p-4 font-mono text-[12px] leading-[1.6] text-content-dim">
                {whole === null ? t("common.loading") : whole}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
