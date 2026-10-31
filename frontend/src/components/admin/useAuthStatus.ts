import { useEffect, useState } from "react";
import { AUTH_CHANGED_EVENT, sharedAuthStatus, type AuthStatus } from "../../api/admin";

/** Current sign-in identity (shared fetch; refreshes after a credential change). */
export function useAuthStatus(): AuthStatus | null {
  const [st, setSt] = useState<AuthStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      sharedAuthStatus()
        .then((s) => alive && setSt(s))
        .catch(() => {});
    load();
    window.addEventListener(AUTH_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(AUTH_CHANGED_EVENT, load);
    };
  }, []);
  return st;
}
