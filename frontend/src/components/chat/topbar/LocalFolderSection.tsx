import { useEffect, useRef, useState } from "react";
import { folderUploadLimits, probeSameHost, type FolderUploadLimits } from "../../../api/folderUploads";
import { canPickDirInBrowser, COPY_DIR, fmtBytes, folderBridge, fromDesktop, fromFileList } from "../../../lib/localFolder";
import { useLocalFolders } from "../../../stores/localFolderStore";
import { useSessionStore } from "../../../stores/sessionStore";
import type { Session } from "../../../types";
import Icon from "../../ui/Icon";
import { useT } from "../../../i18n";

let cachedLimits: FolderUploadLimits | null = null;

/** "This computer": link (desktop app on the server's machine) or upload a copy of a folder from the user's computer. */
export default function LocalFolderSection({ session, onLinked }: { session: Session; onLinked: (path: string) => void }) {
  const t = useT();
  const bridge = folderBridge();
  const browser = !bridge && canPickDirInBrowser();
  const update = useSessionStore((s) => s.update);
  const job = useLocalFolders((s) => s.jobs[session.id]);
  const setJob = useLocalFolders((s) => s.set);
  const startUpload = useLocalFolders((s) => s.upload);
  const cancel = useLocalFolders((s) => s.cancel);
  const [limits, setLimits] = useState<FolderUploadLimits | null>(cachedLimits);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const remote = !!session.connection_id;
  const sid = session.id;

  useEffect(() => {
    if (!cachedLimits)
      folderUploadLimits()
        .then((l) => setLimits((cachedLimits = l)))
        .catch(() => {});
  }, []);

  const pickDesktop = async () => {
    if (!bridge) return;
    setError("");
    try {
      const picked = await bridge.pick();
      if (!picked) return;
      setJob(sid, { phase: "reading", sent: 0, files: 0 });
      // Same machine (the server reads the app's probe file) → link the folder itself, no copy.
      if (!remote) {
        const same = await probeSameHost(picked.probe.path, picked.probe.nonce, picked.path).catch(() => null);
        if (same?.same_host && same.is_dir) {
          bridge.release(picked.path).catch(() => {});
          setJob(sid, undefined);
          const dirs = session.extra_dirs || [];
          if (same.path === session.workspace_path || dirs.includes(same.path)) return setError(t("topbar.folderAlreadyConnected"));
          await update(sid, { extra_dirs: [...dirs, same.path] });
          onLinked(same.path);
          return;
        }
      }
      setJob(sid, { phase: "ready", folder: await fromDesktop(bridge, picked, limits), sent: 0, files: 0 });
    } catch (e: any) {
      setJob(sid, undefined);
      setError(String(e.message || e));
    }
  };

  const pickedInBrowser = (list: FileList | null) => {
    setError("");
    const f = list && fromFileList(list, limits);
    if (input.current) input.current.value = "";
    if (f) setJob(sid, { phase: "ready", folder: f, sent: 0, files: 0 });
  };

  if (!bridge && !browser)
    return (
      <p className="text-[12px] text-content-faint" data-testid="local-folder-unavailable">
        {t("topbar.cantPick")}
      </p>
    );

  const f = job?.folder;
  const tooBig = !!f?.truncated;
  const pct = f ? Math.min(100, ((job?.sent || 0) / Math.max(1, f.bytes)) * 100) : 0;

  return (
    <div className="space-y-2" data-testid="local-folder">
      <p className="text-[11.5px] leading-snug text-content-dim">
        {bridge && !remote ? t("topbar.linkOrCopy") : remote ? t("topbar.copyOnlyRemote") : t("topbar.copyOnly")}
      </p>

      {!job && (
        <>
          <button
            onClick={() => (bridge ? pickDesktop() : input.current?.click())}
            className="btn-soft w-full justify-center py-1.5 text-[12.5px]"
            data-testid="local-folder-pick"
          >
            <Icon name="monitor" size={14} /> {t("topbar.chooseFolder")}
          </button>
          {browser && (
            <input
              ref={input}
              type="file"
              className="hidden"
              multiple
              data-testid="local-folder-input"
              onChange={(e) => pickedInBrowser(e.target.files)}
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            />
          )}
        </>
      )}

      {job?.phase === "reading" && (
        <p className="flex items-center gap-1.5 text-[12px] text-content-faint">
          <Icon name="spinner" size={13} spin /> {t("topbar.readingFolder")}
        </p>
      )}

      {f && job && (
        <div className="rounded-lg border border-border bg-surface/60 p-2.5" data-testid="local-folder-summary">
          <div className="flex items-center gap-2">
            <Icon name="folder" size={14} className="shrink-0 text-warning/80" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-content">{f.name}</span>
            <span className="pill shrink-0 bg-warning/15 text-warning" title={t("topbar.copyEditsTitle")}>
              {t("topbar.copy")}
            </span>
          </div>
          <div className="mt-1 truncate text-[11.5px] text-content-dim">
            {t("topbar.fileCount", { count: f.files.length })} · {fmtBytes(f.bytes)}
            <span className="text-content-faint">
              {" "}
              → {COPY_DIR}/{f.name}
            </span>
          </div>
          {f.skipped > 0 && (
            <div className="mt-0.5 truncate text-[11px] text-content-faint" title={f.skippedNames.join(", ")}>
              {t("topbar.skipped", { names: f.skippedNames.join(", "), count: f.skipped })}
            </div>
          )}
          {tooBig && (
            <div className="mt-1 text-[11.5px] text-danger">
              {limits ? t("topbar.tooLargeLimits", { files: limits.max_files, bytes: fmtBytes(limits.max_bytes) }) : t("topbar.tooLarge")}
            </div>
          )}
          {f.files.length === 0 && !tooBig && <div className="mt-1 text-[11.5px] text-danger">{t("topbar.nothingToCopy")}</div>}

          {job.phase === "uploading" ? (
            <div className="mt-2">
              <div
                className="h-1.5 overflow-hidden rounded-full bg-accent/15"
                role="progressbar"
                aria-label={t("topbar.uploadProgress")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
              >
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-content-faint">
                <span className="tabular-nums" data-testid="local-folder-progress">
                  {t("topbar.progress", { done: job.files, total: f.files.length, sent: fmtBytes(job.sent), bytes: fmtBytes(f.bytes) })}
                </span>
                <button onClick={() => cancel(sid)} className="ml-auto text-content-dim hover:text-danger">
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button onClick={() => cancel(sid)} className="btn-ghost py-1 px-2 text-[12px]">
                {t("common.cancel")}
              </button>
              <button
                onClick={() => startUpload(session)}
                disabled={tooBig || f.files.length === 0}
                className="btn-primary py-1 px-2.5 text-[12px]"
                data-testid="local-folder-upload"
              >
                <Icon name="upload" size={13} /> {t("topbar.uploadCopy")}
              </button>
            </div>
          )}
          {job.error && <p className="mt-1.5 text-[11.5px] text-danger">{job.error}</p>}
        </div>
      )}
      {error && <p className="text-[11.5px] text-danger">{error}</p>}
    </div>
  );
}
