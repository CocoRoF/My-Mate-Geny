import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { fsBytes, fsRawUrl, fsStat, fsText, type FsStat, type FsText } from "../../api/fs";
import {
  baseName,
  dirName,
  extOf,
  formatBytes,
  formatTime,
  hasSourceToggle,
  kindForFile,
  langForFile,
  LEGACY_OFFICE,
  parseCsv,
  sniffDelimiter,
  TEXT_KINDS,
  type ViewerKind,
} from "../../lib/fileView";
import { displayPath } from "../../lib/paths";
import { explorerRoots, revealInExplorer, useWorkbench, type FileTab } from "../../stores/workbenchStore";
import type { Session } from "../../types";
import Icon, { type IconName } from "../ui/Icon";
import Markdown from "../ui/Markdown";
import CodeView from "./CodeView";
import DataTable from "./DataTable";
import { fileIcon } from "./fileIcon";
import { tr, useT } from "../../i18n";

// The heavy format libraries load only when a file of that kind is opened.
const SheetView = lazy(() => import("./SheetView"));
const DocxView = lazy(() => import("./DocxView"));
const PptxView = lazy(() => import("./PptxView"));
const PdfView = lazy(() => import("./PdfView"));
const NotebookView = lazy(() => import("./NotebookView"));

const BYTE_KINDS = new Set<ViewerKind>(["sheet", "docx", "pptx", "pdf"]);
const SIZE_GATE = 30 * 1024 * 1024; // bigger documents load on request
const TEXT_MORE = 16 * 1024 * 1024;

function Btn({ icon, label, onClick, active, href, download }: {
  icon: IconName; label: string; onClick?: () => void; active?: boolean; href?: string; download?: boolean;
}) {
  const cls = `inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] transition ${
    active ? "bg-surface-3 text-content" : "text-content-faint hover:bg-surface-2 hover:text-content"
  }`;
  return href ? (
    <a href={href} download={download ? "" : undefined} className={cls} title={label}>
      <Icon name={icon} size={13} />
    </a>
  ) : (
    <button onClick={onClick} className={cls} title={label}>
      <Icon name={icon} size={13} />
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center p-6 text-center">{children}</div>;
}

/** A file tab's body: toolbar + the viewer for its kind. */
export default function FileViewer({ session, tab }: { session: Session; tab: FileTab }) {
  const t = useT();
  const conn = session.connection_id;
  const name = baseName(tab.path);
  const ext = extOf(name);
  const kind0 = kindForFile(name);
  const epoch = useWorkbench((s) => s.epoch);
  const pinned = useWorkbench((s) => s.pinnedRoots[session.id]);
  const notify = useWorkbench((s) => s.notify);
  const roots = useMemo(() => explorerRoots(session, pinned), [session, pinned]);

  const [source, setSource] = useState(false);
  const [wrap, setWrap] = useState(kind0 === "markdown" || ext === "txt" || ext === "log");
  const [forceText, setForceText] = useState(false);
  const [allowLarge, setAllowLarge] = useState(false);
  const [textLimit, setTextLimit] = useState<number | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const [stat, setStat] = useState<FsStat | null>(null);
  const [text, setText] = useState<FsText | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const svgSource = ext === "svg" && source;
  const needText = forceText || svgSource || TEXT_KINDS.has(kind0);
  const needBytes = !forceText && BYTE_KINDS.has(kind0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    (async () => {
      const st = await fsStat(tab.path, conn);
      if (!alive) return;
      setStat(st);
      if (st.is_dir) throw new Error(tr("files.isFolder"));
      if (needText) {
        const txt = await fsText(tab.path, conn, textLimit);
        if (alive) setText(txt);
      }
      if (needBytes && (st.size <= SIZE_GATE || allowLarge)) {
        const b = await fsBytes(tab.path, conn);
        if (alive) setBytes(b);
      }
    })()
      .catch((e) => alive && setError(String(e?.message || e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [tab.path, conn, reload, needText, needBytes, allowLarge, textLimit]);

  // After a turn ends, reload if the agent changed this file.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    fsStat(tab.path, conn)
      .then((st) => {
        if (!stat || st.mtime !== stat.mtime || st.size !== stat.size) setReload((r) => r + 1);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  // Unknown extension that reads as text → code; a "text" file full of NULs → binary.
  let kind: ViewerKind = kind0;
  if (forceText) kind = "code";
  else if (kind0 === "binary" && text && !text.binary) kind = "code";
  else if (TEXT_KINDS.has(kind0) && text?.binary) kind = "binary";

  const toggle = hasSourceToggle(name) && kind !== "binary";
  const showsCode = kind === "code" || (toggle && source);
  const content = text?.content ?? "";
  const baseDir = dirName(tab.path);

  const csvRows = useMemo(
    () => (kind === "csv" && !source && text ? parseCsv(content, sniffDelimiter(name, content)) : null),
    [kind, source, text, content, name],
  );

  const copy = (value: string, done: string) => navigator.clipboard?.writeText(value).then(() => notify(done));

  const rel = displayPath(tab.path, roots);
  const segs = rel.split("/");
  const { icon, tone } = fileIcon(name);
  const meta = [
    stat ? formatBytes(stat.size) : "",
    text && text.encoding !== "utf-8" && !text.binary ? text.encoding : "",
    stat?.mtime ? t("files.modified", { time: formatTime(stat.mtime) }) : "",
  ].filter(Boolean);

  let body: React.ReactNode;
  if (error) {
    body = (
      <Centered>
        <div>
          <Icon name="alert-circle" size={28} className="mx-auto mb-2 text-danger" />
          <p className="text-sm text-content">{error}</p>
          <p className="mt-1 break-all font-mono text-[11px] text-content-faint">{tab.path}</p>
          <button onClick={() => setReload((r) => r + 1)} className="btn-soft mt-3 py-1 px-2.5 text-[12px]">
            <Icon name="refresh" size={12} /> {t("common.retry")}
          </button>
        </div>
      </Centered>
    );
  } else if (loading && !text && !bytes && kind !== "image" && kind !== "audio" && kind !== "video") {
    body = (
      <Centered>
        <Icon name="spinner" size={20} spin className="text-content-faint" />
      </Centered>
    );
  } else if (kind === "binary") {
    const legacy = LEGACY_OFFICE.has(ext);
    body = (
      <Centered>
        <div className="max-w-sm">
          <Icon name={icon} size={36} className={`mx-auto mb-3 ${tone}`} />
          <p className="text-sm font-medium text-content">{name}</p>
          <p className="mt-1 text-[12px] text-content-faint">
            {[stat && formatBytes(stat.size), stat?.mime].filter(Boolean).join(" · ")}
          </p>
          <p className="mt-3 text-[12.5px] text-content-dim">
            {legacy
              ? t("files.legacyFormat", { ext, target: ext === "doc" ? ".docx" : ext === "ppt" ? ".pptx" : t("files.aModernFormat") })
              : t("files.noPreview")}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <a href={fsRawUrl(tab.path, conn, true)} download className="btn-primary py-1.5 px-3 text-[12.5px]">
              <Icon name="download" size={13} /> {t("common.download")}
            </a>
            {!legacy && (
              <button onClick={() => setForceText(true)} className="btn-soft py-1.5 px-3 text-[12.5px]">
                {t("files.openAsText")}
              </button>
            )}
          </div>
        </div>
      </Centered>
    );
  } else if (showsCode || svgSource) {
    body = (
      <div className="h-full overflow-auto bg-bg">
        <CodeView
          code={content}
          lang={forceText ? "plaintext" : langForFile(name)}
          wrap={wrap}
          line={tab.line}
          endLine={tab.endLine}
          nonce={tab.nonce}
        />
      </div>
    );
  } else if (kind === "markdown") {
    body = (
      <div className="h-full overflow-auto">
        <article className="mx-auto max-w-[52rem] px-5 py-6 sm:px-8">
          <Markdown baseDir={baseDir} doc>
            {content}
          </Markdown>
        </article>
      </div>
    );
  } else if (kind === "csv" && csvRows) {
    body = csvRows.length ? (
      <DataTable rows={csvRows} header wrap={wrap} />
    ) : (
      <Centered>
        <p className="text-sm text-content-faint">{t("files.emptyFile")}</p>
      </Centered>
    );
  } else if (kind === "html") {
    // No allow-scripts / allow-same-origin: markup and CSS only.
    body = <iframe sandbox="" srcDoc={content} title={name} className="h-full w-full bg-white" />;
  } else if (kind === "notebook") {
    body = <NotebookView text={content} baseDir={baseDir} />;
  } else if (kind === "image") {
    body = <ImageView url={`${fsRawUrl(tab.path, conn)}&v=${stat?.mtime ?? reload}`} name={name} />;
  } else if (kind === "audio" || kind === "video") {
    const url = `${fsRawUrl(tab.path, conn)}&v=${stat?.mtime ?? reload}`;
    body = (
      <Centered>
        {kind === "audio" ? (
          <audio src={url} controls className="w-full max-w-lg" />
        ) : (
          <video src={url} controls className="max-h-full max-w-full rounded-lg bg-black" />
        )}
      </Centered>
    );
  } else if (BYTE_KINDS.has(kind)) {
    if (!bytes && stat && stat.size > SIZE_GATE && !allowLarge) {
      body = (
        <Centered>
          <div>
            <p className="text-sm text-content">{t("files.largeFile", { size: formatBytes(stat.size) })}</p>
            <p className="mt-1 text-[12px] text-content-faint">{t("files.largeFileHint")}</p>
            <div className="mt-3 flex justify-center gap-2">
              <button onClick={() => setAllowLarge(true)} className="btn-soft py-1.5 px-3 text-[12.5px]">
                {t("files.loadPreview")}
              </button>
              <a href={fsRawUrl(tab.path, conn, true)} download className="btn-ghost py-1.5 px-3 text-[12.5px]">
                <Icon name="download" size={13} /> {t("common.download")}
              </a>
            </div>
          </div>
        </Centered>
      );
    } else if (bytes) {
      body =
        kind === "sheet" ? <SheetView data={bytes} wrap={wrap} /> :
        kind === "docx" ? <DocxView data={bytes} /> :
        kind === "pptx" ? <PptxView data={bytes} /> :
        <PdfView data={bytes} />;
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {/* toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 bg-surface/40 px-3">
        <Icon name={icon} size={14} className={`shrink-0 ${tone}`} />
        <div className="flex min-w-0 items-center overflow-hidden text-[12px]" title={[tab.path, meta.join(" · ")].filter(Boolean).join("\n")}>
          {segs.map((s, i) => {
            const last = i === segs.length - 1;
            return (
              <span key={i} className={`flex items-center ${last ? "min-w-[4rem] shrink-0 max-w-full" : "min-w-0 shrink"}`}>
                {i > 0 && <Icon name="chevron" size={10} className="mx-0.5 shrink-0 text-content-faint" />}
                <span className={`truncate ${last ? "font-medium text-content" : "text-content-faint"}`}>{s}</span>
              </span>
            );
          })}
        </div>
        {meta.length > 0 && <span className="hidden shrink-0 text-[11px] text-content-faint 2xl:inline">{meta.join(" · ")}</span>}
        {loading && (text || bytes) && <Icon name="spinner" size={12} spin className="shrink-0 text-content-faint" />}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {toggle && (
            <div className="mr-1 flex rounded-md bg-surface-2 p-0.5 text-[11.5px]">
              {[false, true].map((src) => (
                <button
                  key={String(src)}
                  onClick={() => setSource(src)}
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 transition ${
                    source === src ? "bg-surface-3 text-content shadow-card" : "text-content-faint hover:text-content"
                  }`}
                >
                  <Icon name={src ? "code" : "eye"} size={12} />
                  <span className="hidden sm:inline">{src ? t("files.source") : kind === "csv" ? t("files.table") : t("files.rendered")}</span>
                </button>
              ))}
            </div>
          )}
          {(showsCode || svgSource || kind === "csv" || kind === "sheet") && (
            <Btn icon="wrap" label={wrap ? t("files.noWrap") : t("files.wrapLines")} active={wrap} onClick={() => setWrap(!wrap)} />
          )}
          {text && !text.binary && <Btn icon="copy" label={t("files.copyContents")} onClick={() => copy(content, t("files.copiedContents"))} />}
          <Btn icon="at" label={t("files.copyPath")} onClick={() => copy(tab.path, t("files.copiedPath"))} />
          <Btn
            icon="crosshair"
            label={t("files.revealInExplorer")}
            onClick={() => {
              useWorkbench.getState().setExplorer(true);
              revealInExplorer(session, tab.path).catch(() => {});
            }}
          />
          <Btn icon="download" label={t("common.download")} href={fsRawUrl(tab.path, conn, true)} download />
          <Btn icon="refresh" label={t("common.reload")} onClick={() => setReload((r) => r + 1)} />
        </div>
      </div>
      {text?.truncated && !error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/20 bg-warning/10 px-3 py-1 text-[11.5px] text-warning">
          {t("files.showingFirst", { shown: formatBytes(content.length), total: formatBytes(text.size) })}
          {(textLimit ?? 0) < TEXT_MORE && text.size > (textLimit ?? 0) && (
            <button onClick={() => setTextLimit(TEXT_MORE)} className="underline underline-offset-2 hover:text-content">
              {t("files.loadUpTo", { size: formatBytes(TEXT_MORE) })}
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <Centered>
              <Icon name="spinner" size={20} spin className="text-content-faint" />
            </Centered>
          }
        >
          {body}
        </Suspense>
      </div>
    </div>
  );
}

function ImageView({ url, name }: { url: string; name: string }) {
  const t = useT();
  const [fit, setFit] = useState(true);
  const [dims, setDims] = useState("");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={`min-h-0 flex-1 overflow-auto ${fit ? "grid place-items-center" : ""} p-4`}
        style={{
          backgroundImage:
            "linear-gradient(45deg,#161a22 25%,transparent 25%),linear-gradient(-45deg,#161a22 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#161a22 75%),linear-gradient(-45deg,transparent 75%,#161a22 75%)",
          backgroundSize: "20px 20px",
          backgroundPosition: "0 0,0 10px,10px -10px,-10px 0",
        }}
      >
        <img
          src={url}
          alt={name}
          onClick={() => setFit(!fit)}
          onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
          className={`${fit ? "max-h-full max-w-full object-contain cursor-zoom-in" : "max-w-none cursor-zoom-out"}`}
        />
      </div>
      <div className="shrink-0 border-t border-border/60 px-3 py-1 text-[11px] text-content-faint">
        {dims} · {fit ? t("files.fitToWindow") : t("files.actualSize")}
      </div>
    </div>
  );
}
