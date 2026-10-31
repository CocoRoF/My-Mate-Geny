import { useCallback, useEffect, useState } from "react";
import { revokeAllSessions, securityInfo, unbanIp, type SecurityInfo } from "../../api/admin";
import Icon from "../ui/Icon";
import CredentialsCard from "./CredentialsCard";
import { absTime, relTime } from "./format";

export default function SecurityPanel() {
  const [info, setInfo] = useState<SecurityInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => securityInfo().then(setInfo).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);

  if (!info) return <Icon name="spinner" size={18} spin className="text-content-faint" />;

  const unban = async (ip: string) => {
    setBusy(ip);
    try {
      await unbanIp(ip);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const revokeAll = async () => {
    if (!window.confirm("Sign out every device and app (this browser stays signed in)?")) return;
    setBusy("__all__");
    try {
      await revokeAllSessions();
      window.alert("All other sessions have been signed out.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <CredentialsCard />
      <div className="card flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1 text-[12.5px] text-content-dim">
          Lost a device or shared a session? Ends every signed-in browser, desktop and Android app at once.
          Changing the credentials above does the same.
        </div>
        <button onClick={revokeAll} disabled={busy === "__all__"} className="btn-ghost text-danger hover:text-danger">
          {busy === "__all__" ? <Icon name="spinner" size={14} spin /> : <Icon name="logout" size={14} />} Sign out all devices
        </button>
      </div>
      <div className="card p-4 text-[12.5px] text-content-dim">
        An IP is blocked for <b className="text-content">{info.ban_hours}h</b> after{" "}
        <b className="text-content">{info.max_login_fails}</b> failed logins. Your current IP is{" "}
        <span className="font-mono text-content">{info.your_ip}</span>. Every failed login and block is also in the Logs tab
        (source <span className="font-mono">auth</span>).
      </div>

      {info.attempts.length === 0 ? (
        <div className="card grid place-items-center py-10 text-center">
          <Icon name="shield" size={22} className="text-success mb-2" />
          <p className="text-sm text-content-dim">No failed login attempts on record.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] text-content-faint border-b border-border">
                <th className="px-4 py-2 font-medium">IP</th>
                <th className="px-2 py-2 font-medium">Failures</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Last attempt</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {info.attempts.map((a) => (
                <tr key={a.ip} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-2.5 font-mono text-content">
                    {a.ip}
                    {a.ip === info.your_ip && <span className="ml-2 pill bg-accent-soft text-accent font-sans">you</span>}
                  </td>
                  <td className="px-2 py-2.5 tabular-nums text-content-dim">{a.fails}</td>
                  <td className="px-2 py-2.5">
                    {a.banned ? (
                      <span className="inline-flex items-center gap-1 text-danger" title={a.banned_until ? absTime(a.banned_until) : ""}>
                        <Icon name="ban" size={12} /> Blocked
                      </span>
                    ) : (
                      <span className="text-content-faint">Watching</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-content-faint" title={absTime(a.updated_at)}>
                    {relTime(a.updated_at)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => unban(a.ip)} disabled={busy === a.ip} className="btn-ghost py-1 px-2 text-[12px]">
                      {busy === a.ip ? <Icon name="spinner" size={13} spin /> : a.banned ? "Unblock" : "Reset"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
