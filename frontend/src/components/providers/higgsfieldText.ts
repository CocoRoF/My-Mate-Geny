// What the Higgsfield screens say for the server's error codes ("<code>: <detail>", routers/higgsfield.py).
import { higgsfieldErrorCode } from "../../api/higgsfield";
import { tr, type MsgKey } from "../../i18n";
import { fmtNum } from "../../i18n/format";

const ERRORS: Record<string, MsgKey> = {
  not_connected: "higgsfield.errNotConnected",
  reauth_required: "higgsfield.errReauth",
  invalid_callback: "higgsfield.errInvalidCallback",
  oauth_denied: "higgsfield.errDenied",
  login_expired: "higgsfield.errLoginExpired",
  import_failed: "higgsfield.errImportFailed",
  unknown_workspace: "higgsfield.errUnknownWorkspace",
  token_exchange_failed: "higgsfield.errTokenExchange",
  network: "higgsfield.errNetwork",
  api_error: "higgsfield.errApi",
  bad_json: "higgsfield.errApi",
  skills_failed: "higgsfield.errSkills",
  unknown_job_type: "higgsfield.errUnknownJobType",
  invalid_params: "higgsfield.errInvalidParams",
};

/** a translated sentence for an error, plus the server's own detail (already redacted) when there is one */
export function hfErrorText(e: unknown): { text: string; detail: string | null } {
  const raw = String((e as Error)?.message ?? e ?? "");
  const code = higgsfieldErrorCode(raw);
  if (code && ERRORS[code]) {
    const detail = raw.slice(code.length).replace(/^:\s*/, "").trim();
    return { text: tr(ERRORS[code]), detail: detail || null };
  }
  return { text: raw || tr("higgsfield.errApi"), detail: null };
}

/** credits as Higgsfield counts them (up to two decimals) */
export const fmtCredits = (n: number | null | undefined) =>
  n == null ? "—" : fmtNum(n, { maximumFractionDigits: 2 });
