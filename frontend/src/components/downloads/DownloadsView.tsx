import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { compareVersions, detectPlatform, getDownloads, type AppAsset, type AppRelease } from "../../api/downloads";
import { formatBytes } from "../attachments/fileMeta";
import { absTime, relTime } from "../admin/format";
import Icon from "../ui/Icon";
import UpdateCard, { ProgressBar, progressLine, useUpdateState } from "./UpdateCard";
import { isAndroidApp, useAndroidDownload, useBrowserDownload, type Progress } from "../../lib/downloadProgress";
import { tr, useT, type MsgKey } from "../../i18n";

const PLATFORMS: readonly { id: "windows" | "macos" | "linux" | "android"; name: string; sub: MsgKey }[] = [
  { id: "windows", name: "Windows", sub: "downloads.subWindows" },
  { id: "macos", name: "macOS", sub: "downloads.subMacos" },
  { id: "linux", name: "Linux", sub: "downloads.subLinux" },
  { id: "android", name: "Android", sub: "downloads.subAndroid" },
];

/** Install hints. Builds since 0.3 are `my-mate-geny-*` ("My Mate Geny.app");
 * a release still carrying the old `hr-harnessor-*` files gets the old names. */
const notes = (legacy: boolean): Record<string, string[]> => {
  const file = legacy ? "hr-harnessor" : "my-mate-geny";
  const app = legacy ? "hr-harnessor" : "My Mate Geny";
  return {
  windows: [tr("downloads.noteWin1"), tr("downloads.noteWin2")],
  macos: [
    tr("downloads.noteMac1", { app }),
    tr("downloads.noteMac2", { cmd: `xattr -dr com.apple.quarantine "/Applications/${app}.app"` }),
  ],
  linux: [
    tr("downloads.noteLinux1", { cmd: `chmod +x ${file}-*.AppImage` }),
    tr("downloads.noteLinux2", { cmd: `sudo apt install ./${file}-*.deb` }),
  ],
  android: [tr("downloads.noteAndroid1"), tr("downloads.noteAndroid2")],
  };
};

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div className="w-32 h-32 rounded-lg bg-white p-1.5 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function AssetButton({ a, primary, onPick }: { a: AppAsset; primary?: boolean; onPick?: (a: AppAsset, e: React.MouseEvent) => void }) {
  return (
    <a
      href={a.url}
      onClick={onPick ? (e) => onPick(a, e) : undefined}
      data-testid={`asset-${a.platform}-${a.kind}`}
      className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 transition ${
        primary
          ? "border-transparent text-white shadow-glow"
          : "border-border bg-surface-2/60 text-content hover:border-border-strong hover:bg-surface-3"
      }`}
      style={primary ? { background: "linear-gradient(135deg,#6e8bff,#5b7cff)" } : undefined}
    >
      <Icon name="download" size={16} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{a.label}</span>
        {/* the size stays visible when a narrow screen truncates the file name */}
        <span className={`flex gap-1 text-[11px] ${primary ? "text-white/75" : "text-content-faint"}`}>
          <span className="truncate">{a.name}</span>
          <span className="shrink-0">· {formatBytes(a.size)}</span>
        </span>
      </span>
    </a>
  );
}

/** a download in progress on this page (browser: fetched as a stream; Android app: the system's DownloadManager) */
function DownloadProgress({
  name,
  p,
  onCancel,
  onInstall,
  onClose,
  href,
}: {
  name: string;
  p: Progress;
  onCancel: () => void;
  onInstall?: () => void;
  onClose: () => void;
  href?: string;
}) {
  const t = useT();
  const pct = p.total ? Math.round((p.transferred / p.total) * 100) : 0;
  return (
    <div className="mt-4 rounded-xl border border-border bg-surface-2/70 px-4 py-3 text-[13px] animate-fade-in" data-testid="download-progress" data-status={p.status}>
      <div className="flex items-center gap-2">
        <Icon
          name={p.status === "done" ? "check" : p.status === "error" ? "warning" : "download"}
          size={14}
          className={p.status === "done" ? "text-success" : p.status === "error" ? "text-danger" : "text-accent"}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-content">
          {p.status === "done" ? (onInstall ? t("downloads.readyToInstall") : t("downloads.saved")) : p.status === "error" ? t("downloads.failed") : p.status === "cancelled" ? t("downloads.cancelledShort") : t("downloads.downloading")}{" "}
          <span className="font-normal text-content-faint">{name}</span>
        </span>
        {p.status === "downloading" && (
          <span className="font-mono text-[12px] text-accent" data-testid="download-percent">
            {p.total ? `${pct}%` : ""}
          </span>
        )}
        {p.status === "downloading" ? (
          <button className="btn-ghost !px-2.5 !py-1 text-[12px]" onClick={onCancel} data-testid="download-cancel">
            {t("common.cancel")}
          </button>
        ) : p.status === "done" && onInstall ? (
          <button className="btn-primary !py-1.5" onClick={onInstall} data-testid="download-install">
            {t("downloads.install")}
          </button>
        ) : (
          <button className="rounded-md p-1 text-content-faint hover:bg-surface-3 hover:text-content" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      {p.status === "downloading" && (
        <>
          <div className="mt-2.5">
            <ProgressBar percent={pct} indeterminate={!p.total} />
          </div>
          <div className="mt-1.5 text-[11.5px] text-content-faint">{progressLine(p.transferred, p.total, p.bytesPerSecond, p.eta) || t("downloads.starting")}</div>
        </>
      )}
      {p.status === "error" && (
        <p className="mt-1.5 text-[12px] text-danger">
          {p.error}
          {href && (
            <>
              {" "}
              <a className="underline" href={href}>
                {t("downloads.tryDirect")}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

export default function DownloadsView() {
  const t = useT();
  const [rel, setRel] = useState<AppRelease | null>(null);
  const [error, setError] = useState("");
  const platform = detectPlatform();
  const native = window.hrhNative;
  const upd = useUpdateState(); // the desktop app's own updater (desktop/src/updater.js)
  const browserDl = useBrowserDownload();
  const androidDl = useAndroidDownload();
  const androidApp = isAndroidApp();
  const [picked, setPicked] = useState<AppAsset | null>(null);
  // a browser downloads with progress on the page; the Android app hands the APK to the system with progress here and
  // opens the installer; the desktop app's own platform is updated by the card above (other files: the plain link)
  const onPick = (a: AppAsset, e: React.MouseEvent) => {
    if (androidApp && a.platform === "android") {
      e.preventDefault();
      setPicked(a);
      void androidDl.start(a.url, a.name).then((ok) => {
        if (!ok) window.location.href = a.url; // an older app: its download listener takes the plain link
      });
    } else if (!native) {
      e.preventDefault();
      setPicked(a);
      void browserDl.start(a.url, a.name, a.size);
    }
  };

  const load = (refresh = false) =>
    getDownloads(refresh)
      .then((r) => {
        setRel(r);
        setError("");
      })
      .catch((e) => setError(String(e.message || e)));

  useEffect(() => {
    load();
  }, []);

  const assets = rel?.assets || [];
  const forPlatform = (p: string) => assets.filter((a) => a.platform === p);
  const mine = forPlatform(platform === "ios" ? "" : platform);
  const primary = platform === "macos" ? mine.find((a) => a.arch === "arm64") || mine[0] : mine[0];
  const outdated = native && rel?.version && compareVersions(rel.version, native.version) > 0;
  const pageUrl = `${window.location.origin}/?view=downloads`;
  const legacy = assets.some((a) => a.name.startsWith("hr-harnessor")) && !assets.some((a) => a.name.startsWith("my-mate-geny"));
  const NOTES = notes(legacy);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-5 sm:py-8">
        <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-accent/15 via-surface to-cyan/10 p-5 sm:p-7">
          <div className="flex items-start gap-4">
            <img src="/icon-192.png" alt="" className="h-14 w-14 shrink-0 rounded-2xl shadow-glow" />
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold tracking-tight">{t("downloads.title")}</h1>
              <p className="mt-1 text-sm text-content-dim">
                {t("downloads.intro")}
              </p>
            </div>
          </div>

          {upd && <UpdateCard s={upd} />}
          {native && !upd && (
            <div className={`mt-4 flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[13px] ${outdated ? "bg-warning/12 text-warning" : "bg-success/10 text-success"}`}>
              <Icon name={outdated ? "warning" : "check"} size={14} />
              {outdated
                ? t("downloads.newerAvailable", { latest: rel?.version, current: native.version })
                : rel?.version
                  ? t("downloads.usingAppLatest", { version: native.version })
                  : t("downloads.usingApp", { version: native.version })}
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            {rel === null && !error && <Icon name="spinner" size={18} spin className="text-content-faint" />}
            {primary && (
              <div className="w-full sm:w-auto sm:min-w-[320px]">
                <AssetButton a={primary} primary onPick={onPick} />
              </div>
            )}
            {platform === "macos" &&
              mine
                .filter((a) => a !== primary)
                .map((a) => (
                  <div key={a.id} className="w-full sm:w-auto sm:min-w-[260px]">
                    <AssetButton a={a} onPick={onPick} />
                  </div>
                ))}
            {platform === "ios" && (
              <p className="text-[13px] text-content-dim">
                {t("downloads.iosHint")}
              </p>
            )}
          </div>

          {androidDl.active || (androidApp && androidDl.progress.status !== "idle") ? (
            <DownloadProgress
              name={picked?.name || t("downloads.theAndroidApp")}
              p={androidDl.progress}
              onCancel={() => void androidDl.cancel()}
              onInstall={() => void androidDl.install()}
              onClose={androidDl.reset}
            />
          ) : (
            browserDl.progress.status !== "idle" && (
              <DownloadProgress name={browserDl.name} p={browserDl.progress} onCancel={browserDl.cancel} onClose={browserDl.reset} href={picked?.url} />
            )
          )}
          {rel?.available && (
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-content-faint">
              <span>
                {t.rich("downloads.releaseVersion", { version: <b className="font-mono text-content-dim">{rel.version}</b> })}
              </span>
              {rel.commit && (
                <span title={rel.commit_message || ""}>
                  {t.rich("downloads.builtFrom", { commit: <span className="font-mono text-content-dim">{rel.commit.slice(0, 7)}</span> })}
                  {rel.commit_message ? ` · ${rel.commit_message.split("\n")[0].slice(0, 80)}` : ""}
                </span>
              )}
              {rel.built_at && <span title={absTime(rel.built_at)}>{relTime(rel.built_at)}</span>}
              <button onClick={() => load(true)} className="inline-flex items-center gap-1 hover:text-content-dim">
                <Icon name="refresh" size={11} /> {t("downloads.checkNow")}
              </button>
            </div>
          )}
          {rel && !rel.available && (
            <p className="mt-3 text-[13px] text-content-dim">
              {rel.reason === "no_release"
                ? t("downloads.noRelease")
                : rel.reason === "not_configured"
                  ? t("downloads.notConfigured")
                  : t("downloads.unavailable", { reason: rel.reason })}
            </p>
          )}
          {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PLATFORMS.map((p) => {
            const list = forPlatform(p.id);
            const isMine = p.id === platform;
            return (
              <section key={p.id} className={`card min-w-0 p-4 ${isMine ? "ring-1 ring-accent/40" : ""}`}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="flex items-center gap-2 text-[15px] font-semibold">
                      {p.name}
                      {isMine && <span className="pill bg-accent-soft text-accent">{t("downloads.thisDevice")}</span>}
                    </h2>
                    <p className="text-[12px] text-content-faint">{t(p.sub)}</p>
                  </div>
                  {p.id === "android" && list.length > 0 && platform !== "android" && <Qr text={pageUrl} />}
                </div>
                <div className="mt-3 space-y-2">
                  {list.length ? (
                    list.map((a) => <AssetButton key={a.id} a={a} onPick={onPick} />)
                  ) : (
                    <p className="text-[12px] text-content-faint">{rel?.available ? t("downloads.noBuild") : "—"}</p>
                  )}
                </div>
                <ul className="mt-3 space-y-1.5 border-t border-border/60 pt-3 text-[12px] leading-relaxed text-content-dim">
                  {NOTES[p.id].map((n) => (
                    <li key={n} className="flex gap-2">
                      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-content-faint" />
                      <span className="break-words">{n}</span>
                    </li>
                  ))}
                </ul>
                {p.id === "android" && list.length > 0 && platform !== "android" && (
                  <p className="mt-2 text-[11px] text-content-faint">{t("downloads.scanHint")}</p>
                )}
              </section>
            );
          })}
        </div>

        {rel?.notes && (
          <section className="card mt-3 p-4">
            <h2 className="mb-2 text-[14px] font-semibold">{t("downloads.whatsNew")}</h2>
            <pre className="whitespace-pre-wrap break-words font-sans text-[12.5px] leading-relaxed text-content-dim">{rel.notes}</pre>
          </section>
        )}
      </div>
    </div>
  );
}
