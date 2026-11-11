import { tr } from "../i18n";

/** A notice in the UI's language when its code is known (otherwise the server's English message). */
export function noticeText(code: string | undefined, data: Record<string, any> | undefined, message: string): string {
  if (code === "screen.capture_failed") return tr("screen.messageWithoutScreen");
  // (backend SessionService._tools_failed_notice: the engine couldn't start these tool servers)
  if (code === "mcp.failed") return tr("chat.toolsFailed", { names: (Array.isArray(data?.servers) ? data!.servers : []).join(", ") });
  return message;
}
