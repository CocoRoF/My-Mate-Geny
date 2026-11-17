/** A realtime speech-to-text failure in the user's words (the chat's mic, a call's listening). */
import { tr } from "../../i18n";
import type { SttFailure } from "./scribe";

export function sttFailureText(code: SttFailure, reason: string): string {
  switch (code) {
    case "missing":
      return tr("mate.sttRtMissing");
    case "auth":
      return tr("mate.sttRtAuth", { reason });
    case "quota":
      return tr("mate.sttRtQuota", { reason });
    case "busy":
      return tr("mate.sttRtBusy");
    case "network":
      return tr("mate.sttRtNetwork", { reason });
    default:
      return tr("mate.sttFailed", { reason });
  }
}
