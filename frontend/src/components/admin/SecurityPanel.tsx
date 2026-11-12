import { useCallback, useEffect, useState } from "react";
import { revokeAllSessions, securityInfo, unbanIp, type SecurityInfo } from "../../api/admin";
import Icon from "../ui/Icon";
import { openSettings } from "../../stores/uiStore";
import { absTime, relTime } from "./format";
import { useT } from "../../i18n";
import { confirmDialog } from "../ui/ConfirmDialog";

export default function SecurityPanel() {
  const t = useT();
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
    if (!(await confirmDialog({ body: t("admin.confirmRevokeAll"), confirmLabel: t("admin.signOutAllDevices"), danger: true }))) return;
    setBusy("__all__");
    try {
      await revokeAllSessions();
      window.alert(t("admin.revokedAll"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1 basis-60 text-[12.5px] text-content-dim">{t("admin.credentialsInAccount")}</div>
        <button onClick={() => openSettings("account")} className="btn-ghost border border-border" data-testid="admin-open-account">
          <Icon name="key" size={14} /> {t("admin.openAccount")}
        </button>
      </div>
      <div className="card flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1 text-[12.5px] text-content-dim">
          {t("admin.revokeHint")}
        </div>
        <button onClick={revokeAll} disabled={busy === "__all__"} className="btn-ghost text-danger hover:text-danger">
          {busy === "__all__" ? <Icon name="spinner" size={14} spin /> : <Icon name="logout" size={14} />} {t("admin.signOutAllDevices")}
        </button>
      </div>
      <div className="card p-4 text-[12.5px] text-content-dim">
        {t.rich("admin.banInfo", {
          b: (s) => <b className="text-content">{s}</b>,
          hours: String(info.ban_hours),
          fails: String(info.max_login_fails),
          ip: <span className="font-mono text-content">{info.your_ip}</span>,
          source: <span className="font-mono">auth</span>,
        })}
      </div>

      {info.attempts.length === 0 ? (
        <div className="card grid place-items-center py-10 text-center">
          <Icon name="shield" size={22} className="text-success mb-2" />
          <p className="text-sm text-content-dim">{t("admin.noFailedLogins")}</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] text-content-faint border-b border-border">
                <th className="px-4 py-2 font-medium">{t("admin.colIp")}</th>
                <th className="px-2 py-2 font-medium">{t("admin.colFailures")}</th>
                <th className="px-2 py-2 font-medium">{t("admin.colStatus")}</th>
                <th className="px-2 py-2 font-medium">{t("admin.colLastAttempt")}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {info.attempts.map((a) => (
                <tr key={a.ip} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-2.5 font-mono text-content">
                    {a.ip}
                    {a.ip === info.your_ip && <span className="ml-2 pill bg-accent-soft text-accent font-sans">{t("common.you")}</span>}
                  </td>
                  <td className="px-2 py-2.5 tabular-nums text-content-dim">{a.fails}</td>
                  <td className="px-2 py-2.5">
                    {a.banned ? (
                      <span className="inline-flex items-center gap-1 text-danger" title={a.banned_until ? absTime(a.banned_until) : ""}>
                        <Icon name="ban" size={12} /> {t("admin.blocked")}
                      </span>
                    ) : (
                      <span className="text-content-faint">{t("admin.watching")}</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-content-faint" title={absTime(a.updated_at)}>
                    {relTime(a.updated_at)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => unban(a.ip)} disabled={busy === a.ip} className="btn-ghost py-1 px-2 text-[12px]">
                      {busy === a.ip ? <Icon name="spinner" size={13} spin /> : a.banned ? t("admin.unblock") : t("common.reset")}
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
