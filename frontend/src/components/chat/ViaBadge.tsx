import type { MessageMeta } from "../../stores/chatStore";
import Icon from "../ui/Icon";
import { useT } from "../../i18n";

/** "via Estelle": a message a mate sent into this chat on the user's behalf. */
export default function ViaBadge({ meta }: { meta?: MessageMeta | null }) {
  const t = useT();
  const via = meta?.via;
  if (!via || via.kind !== "mate") return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-violet/30 bg-violet/10 px-2 py-0.5 text-[10.5px] font-medium text-violet"
      title={t("chat.viaTitle", { name: via.name || "" }).trim()}
      data-testid="via-badge"
    >
      <Icon name="sparkles" size={10} /> {t("chat.via", { name: via.name || t("chat.mateFallback") })}
    </span>
  );
}
