import { useEffect, useRef, useState } from "react";
import { useConfigStore } from "../../stores/configStore";
import { useProviderStore } from "../../stores/providerStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { Session } from "../../types";
import Icon, { type IconName } from "../ui/Icon";

const EFFORT_LABEL: Record<string, string> = {
  default: "Think: default",
  minimal: "Think: minimal",
  low: "Think: low",
  medium: "Think: medium",
  high: "Think: high",
  xhigh: "Think: xhigh",
  max: "Think: max",
};

function Chip({
  icon,
  label,
  open,
  onClick,
}: {
  icon: IconName;
  label: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition ${
        open
          ? "border-accent/50 bg-accent-soft text-accent"
          : "border-border bg-surface text-content-dim hover:text-content hover:border-border-strong"
      }`}
    >
      <Icon name={icon} size={13} />
      {label}
      <Icon name="chevron-down" size={12} className="opacity-60" />
    </button>
  );
}

function Menu({
  items,
  current,
  onPick,
  onClose,
}: {
  items: { id: string; label: string }[];
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute bottom-[calc(100%+6px)] left-0 z-40 min-w-[180px] overflow-hidden rounded-xl border border-border bg-surface-2 shadow-float animate-fade-in"
    >
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => {
            onPick(it.id);
            onClose();
          }}
          className={`flex w-full items-center gap-2 px-3 py-2 text-[13px] transition hover:bg-surface-3 ${
            it.id === current ? "text-accent" : "text-content"
          }`}
        >
          <span className="w-3.5">{it.id === current && <Icon name="check" size={13} />}</span>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export default function ChatControls({ session }: { session: Session }) {
  const catalog = useConfigStore((s) => s.catalog);
  const providers = useProviderStore((s) => s.providers);
  const update = useSessionStore((s) => s.update);
  const [openMenu, setOpenMenu] = useState<"provider" | "model" | "effort" | null>(null);

  const entry = catalog[session.provider];
  const connectedProviders = providers.filter((p) => p.connected).map((p) => p.provider);

  const providerItems = Object.entries(catalog).map(([id, c]) => ({
    id,
    label: c.label + (connectedProviders.includes(id) ? "" : " (not connected)"),
  }));
  const modelItems = entry?.models.map((m) => ({ id: m.id, label: m.label })) ?? [];
  const effortItems = (entry?.effort ?? ["default"]).map((e) => ({
    id: e,
    label: e === "default" ? "Default" : e,
  }));

  const curModelLabel =
    entry?.models.find((m) => m.id === session.model)?.label || session.model || "model";

  return (
    <div className="flex items-center gap-1.5 px-1">
      {/* Provider */}
      <div className="relative">
        <Chip
          icon="cpu"
          label={entry?.label || session.provider}
          open={openMenu === "provider"}
          onClick={() => setOpenMenu(openMenu === "provider" ? null : "provider")}
        />
        {openMenu === "provider" && (
          <Menu
            items={providerItems}
            current={session.provider}
            onClose={() => setOpenMenu(null)}
            onPick={(id) => {
              const def = catalog[id]?.default_model || "";
              update(session.id, { provider: id, model: def, effort: "default" });
            }}
          />
        )}
      </div>

      {/* Model */}
      {modelItems.length > 0 && (
        <div className="relative">
          <Chip
            icon="bolt"
            label={curModelLabel}
            open={openMenu === "model"}
            onClick={() => setOpenMenu(openMenu === "model" ? null : "model")}
          />
          {openMenu === "model" && (
            <Menu
              items={modelItems}
              current={session.model}
              onClose={() => setOpenMenu(null)}
              onPick={(id) => update(session.id, { model: id })}
            />
          )}
        </div>
      )}

      {/* Think level */}
      {effortItems.length > 1 && (
        <div className="relative">
          <Chip
            icon="terminal"
            label={EFFORT_LABEL[session.effort] || `Think: ${session.effort}`}
            open={openMenu === "effort"}
            onClick={() => setOpenMenu(openMenu === "effort" ? null : "effort")}
          />
          {openMenu === "effort" && (
            <Menu
              items={effortItems}
              current={session.effort}
              onClose={() => setOpenMenu(null)}
              onPick={(id) => update(session.id, { effort: id })}
            />
          )}
        </div>
      )}
    </div>
  );
}
