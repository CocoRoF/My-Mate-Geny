import { useEffect, useMemo, useRef, useState } from "react";
import { listDir } from "../../api/workspaces";
import type { DirEntry } from "../../types";
import Icon from "../ui/Icon";
import { useT } from "../../i18n";

interface Props {
  connectionId: string | null;
  initialPath: string;
  onPick: (path: string) => void;
  selected: string | null;
}

const RECENTS_KEY = "hrh_recent_folders";

export function loadRecents(conn: string | null): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(RECENTS_KEY) || "{}");
    return (all[conn || "local"] || []).slice(0, 6);
  } catch {
    return [];
  }
}
export function pushRecent(conn: string | null, path: string) {
  try {
    const all = JSON.parse(localStorage.getItem(RECENTS_KEY) || "{}");
    const key = conn || "local";
    const list = [path, ...(all[key] || []).filter((p: string) => p !== path)].slice(0, 6);
    all[key] = list;
    localStorage.setItem(RECENTS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

export default function FileTree({ connectionId, initialPath, onPick, selected }: Props) {
  const t = useT();
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const recents = useMemo(() => loadRecents(connectionId), [connectionId, selected]);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setError("");
    setLoading(true);
    setQuery("");
    listDir(path, connectionId)
      .then((r) => {
        if (!alive) return;
        setEntries(r.entries);
        // Remote paths come back resolved (absolute): adopt them so
        // breadcrumbs and ".." work from the real location.
        if (r.path && r.path !== path) setPath(r.path);
      })
      .catch((e) => alive && setError(String(e.message || e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, connectionId]);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  const segments = path.split("/").filter(Boolean);
  const dirs = entries
    .filter((e) => e.is_dir)
    .filter((e) => e.name.toLowerCase().includes(query.toLowerCase()));

  const go = (p: string) => {
    setPath(p || "/");
    setEditing(false);
  };
  const pick = (p: string) => {
    pushRecent(connectionId, p);
    onPick(p);
  };
  const isSelected = selected === path;

  return (
    <div className="rounded-xl border border-border bg-surface/40 overflow-hidden">
      {/* Breadcrumb / path bar */}
      <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-border bg-surface-2/40 min-h-[40px]">
        {editing ? (
          <input
            ref={editRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) go(draft);
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={() => setEditing(false)}
            placeholder={t("workspace.pathPlaceholder")}
            className="flex-1 bg-transparent font-mono text-[12px] text-content outline-none"
          />
        ) : (
          <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto text-[12px]">
            <button onClick={() => go("/")} className="text-content-faint hover:text-content px-1">/</button>
            {segments.map((seg, i) => {
              const sp = "/" + segments.slice(0, i + 1).join("/");
              return (
                <span key={sp} className="flex items-center">
                  <button
                    onClick={() => go(sp)}
                    className={`px-1 rounded hover:bg-surface-3 hover:text-content transition ${
                      i === segments.length - 1 ? "text-content font-medium" : "text-content-dim"
                    }`}
                  >
                    {seg}
                  </button>
                  {i < segments.length - 1 && <span className="text-content-faint">/</span>}
                </span>
              );
            })}
          </div>
        )}
        <button
          onClick={() => {
            setDraft(path);
            setEditing((v) => !v);
          }}
          className="text-content-faint hover:text-content p-1 shrink-0"
          title={t("workspace.editPath")}
          aria-label={t("workspace.editPath")}
        >
          <Icon name="pencil" size={13} />
        </button>
        <button
          onClick={() => pick(path)}
          className={`pill shrink-0 transition ${
            isSelected ? "bg-accent text-white" : "bg-accent-soft text-accent hover:bg-accent/20"
          }`}
        >
          {isSelected ? (
            <>
              <Icon name="check" size={11} /> {t("workspace.selected")}
            </>
          ) : (
            t("workspace.useThis")
          )}
        </button>
      </div>

      {/* Quick access + search */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border/60">
        <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
          <button onClick={() => setPath("/home")} className="pill bg-surface-3 text-content-dim hover:text-content shrink-0">
            /home
          </button>
          {recents.map((r) => (
            <button
              key={r}
              onClick={() => setPath(r)}
              className="pill bg-surface-3 text-content-dim hover:text-content shrink-0 max-w-[140px] truncate"
              title={r}
            >
              {r.split("/").pop() || r}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 rounded-md bg-surface px-2 py-1 shrink-0">
          <Icon name="search" size={12} className="text-content-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("workspace.filter")}
            className="w-20 bg-transparent text-[12px] text-content placeholder:text-content-faint outline-none"
          />
        </div>
      </div>

      {/* Folder list */}
      <div className="max-h-56 overflow-y-auto p-1">
        {path !== "/" && (
          <button
            onClick={() => go("/" + segments.slice(0, -1).join("/"))}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-content-faint hover:bg-surface-3 transition"
          >
            <Icon name="arrow-up" size={14} /> ..
          </button>
        )}
        {loading && <p className="px-2 py-3 text-xs text-content-faint">{t("common.loading")}</p>}
        {error && (
          <p className="px-2 py-3 text-xs text-danger flex items-center gap-1.5">
            <Icon name="x" size={13} /> {error}
          </p>
        )}
        {!loading && !error && dirs.length === 0 && (
          <p className="px-2 py-3 text-xs text-content-faint">{query ? t("workspace.noSubfoldersMatch") : t("workspace.noSubfolders")}</p>
        )}
        {!error &&
          dirs.map((e) => (
            <div
              key={e.path}
              onClick={() => setPath(e.path)}
              onDoubleClick={() => pick(e.path)}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer hover:bg-surface-3 transition"
            >
              <Icon name="folder" size={15} className="text-warning/80" />
              <span className="truncate text-content/85">{e.name}</span>
              <button
                onClick={(ev) => {
                  ev.stopPropagation();
                  pick(e.path);
                }}
                className="ml-auto pill bg-accent-soft text-accent opacity-0 group-hover:opacity-100 transition"
              >
                {t("workspace.use")}
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}
