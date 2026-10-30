import { useEffect, useState } from "react";
import { getSubscription, type SubscriptionUsage as Sub } from "../../api/usage";
import Icon from "../ui/Icon";

function resetIn(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "soon";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function barColor(pct: number): string {
  if (pct >= 90) return "from-danger to-danger";
  if (pct >= 70) return "from-warning to-warning";
  return "from-accent to-cyan";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-border/60 last:border-0">
      <span className="text-sm text-content-dim">{label}</span>
      <span className="text-sm font-medium text-right">{value}</span>
    </div>
  );
}

function Meter({ label, percent, resets }: { label: string; percent: number; resets: string | null | undefined }) {
  return (
    <div className="py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm text-content">{label}</span>
        <span className="text-sm font-semibold tabular-nums">{Math.round(percent)}%</span>
      </div>
      <div className="h-2 rounded-full bg-surface-3 overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${barColor(percent)} transition-all`}
          style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
        />
      </div>
      {resets && <div className="mt-1 text-[11px] text-content-faint">Resets in {resetIn(resets)}</div>}
    </div>
  );
}

export default function SubscriptionUsage({ provider, accountId }: { provider: string; accountId?: string }) {
  const [sub, setSub] = useState<Sub | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getSubscription(provider, accountId)
      .then(setSub)
      .catch((e) => setSub({ provider, available: false, error: String(e.message || e) }))
      .finally(() => setLoading(false));
  }, [provider, accountId]);

  if (loading)
    return (
      <div className="flex items-center gap-2 text-sm text-content-faint py-6 justify-center">
        <Icon name="spinner" size={15} spin /> Loading usage…
      </div>
    );

  if (!sub?.available) {
    return (
      <div className="text-sm text-content-faint py-4 text-center">
        {sub?.detail || sub?.error || "Usage not available."}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {sub.account && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-content-faint mb-1">Account</div>
          <Row label="Auth method" value={sub.account.auth_method} />
          {sub.account.email && <Row label="Email" value={sub.account.email} />}
          {sub.account.organization && <Row label="Organization" value={sub.account.organization} />}
          <Row label="Plan" value={sub.account.plan} />
        </div>
      )}

      <div>
        <div className="text-[11px] uppercase tracking-wider text-content-faint mb-1">Usage</div>
        {sub.session && <Meter label="Session (5hr)" percent={sub.session.percent} resets={sub.session.resets_at} />}
        {sub.weekly && <Meter label="Weekly (7 day)" percent={sub.weekly.percent} resets={sub.weekly.resets_at} />}
      </div>

      {sub.limits && sub.limits.filter((l) => l.scope?.model?.display_name).length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-content-faint mb-1">By model (weekly)</div>
          {sub.limits
            .filter((l) => l.scope?.model?.display_name)
            .map((l, i) => (
              <Meter key={i} label={l.scope.model.display_name} percent={l.percent} resets={l.resets_at} />
            ))}
        </div>
      )}

      {sub.manage_url && (
        <a
          href={sub.manage_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
        >
          <Icon name="external" size={14} /> Manage usage
        </a>
      )}
    </div>
  );
}
