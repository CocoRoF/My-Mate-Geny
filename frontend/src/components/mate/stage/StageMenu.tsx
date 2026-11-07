/** Her menu on the stage, like a game's: Status, Places and Outfits, each opening its window over her. */
import { useT, type MsgKey } from "../../../i18n";
import Icon, { type IconName } from "../../ui/Icon";
import "./stage.css";

export type StageWindowKind = "status" | "places" | "outfits";
export const STAGE_WINDOWS: { id: StageWindowKind; icon: IconName; label: MsgKey }[] = [
  { id: "status", icon: "heart", label: "stage.status" },
  { id: "places", icon: "map", label: "stage.places" },
  { id: "outfits", icon: "shirt", label: "stage.outfits" },
];

export default function StageMenu({ open, onOpen, compact = false }: { open: StageWindowKind | null; onOpen: (k: StageWindowKind) => void; compact?: boolean }) {
  const t = useT();
  return (
    <nav className={`stage-menu ${compact ? "compact" : ""}`} aria-label={t("stage.menu")} data-testid="stage-menu">
      {STAGE_WINDOWS.map(({ id, icon, label }) => (
        <button key={id} type="button" className="stage-menu-btn" aria-pressed={open === id} onClick={() => onOpen(id)} data-testid={`stage-menu-${id}`}>
          <Icon name={icon} size={compact ? 16 : 18} />
          <span>{t(label)}</span>
        </button>
      ))}
    </nav>
  );
}
