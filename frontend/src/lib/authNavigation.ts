/** Keep every sign-out path on the desktop's connection chooser; browsers retain web authentication. */
export interface AuthNavigationDeps {
  nativeSignOut: () => (() => Promise<unknown>) | null;
  revokeWebSession: () => Promise<unknown>;
  showWebLogin: () => void;
}

export function createAuthNavigation(deps: AuthNavigationDeps) {
  let pending: Promise<void> | null = null;
  function leave(explicit: boolean): Promise<void> {
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      const native = deps.nativeSignOut();
      if (native) {
        await native();
        return;
      }
      if (explicit) await deps.revokeWebSession().catch(() => {});
      deps.showWebLogin();
    }).finally(() => { pending = null; });
    return pending;
  }
  return { signOut: () => leave(true), authenticationRequired: () => leave(false) };
}

const navigation = createAuthNavigation({
  nativeSignOut: () => {
    const bridge = window.hrhNative;
    return typeof bridge?.signOut === "function" ? () => bridge.signOut!() : null;
  },
  revokeWebSession: () => fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }),
  showWebLogin: () => { window.location.href = "/login"; },
});

export const signOutHere = navigation.signOut;
export const authenticationRequired = navigation.authenticationRequired;
