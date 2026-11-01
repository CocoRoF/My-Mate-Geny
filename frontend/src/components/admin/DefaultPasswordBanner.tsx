import { openSettings } from "../../stores/uiStore";
import Icon from "../ui/Icon";
import { useAuthStatus } from "./useAuthStatus";
import { useT } from "../../i18n";

/** Shown on every view while the public default password (admin / geny-admin)
 * still signs in to this server. Not dismissible: it goes away once the
 * credentials are changed in Settings -> Account / Admin -> Security (or AUTH_PASSWORD is set). */
export default function DefaultPasswordBanner() {
  const st = useAuthStatus();
  const t = useT();

  if (!st?.default_password) return null;
  const open = () => openSettings("account");
  return (
    <div className="pt-safe shrink-0 border-b border-warning/30 bg-warning/10" role="alert">
      <div className="flex items-center gap-2 px-4 py-1.5 text-[12.5px] text-warning">
        <Icon name="warning" size={14} className="shrink-0" />
        <span className="min-w-0 flex-1">
          <b className="font-semibold">{t("nav.defaultPassword")}</b>
          <span className="hidden sm:inline">{t("nav.defaultPasswordWhy")}</span>{" "}
          {t.rich("nav.defaultPasswordWhere", { b: (s) => <b className="font-semibold">{s}</b> })}
        </span>
        <button onClick={open} className="shrink-0 rounded-md px-2 py-0.5 font-medium hover:bg-warning/15">
          {t("nav.changeNow")}
        </button>
      </div>
    </div>
  );
}
