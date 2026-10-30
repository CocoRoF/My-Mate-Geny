import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { compareVersions, detectPlatform, getDownloads, type AppAsset, type AppRelease } from "../../api/downloads";
import { formatBytes } from "../attachments/fileMeta";
import { absTime, relTime } from "../admin/format";
import Icon from "../ui/Icon";

const PLATFORMS = [
  { id: "windows", name: "Windows", sub: "Windows 10 / 11 · x64" },
  { id: "macos", name: "macOS", sub: "Apple Silicon & Intel" },
  { id: "linux", name: "Linux", sub: "AppImage · Debian/Ubuntu" },
  { id: "android", name: "Android", sub: "Android 7.0+ · phone & tablet" },
] as const;

const NOTES: Record<string, string[]> = {
  windows: [
    "Run the installer. Windows SmartScreen may warn about an unrecognised app (the build isn't code-signed): choose “More info” → “Run anyway”.",
    "Updates: download and run the newer installer — settings and login are kept.",
  ],
  macos: [
    "Open the .dmg and drag hr-harnessor into Applications.",
    "First launch: the app isn't notarised by Apple, so right-click it → Open → Open. If macOS says it's “damaged”, run: xattr -dr com.apple.quarantine /Applications/hr-harnessor.app",
  ],
  linux: [
    "AppImage: chmod +x hr-harnessor-*.AppImage and run it (works on any distro).",
    "Debian/Ubuntu: sudo apt install ./hr-harnessor-*.deb — adds it to your app menu.",
  ],
  android: [
    "Open the APK on the phone. Android asks to allow installs from your browser/files app once — allow it, then install.",
    "Updates install over the previous version (same signing key), keeping your login.",
  ],
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

function AssetButton({ a, primary }: { a: AppAsset; primary?: boolean }) {
  return (
    <a
      href={a.url}
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

export default function DownloadsView() {
  const [rel, setRel] = useState<AppRelease | null>(null);
  const [error, setError] = useState("");
  const platform = detectPlatform();
  const native = window.hrhNative;

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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-5 sm:py-8">
        <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-accent/15 via-surface to-cyan/10 p-5 sm:p-7">
          <div className="flex items-start gap-4">
            <img src="/icon-192.png" alt="" className="h-14 w-14 shrink-0 rounded-2xl shadow-glow" />
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold tracking-tight">Get hr·harnessor</h1>
              <p className="mt-1 text-sm text-content-dim">
                The same console as a native app for desktop and Android — notifications, its own window, and your login kept.
                The apps load this console live, so UI updates reach them instantly; new app builds are published here
                automatically from every push.
              </p>
            </div>
          </div>

          {native && (
            <div className={`mt-4 flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[13px] ${outdated ? "bg-warning/12 text-warning" : "bg-success/10 text-success"}`}>
              <Icon name={outdated ? "warning" : "check"} size={14} />
              {outdated
                ? `A newer app version is available: ${rel?.version} (you have ${native.version}).`
                : `You're using the app, version ${native.version}${rel?.version ? " — up to date" : ""}.`}
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            {rel === null && !error && <Icon name="spinner" size={18} spin className="text-content-faint" />}
            {primary && (
              <div className="w-full sm:w-auto sm:min-w-[320px]">
                <AssetButton a={primary} primary />
              </div>
            )}
            {platform === "macos" &&
              mine
                .filter((a) => a !== primary)
                .map((a) => (
                  <div key={a.id} className="w-full sm:w-auto sm:min-w-[260px]">
                    <AssetButton a={a} />
                  </div>
                ))}
            {platform === "ios" && (
              <p className="text-[13px] text-content-dim">
                iPhone/iPad: open this site in Safari → Share → “Add to Home Screen” for an app-like console.
              </p>
            )}
          </div>

          {rel?.available && (
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-content-faint">
              <span>
                Version <b className="font-mono text-content-dim">{rel.version}</b>
              </span>
              {rel.commit && (
                <span title={rel.commit_message || ""}>
                  built from <span className="font-mono text-content-dim">{rel.commit.slice(0, 7)}</span>
                  {rel.commit_message ? ` · ${rel.commit_message.split("\n")[0].slice(0, 80)}` : ""}
                </span>
              )}
              {rel.built_at && <span title={absTime(rel.built_at)}>{relTime(rel.built_at)}</span>}
              <button onClick={() => load(true)} className="inline-flex items-center gap-1 hover:text-content-dim">
                <Icon name="refresh" size={11} /> check now
              </button>
            </div>
          )}
          {rel && !rel.available && (
            <p className="mt-3 text-[13px] text-content-dim">
              {rel.reason === "no_release"
                ? "The first app builds are being produced by CI — check back in a few minutes."
                : rel.reason === "not_configured"
                  ? "Downloads aren't configured on this server (missing GitHub token)."
                  : `Builds unavailable right now (${rel.reason}).`}
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
                      {isMine && <span className="pill bg-accent-soft text-accent">this device</span>}
                    </h2>
                    <p className="text-[12px] text-content-faint">{p.sub}</p>
                  </div>
                  {p.id === "android" && list.length > 0 && platform !== "android" && <Qr text={pageUrl} />}
                </div>
                <div className="mt-3 space-y-2">
                  {list.length ? (
                    list.map((a) => <AssetButton key={a.id} a={a} />)
                  ) : (
                    <p className="text-[12px] text-content-faint">{rel?.available ? "No build for this platform in the latest release." : "—"}</p>
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
                  <p className="mt-2 text-[11px] text-content-faint">Scan with your phone to open this page there (log in, then download).</p>
                )}
              </section>
            );
          })}
        </div>

        {rel?.notes && (
          <section className="card mt-3 p-4">
            <h2 className="mb-2 text-[14px] font-semibold">What's in this build</h2>
            <pre className="whitespace-pre-wrap break-words font-sans text-[12.5px] leading-relaxed text-content-dim">{rel.notes}</pre>
          </section>
        )}
      </div>
    </div>
  );
}
