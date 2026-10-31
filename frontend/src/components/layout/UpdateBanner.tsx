import { useEffect, useState } from "react";
import { compareVersions, getDownloads } from "../../api/downloads";
import { useUIStore } from "../../stores/uiStore";
import Icon from "../ui/Icon";

/** Inside the desktop/Android app: tell the user when a newer app build exists. */
export default function UpdateBanner() {
  const [latest, setLatest] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem("hrh_update_dismissed") || "";
    } catch {
      return "";
    }
  });
  const setView = useUIStore((s) => s.setView);
  const native = window.hrhNative;

  useEffect(() => {
    if (!native) return;
    const check = () => getDownloads().then((r) => r.available && r.version && setLatest(r.version)).catch(() => {});
    check();
    const t = setInterval(check, 6 * 3600 * 1000);
    return () => clearInterval(t);
  }, [native]);

  if (!native || !latest || compareVersions(latest, native.version) <= 0 || dismissed === latest) return null;
  return (
    <div className="pt-safe shrink-0 bg-accent-soft border-b border-accent/30">
      <div className="flex items-center gap-2 px-4 py-1.5 text-[12.5px] text-accent">
        <Icon name="download" size={14} />
        <span className="min-w-0 flex-1 truncate">
          My Mate Geny {latest} is available (you have {native.version}).
        </span>
        <button onClick={() => setView("downloads")} className="rounded-md px-2 py-0.5 font-medium hover:bg-accent/15">
          Update
        </button>
        <button
          onClick={() => {
            setDismissed(latest);
            try {
              localStorage.setItem("hrh_update_dismissed", latest);
            } catch {
              /* ignore */
            }
          }}
          className="rounded-md p-1 hover:bg-accent/15"
          title="Dismiss"
        >
          <Icon name="x" size={13} />
        </button>
      </div>
    </div>
  );
}
