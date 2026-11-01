/**
 * The desktop app's update error in words (downloads/UpdateCard.tsx): what was attempted (check / download / install)
 * and why. The app (desktop/src/updater.js) says why with `errorCode` (+ `errorDetail`), worded here in the UI's
 * language; an older app sends only `error`, in English, which is shown as it is.
 */
import type { MsgKey, Vars } from "../i18n";

export type UpdateErrorCode = "signIn" | "replaced" | "noUpdate" | "server" | "unreachable" | "damaged" | "cannotSelfUpdate" | "other";

export interface UpdateErrorState {
  error?: string;
  errorCode?: UpdateErrorCode;
  errorDetail?: string;
  during?: "check" | "download" | "install";
}

const WHY: Partial<Record<UpdateErrorCode, MsgKey>> = {
  signIn: "downloads.updErrSignIn",
  replaced: "downloads.updErrReplaced",
  noUpdate: "downloads.updErrNoUpdate",
  server: "downloads.updErrServer",
  unreachable: "downloads.updErrUnreachable",
  damaged: "downloads.updErrDamaged",
  cannotSelfUpdate: "downloads.updErrCannotSelfUpdate",
};

export function updateErrorText(t: (key: MsgKey, vars?: Vars) => string, s: UpdateErrorState): string {
  const key = s.errorCode && WHY[s.errorCode];
  const why = key ? t(key, { detail: s.errorDetail || "" }) : s.errorDetail || s.error || "";
  const what: MsgKey = s.during === "download" ? "downloads.errorDownload" : s.during === "install" ? "downloads.errorInstall" : "downloads.errorCheck";
  return t(what, { error: why });
}
