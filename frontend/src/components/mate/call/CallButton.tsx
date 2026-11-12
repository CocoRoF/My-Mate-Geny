/**
 * 📞 in the Mate view's header on a phone (the Android app, or a phone's browser): call her. While a call is on it opens
 * the call screen again.
 */
import type { Mate } from "../../../api/mates";
import { useT } from "../../../i18n";
import { callBusy, useCallStore } from "../../../stores/callStore";
import Icon from "../../ui/Icon";

export default function CallButton({ mate, className = "" }: { mate: Mate; className?: string }) {
  const t = useT();
  const busy = useCallStore(callBusy);
  const minimized = useCallStore((s) => s.minimized);
  const label = busy ? t("mate.callExpand") : t("mate.callButton", { name: mate.name });
  return (
    <button
      type="button"
      onClick={() => (busy ? minimized && useCallStore.getState().minimize(false) : void useCallStore.getState().dial(mate))}
      className={`${className} ${busy ? "!text-success" : ""}`}
      title={label}
      aria-label={label}
      data-testid="mate-call"
    >
      <Icon name="phone" size={16} />
    </button>
  );
}
