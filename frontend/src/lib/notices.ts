import { tr, useI18n } from "../i18n";

/** A notice in the UI's language when its code is known (otherwise the server's English message). */
export function noticeText(code: string | undefined, data: Record<string, any> | undefined, message: string): string {
  if (code === "screen.capture_failed") return tr("screen.messageWithoutScreen");
  // (backend SessionService._tools_failed_notice: the engine couldn't start these tool servers)
  if (code === "mcp.failed") return tr("chat.toolsFailed", { names: (Array.isArray(data?.servers) ? data!.servers : []).join(", ") });
  // (backend MateService._life_gave: she gave them something, in her day — the gift's name in both languages)
  if (code === "life.gave") {
    const gift = (data?.gift ?? {}) as { ko?: string; en?: string };
    const name = (useI18n.getState().lang === "ko" ? gift.ko || gift.en : gift.en || gift.ko) || String(data?.item ?? "");
    return tr("life.gaveNotice", { name: String(data?.name ?? ""), gift: name });
  }
  return message;
}
