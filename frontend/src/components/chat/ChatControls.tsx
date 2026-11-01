import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackHandler } from "../../lib/back";
import { useConfigStore } from "../../stores/configStore";
import { useProviderStore } from "../../stores/providerStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { Session } from "../../types";
import Icon, { type IconName } from "../ui/Icon";
import { useT, type MsgKey } from "../../i18n";

const MODES: { id: string; label: MsgKey; hint: MsgKey }[] = [
  { id: "agent", label: "chat.modeAgent", hint: "chat.modeAgentHint" },
  { id: "plan", label: "chat.modePlan", hint: "chat.modePlanHint" },
];

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
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 sm:py-1 text-[12px] sm:text-[11.5px] font-medium transition ${
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
  items: { id: string; label: string; hint?: string }[];
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  // Rendered through a portal: the chip row scrolls horizontally on phones,
  // which would clip an absolutely positioned menu.
  const anchor = useRef<HTMLSpanElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const mobile = typeof window !== "undefined" && window.innerWidth < 640;
  useBackHandler(true, onClose);

  useLayoutEffect(() => {
    const el = anchor.current?.parentElement;
    if (!el || mobile) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 336)), bottom: window.innerHeight - r.top + 6 });
  }, [mobile]);

  useEffect(() => {
    const h = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.parentElement?.contains(t)) return;
      onClose();
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", h);
    window.addEventListener("touchstart", h);
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("mousedown", h);
      window.removeEventListener("touchstart", h);
      window.removeEventListener("keydown", k);
    };
  }, [onClose]);

  const list = items.map((it) => (
    <button
      key={it.id}
      onClick={() => {
        onPick(it.id);
        onClose();
      }}
      className={`flex w-full items-center gap-2 px-3 py-2.5 sm:py-2 text-[14px] sm:text-[13px] transition hover:bg-surface-3 ${
        it.id === current ? "text-accent" : "text-content"
      }`}
    >
      <span className="w-3.5 shrink-0">{it.id === current && <Icon name="check" size={13} />}</span>
      <span className="min-w-0 text-left">
        <span className="block truncate">{it.label}</span>
        {it.hint && <span className="block truncate text-[11px] text-content-faint">{it.hint}</span>}
      </span>
    </button>
  ));

  return (
    <>
      <span ref={anchor} className="hidden" />
      {createPortal(
        mobile ? (
          <div className="fixed inset-0 z-[70] flex items-end bg-black/45 animate-fade-in">
            <div ref={ref} className="w-full max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface-2 pb-safe pt-1.5 shadow-float">
              <div className="mx-auto mb-1 h-1 w-10 rounded-full bg-border-strong" />
              {list}
            </div>
          </div>
        ) : pos ? (
          <div
            ref={ref}
            style={{ left: pos.left, bottom: pos.bottom }}
            className="fixed z-[70] min-w-[200px] max-w-[320px] max-h-80 overflow-y-auto rounded-xl border border-border bg-surface-2 shadow-float animate-fade-in"
          >
            {list}
          </div>
        ) : null,
        document.body,
      )}
    </>
  );
}

type Option = { id: string; label: string; hint?: string };

/** Phones: every setting in one bottom sheet. Short choices are pills, models a list. */
function SettingsSheet({
  groups,
  onClose,
}: {
  groups: { title: string; items: Option[]; current: string; onPick: (id: string) => void; list?: boolean }[];
  onClose: () => void;
}) {
  const t = useT();
  useBackHandler(true, onClose);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end bg-black/45 animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface-2 pb-safe pt-1.5 shadow-float">
        <div className="mx-auto mb-1 h-1 w-10 rounded-full bg-border-strong" />
        <div className="flex items-center px-4 pt-1">
          <span className="text-[13px] font-semibold text-content">{t("chat.chatSettings")}</span>
          <button onClick={onClose} className="ml-auto h-10 rounded-lg px-3 text-[13px] font-medium text-accent hover:bg-surface-3">
            {t("common.done")}
          </button>
        </div>
        {groups.map((g) => (
          <div key={g.title} className="pb-2">
            <div className="px-4 pb-1.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-content-faint">{g.title}</div>
            {g.list ? (
              g.items.map((it) => (
                <button
                  key={it.id}
                  onClick={() => g.onPick(it.id)}
                  className={`flex w-full min-h-[44px] items-center gap-2 px-4 py-2 text-[14px] transition hover:bg-surface-3 ${
                    it.id === g.current ? "text-accent" : "text-content"
                  }`}
                >
                  <span className="w-3.5 shrink-0">{it.id === g.current && <Icon name="check" size={13} />}</span>
                  <span className="min-w-0 text-left">
                    <span className="block truncate">{it.label}</span>
                    {it.hint && <span className="block truncate text-[11px] text-content-faint">{it.hint}</span>}
                  </span>
                </button>
              ))
            ) : (
              <div className="flex flex-wrap gap-2 px-4">
                {g.items.map((it) => (
                  <button
                    key={it.id}
                    onClick={() => g.onPick(it.id)}
                    className={`h-10 rounded-lg border px-3.5 text-[13.5px] font-medium transition ${
                      it.id === g.current
                        ? "border-accent/50 bg-accent-soft text-accent"
                        : "border-border bg-surface text-content-dim hover:text-content"
                    }`}
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export default function ChatControls({ session, compact = false }: { session: Session; compact?: boolean }) {
  const t = useT();
  const modes = MODES.map((m) => ({ id: m.id, label: t(m.label), hint: t(m.hint) }));
  const catalog = useConfigStore((s) => s.catalog);
  const providers = useProviderStore((s) => s.providers);
  const update = useSessionStore((s) => s.update);
  const [openMenu, setOpenMenu] = useState<"provider" | "model" | "effort" | "mode" | "all" | null>(null);

  const entry = catalog[session.provider];
  const connectedProviders = providers.filter((p) => p.connected).map((p) => p.provider);

  const providerItems = Object.entries(catalog).map(([id, c]) => ({
    id,
    label: c.label + (connectedProviders.includes(id) ? "" : ` (${t("chat.notConnected")})`),
    hint: id === session.provider ? undefined : t("chat.switchEngineHint"),
  }));
  const modelItems = entry?.models.map((m) => ({ id: m.id, label: m.label, hint: m.description })) ?? [];
  const curModel = entry?.models.find((m) => m.id === session.model);
  // Codex models each declare their own reasoning levels.
  const efforts = curModel?.effort?.length ? curModel.effort : entry?.effort ?? ["default"];
  const effortItems = efforts.map((e) => ({
    id: e,
    label: e === "default" ? `${t("common.default")}${curModel?.default_effort && curModel.default_effort !== "default" ? ` (${curModel.default_effort})` : ""}` : e,
  }));
  const mode = session.mode || "agent";

  const curModelLabel =
    entry?.models.find((m) => m.id === session.model)?.label || session.model || t("chat.modelFallback");

  const pickMode = (id: string) => update(session.id, { mode: id as "agent" | "plan" });
  const pickProvider = (id: string) => {
    const def = catalog[id]?.default_model || "";
    update(session.id, { provider: id, model: def, effort: "default" });
  };
  const pickModel = (id: string) => {
    const m = entry?.models.find((x) => x.id === id);
    const keep = !m?.effort?.length || m.effort.includes(session.effort);
    update(session.id, keep ? { model: id } : { model: id, effort: "default" });
  };
  const pickEffort = (id: string) => update(session.id, { effort: id });

  if (compact) {
    const effort = session.effort && session.effort !== "default" ? session.effort : "";
    const summary = [
      mode === "plan" ? t("chat.modePlan") : t("chat.modeAgent"),
      curModel?.label || session.model || entry?.label || session.provider,
      effort,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div data-controls className="min-w-0">
        <button
          onClick={() => setOpenMenu("all")}
          className={`flex h-10 max-w-full items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium transition ${
            openMenu === "all" ? "bg-accent-soft text-accent" : "text-content-dim hover:bg-surface-3 hover:text-content"
          }`}
          title={t("chat.controlsTitle")}
        >
          <Icon name={mode === "plan" ? "file-text" : "bolt"} size={14} className={`shrink-0 ${mode === "plan" ? "text-violet" : "text-accent"}`} />
          <span className="truncate">{summary}</span>
          <Icon name="chevron-down" size={12} className="shrink-0 opacity-60" />
        </button>
        {openMenu === "all" && (
          <SettingsSheet
            onClose={() => setOpenMenu(null)}
            groups={[
              { title: t("chat.groupMode"), items: modes, current: mode, onPick: pickMode, list: true },
              { title: t("chat.groupEngine"), items: providerItems.map((p) => ({ ...p, hint: undefined })), current: session.provider, onPick: pickProvider },
              ...(modelItems.length ? [{ title: t("chat.groupModel"), items: modelItems, current: session.model, onPick: pickModel, list: true }] : []),
              ...(effortItems.length > 1 ? [{ title: t("chat.groupThink"), items: effortItems, current: session.effort, onPick: pickEffort }] : []),
            ]}
          />
        )}
      </div>
    );
  }

  return (
    <div data-controls className="flex flex-nowrap sm:flex-wrap items-center gap-1.5 px-1 overflow-x-auto sm:overflow-visible no-scrollbar">
      {/* Mode */}
      <div className="relative">
        <Chip
          icon={mode === "plan" ? "file-text" : "bolt"}
          label={mode === "plan" ? t("chat.modePlan") : t("chat.modeAgent")}
          open={openMenu === "mode"}
          onClick={() => setOpenMenu(openMenu === "mode" ? null : "mode")}
        />
        {openMenu === "mode" && (
          <Menu
            items={modes}
            current={mode}
            onClose={() => setOpenMenu(null)}
            onPick={pickMode}
          />
        )}
      </div>

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
            onPick={pickProvider}
          />
        )}
      </div>

      {/* Model */}
      {modelItems.length > 0 && (
        <div className="relative">
          <Chip
            icon="activity"
            label={curModelLabel}
            open={openMenu === "model"}
            onClick={() => setOpenMenu(openMenu === "model" ? null : "model")}
          />
          {openMenu === "model" && (
            <Menu
              items={modelItems}
              current={session.model}
              onClose={() => setOpenMenu(null)}
              onPick={pickModel}
            />
          )}
        </div>
      )}

      {/* Think level */}
      {effortItems.length > 1 && (
        <div className="relative">
          <Chip
            icon="terminal"
            label={t("chat.thinkChip", { level: !session.effort || session.effort === "default" ? t("common.default") : session.effort })}
            open={openMenu === "effort"}
            onClick={() => setOpenMenu(openMenu === "effort" ? null : "effort")}
          />
          {openMenu === "effort" && (
            <Menu
              items={effortItems}
              current={session.effort}
              onClose={() => setOpenMenu(null)}
              onPick={pickEffort}
            />
          )}
        </div>
      )}
    </div>
  );
}
