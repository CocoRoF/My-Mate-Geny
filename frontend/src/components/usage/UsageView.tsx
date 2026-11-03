import { useEffect, useState } from "react";
import UsageWeek from "./UsageWeek";
import { getPool, type Account } from "../../api/accounts";
import { useProviderStore } from "../../stores/providerStore";
import { useT, type MsgKey } from "../../i18n";
import Icon from "../ui/Icon";
import SubscriptionUsage from "./SubscriptionUsage";
import HiggsfieldUsage from "./HiggsfieldUsage";

const STATUS: Record<string, MsgKey> = {
  cooldown: "usage.status_cooldown",
  expired: "usage.status_expired",
  unknown: "usage.status_unknown",
};

export default function UsageView() {
  const t = useT();
  const providers = useProviderStore((s) => s.providers);
  const connected = providers.filter((p) => p.connected);
  const [tab, setTab] = useState<string>("");

  useEffect(() => {
    if (!tab && connected.length) setTab(connected[0].provider);
  }, [connected, tab]);

  // Every connected account of the provider (the host login + added ones).
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  useEffect(() => {
    if (!tab) return;
    let alive = true;
    setAccounts(null);
    getPool(tab)
      .then((p) => alive && setAccounts(p.accounts.filter((a) => a.primary || a.usable)))
      .catch(() => alive && setAccounts([]));
    return () => {
      alive = false;
    };
  }, [tab]);

  return (
    // (Settings → Usage: the tab's title is Settings')
    <div className="max-w-2xl">
      <div>

        <UsageWeek/>
        {/* provider tabs */}
        {connected.length > 1 && (
          <div className="flex gap-1.5 mb-5">
            {connected.map((p) => (
              <button
                key={p.provider}
                onClick={() => setTab(p.provider)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize transition ${
                  tab === p.provider ? "bg-surface-3 text-content" : "text-content-dim hover:text-content"
                }`}
              >
                {p.provider}
              </button>
            ))}
          </div>
        )}

        {tab && accounts === null && (
          <div className="card p-5 flex items-center justify-center gap-2 text-sm text-content-faint">
            <Icon name="spinner" size={15} spin /> {t("usage.loadingAccounts")}
          </div>
        )}
        {/* no account list (older server / error): the host login alone */}
        {tab && accounts !== null && accounts.length === 0 && (
          <div className="card p-5">
            <SubscriptionUsage provider={tab} />
          </div>
        )}
        {tab && accounts && accounts.length > 0 && (
          <div className="space-y-4">
            {accounts.map((a) => (
              <div key={a.id} className="card p-5">
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-sm font-semibold text-content">{a.label}</span>
                  {a.primary && <span className="pill bg-accent/15 text-accent">{t("usage.thisMachine")}</span>}
                  {!a.enabled && <span className="pill bg-surface-3 text-content-faint">{t("usage.disabled")}</span>}
                  {a.status && a.status !== "ready" && (
                    <span className="pill bg-warning/15 text-warning">{STATUS[a.status] ? t(STATUS[a.status]) : a.status.replace(/_/g, " ")}</span>
                  )}
                </div>
                {a.auth_mode === "api_key" ? (
                  <p className="text-sm text-content-faint">{t("usage.apiKeyBilled")}</p>
                ) : (
                  <SubscriptionUsage provider={tab} accountId={a.primary ? undefined : a.id} />
                )}
              </div>
            ))}
          </div>
        )}
        {connected.length === 0 && (
          <p className="text-sm text-content-faint">{t("usage.connectProvider")}</p>
        )}

        <HiggsfieldUsage />


      </div>
    </div>
  );
}
