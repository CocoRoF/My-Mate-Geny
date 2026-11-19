/**
 * A window over her on the stage (desktop), or a sheet from the bottom (phone: the stage is too short for one). Escape,
 * the scrim and the close button close it. Tabs are optional. `wide`: a big window over the whole view — her status,
 * with room for a graph of her memories (it grows with the screen); `panel`: no window — it fills where it is put (the
 * desktop chat window). `actions`: buttons beside the close one.
 */
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT, type MsgKey } from "../../../i18n";
import BottomSheet from "../../ui/BottomSheet";
import Icon, { type IconName } from "../../ui/Icon";
import ScrollRow from "../../ui/ScrollRow";
import "./stage.css";

export interface WindowTab<T extends string> {
  id: T;
  icon: IconName;
  label: MsgKey;
}

export default function StageWindow<T extends string>({
  title,
  sub,
  icon,
  phone,
  onClose,
  tabs,
  tab,
  onTab,
  testId,
  wide = false,
  panel = false,
  actions,
  children,
}: {
  title: string;
  sub?: string;
  icon: IconName;
  phone: boolean;
  onClose: () => void;
  tabs?: WindowTab<T>[];
  tab?: T;
  onTab?: (t: T) => void;
  testId: string;
  wide?: boolean;
  panel?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  const head = (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-content/10 px-4 py-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-content/10 text-content">
        <Icon name={icon} size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[14.5px] font-semibold text-content">{title}</h2>
        {sub && <p className="truncate text-[11px] text-content-faint">{sub}</p>}
      </div>
      {actions}
      <button onClick={onClose} className="btn-ghost !px-2" aria-label={t("common.close")} data-testid={`${testId}-close`}>
        <Icon name="x" size={16} />
      </button>
    </div>
  );
  const tabBar = tabs && tabs.length > 1 && (
    <ScrollRow className="shrink-0 gap-1 border-b border-content/10 px-3 py-2" role="tablist" aria-label={title} watch={tab}>
      {tabs.map((x) => (
        <button
          key={x.id}
          type="button"
          role="tab"
          aria-selected={tab === x.id}
          className={`shrink-0 ${tab === x.id ? "btn-soft" : "btn-ghost"} !px-2.5 !py-1 text-[12.5px]`}
          onClick={() => onTab?.(x.id)}
          data-testid={`${testId}-tab-${x.id}`}
        >
          <Icon name={x.icon} size={13} />
          {t(x.label)}
        </button>
      ))}
    </ScrollRow>
  );
  const body = (
    <div className={`fit-fields scrollbar-stable min-h-0 flex-1 space-y-3 overflow-y-auto pb-safe ${wide ? "px-6 py-5" : "px-4 py-4"}`} data-testid={`${testId}-body`}>
      {children}
    </div>
  );
  if (panel) {
    return (
      <div className="flex h-full flex-col bg-surface" role="region" aria-label={title} data-testid={testId}>
        {head}
        {tabBar}
        {body}
      </div>
    );
  }
  if (phone) {
    return createPortal(
      <BottomSheet onClose={onClose} label={title} testId={testId}>
        <div className="flex h-[calc(80vh-30px)] flex-col">
          {head}
          {tabBar}
          {body}
        </div>
      </BottomSheet>,
      document.body,
    );
  }
  if (wide) {
    // (over the whole view, below the desktop app's own title bar: wider than her stage, as wide as the screen allows)
    return createPortal(
      <div className="stage-window-layer-wide" data-testid={`${testId}-layer`}>
        <div className="stage-window-scrim" onClick={onClose} aria-hidden="true" />
        <div className="stage-window stage-window-wide" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
          {head}
          {tabBar}
          {body}
        </div>
      </div>,
      document.body,
    );
  }
  return (
    <div className="absolute inset-0 z-30" data-testid={`${testId}-layer`}>
      <div className="stage-window-scrim" onClick={onClose} aria-hidden="true" />
      <div className="stage-window" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        {head}
        {tabBar}
        {body}
      </div>
    </div>
  );
}
