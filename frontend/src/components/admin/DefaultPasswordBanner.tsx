import { useEffect, useState } from "react";
import { AUTH_CHANGED_EVENT, authStatus } from "../../api/admin";
import { useUIStore } from "../../stores/uiStore";
import Icon from "../ui/Icon";
import { requestAdminTab } from "./adminTab";

/** Shown on every view while the public default password (admin / geny-admin)
 * still signs in to this server. Not dismissible: it goes away once the
 * credentials are changed in Admin -> Security (or AUTH_PASSWORD is set). */
export default function DefaultPasswordBanner() {
  const [isDefault, setDefault] = useState(false);
  const setView = useUIStore((s) => s.setView);

  useEffect(() => {
    const check = () => authStatus().then((s) => setDefault(s.default_password)).catch(() => {});
    check();
    window.addEventListener(AUTH_CHANGED_EVENT, check);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, check);
  }, []);

  if (!isDefault) return null;
  const open = () => {
    requestAdminTab("security");
    setView("admin");
  };
  return (
    <div className="pt-safe shrink-0 border-b border-warning/30 bg-warning/10" role="alert">
      <div className="flex items-center gap-2 px-4 py-1.5 text-[12.5px] text-warning">
        <Icon name="warning" size={14} className="shrink-0" />
        <span className="min-w-0 flex-1">
          <b className="font-semibold">Default password</b>
          <span className="hidden sm:inline"> — anyone who can reach this server can sign in.</span> Change it in{" "}
          <b className="font-semibold">Admin → Security</b>.
        </span>
        <button onClick={open} className="shrink-0 rounded-md px-2 py-0.5 font-medium hover:bg-warning/15">
          Change now
        </button>
      </div>
    </div>
  );
}
