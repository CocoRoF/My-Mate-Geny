import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import {
  getUsageWeek,
  type UsageWeek as Report,
  type WeekSource,
  type WeekItem,
} from "../../api/usage";
import { useT, type MsgKey } from "../../i18n";
import { fmtUsd, apiCostHint } from "../../lib/usage";
import HoverPopover from "../ui/HoverPopover";
import Icon from "../ui/Icon";
import { useMateStore } from "../../stores/mateStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUIStore } from "../../stores/uiStore";
const labels: Record<WeekSource["source"], MsgKey> = {
  chat: "usage.weekChat",
  mate: "usage.weekMate",
  internal: "usage.weekInternal",
};
const colors = {
  chat: "bg-accent",
  mate: "bg-emerald-400",
  internal: "bg-amber-400",
};
const num = (n: number) =>
  new Intl.NumberFormat(undefined, {
    notation: n >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(n);
function go(item: WeekItem) {
  if (item.mate_id) {
    useMateStore.getState().setActive(item.mate_id);
    useUIStore.getState().setView("mate");
  } else {
    useSessionStore.getState().setActive(item.session_id);
    useUIStore.getState().setView("chat");
  }
}
function Details({ source }: { source: WeekSource }) {
  const t = useT();
  return (
    <div
      className="w-[280px] max-w-full space-y-3 p-3"
      data-testid={`usage-detail-${source.source}`}
    >
      <p className="text-sm font-semibold">
        {t("usage.weekTop", { source: t(labels[source.source]) })}
      </p>
      <p className="text-[11px] text-content-faint">{t("usage.weekTopHint")}</p>
      {!source.items.length && (
        <p className="text-xs text-content-faint">{t("usage.weekNoRecords")}</p>
      )}
      {source.items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => go(item)}
          className="block w-full rounded-lg border border-border p-2 text-left hover:bg-surface-3 focus-visible:outline focus-visible:outline-accent"
          data-testid="usage-detail-item"
        >
          <span className="line-clamp-2 break-words text-xs font-medium">
            {item.title}
          </span>
          <span className="mt-1 block text-xs tabular-nums">
            {num(item.tokens)} · {(item.share * 100).toFixed(1)}%
          </span>
          <span className="block break-all text-[10px] text-content-faint">
            {item.models.map((m) => `${m.provider} · ${m.model}`).join(" / ")}
          </span>
          <span className="block text-[10px] text-content-dim">
            {t("usage.apiEquivalent")}:{" "}
            {item.unknown_cost_turns === item.turns
              ? "—"
              : fmtUsd(item.cost_usd)}
          </span>
        </button>
      ))}
      <dl className="grid grid-cols-2 gap-1 text-[11px] text-content-dim">
        {(
          [
            ["weekInput", source.input],
            ["weekOutput", source.output],
            ["weekCacheRead", source.cache_read],
            ["weekCacheWrite", source.cache_write],
          ] as const
        ).map(([k, n]) => (
          <div key={k}>
            <dt>{t(`usage.${k}`)}</dt>
            <dd className="tabular-nums">{num(n)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
function SourceTrigger({
  source,
  children,
  className,
  style,
}: {
  source: WeekSource;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const t = useT();
  return (
    <HoverPopover
      triggerStyle={style}
      align="start"
      label={t("usage.weekDetails", { source: t(labels[source.source]) })}
      trigger={children}
      triggerClassName={`min-w-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${className || ""}`}
      panelClassName="w-[280px]"
    >
      <Details source={source} />
    </HoverPopover>
  );
}
export default function UsageWeek() {
  const t = useT(),
    [data, setData] = useState<Report | null>(null),
    [error, setError] = useState(false);
  const load = () => {
    setError(false);
    getUsageWeek()
      .then(setData)
      .catch(() => setError(true));
  };
  useEffect(() => {
    let active = true;
    getUsageWeek()
      .then((d) => active && setData(d))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, []);
  if (error)
    return (
      <div className="card mb-5 p-4 text-sm" role="status">
        {t("usage.weekError")}{" "}
        <button className="btn-ghost" onClick={load}>
          {t("common.retry")}
        </button>
      </div>
    );
  if (!data)
    return (
      <div className="card mb-5 p-4 text-sm text-content-faint">
        <Icon name="spinner" spin size={14} />
      </div>
    );
  const maximum = Math.max(
    1,
    ...data.daily.map((d) => d.chat.tokens + d.mate.tokens + d.internal.tokens),
  );
  return (
    <section
      className="card mb-6 space-y-4 p-4 sm:p-5"
      data-testid="usage-week"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-base font-semibold">{t("usage.weekTitle")}</h2>
        <span className="text-[11px] text-content-faint">{data.timezone}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-2xl font-semibold tabular-nums">
            {num(data.total.tokens)}
          </p>
          <p className="text-xs text-content-faint">{t("usage.weekTokens")}</p>
        </div>
        <div title={apiCostHint()}>
          <p className="text-xl font-semibold tabular-nums">
            {data.total.unknown_cost_turns === data.total.turns
              ? "—"
              : fmtUsd(data.total.cost_usd)}
          </p>
          <p className="text-xs text-content-faint">
            {t("usage.apiEquivalent")}
          </p>
        </div>
      </div>
      <p className="text-[11px] text-content-faint">{t("usage.weekHint")}</p>
      {data.total.unknown_cost_turns > 0 && (
        <p className="text-[11px] text-content-faint">
          {t("usage.weekUnknownCost", { count: data.total.unknown_cost_turns })}
        </p>
      )}
      {data.total.unknown_token_turns > 0 && (
        <p className="text-[11px] text-content-faint">{t("usage.weekUnknownTokens", {count:data.total.unknown_token_turns})}</p>
      )}
      {!data.total.turns ? (
        <p className="py-5 text-sm text-content-faint">
          {t("usage.weekNoRecords")}
        </p>
      ) : (
        <>
          <div
            className="flex h-5 w-full overflow-hidden rounded-full bg-surface-3"
            data-testid="usage-source-bar"
          >
            {data.sources
              .filter((s) => s.tokens > 0)
              .map((s) => (
                <SourceTrigger
                  key={s.source}
                  source={s}
                  style={{ flex: s.tokens }}
                  className={`${colors[s.source]} h-full`}
                >
                  <span className="block h-full" style={{ width: "100%" }} />
                </SourceTrigger>
              ))}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {data.sources.map((s) => (
              <SourceTrigger
                key={s.source}
                source={s}
                className="inline-flex items-center gap-1.5 text-xs"
              >
                <span
                  className={`h-2.5 w-2.5 rounded-sm ${colors[s.source]}`}
                />
                {t(labels[s.source])}{" "}
                <span className="tabular-nums">
                  {(s.share * 100).toFixed(1)}%
                </span>
              </SourceTrigger>
            ))}
          </div>
          <div
            className="flex h-28 items-end gap-2"
            aria-label={t("usage.weekDaily")}
            data-testid="usage-daily"
          >
            {data.daily.map((day) => {
              const total =
                day.chat.tokens + day.mate.tokens + day.internal.tokens;
              return (
                <div
                  className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1"
                  key={day.day}
                >
                  <span className="truncate text-center text-[9px] tabular-nums text-content-faint">
                    {total ? num(total) : "0"}
                  </span>
                  <div
                    className="flex min-h-[2px] flex-col-reverse overflow-hidden rounded-t bg-surface-3"
                    style={{
                      height: `${Math.max(2, (total / maximum) * 78)}px`,
                    }}
                  >
                    {data.sources.map(
                      (s) =>
                        day[s.source].tokens > 0 && (
                          <SourceTrigger
                            source={s}
                            key={s.source}
                            style={{ flex: day[s.source].tokens }}
                            className={`${colors[s.source]} block w-full`}
                          >
                            <span className="block h-full" />
                          </SourceTrigger>
                        ),
                    )}
                  </div>
                  <span className="text-center text-[10px] tabular-nums text-content-faint">
                    {day.day.slice(5)}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
      <p className="text-[10px] text-content-faint">
        {t("usage.weekInternalNote")}
      </p>
    </section>
  );
}
