import type { IconName } from "../ui/Icon";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toUpperCase().slice(0, 5) : "";
}

const CODE = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|c|h|cpp|cs|rb|php|sh|sql|json|ya?ml|toml|xml|html|css|md)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;
const SHEET = /\.(csv|tsv|xlsx?|ods|numbers)$/i;

/** Icon + accent color for a file chip/card. */
export function fileVisual(name: string, mime: string): { icon: IconName; tone: string } {
  if (mime.startsWith("image/")) return { icon: "image", tone: "text-violet bg-violet/12" };
  if (mime === "application/pdf") return { icon: "file-text", tone: "text-danger bg-danger/12" };
  if (mime.startsWith("audio/")) return { icon: "file-audio", tone: "text-cyan bg-cyan/12" };
  if (mime.startsWith("video/")) return { icon: "file-video", tone: "text-cyan bg-cyan/12" };
  if (SHEET.test(name)) return { icon: "file-sheet", tone: "text-success bg-success/12" };
  if (ARCHIVE.test(name)) return { icon: "file-archive", tone: "text-warning bg-warning/12" };
  if (CODE.test(name)) return { icon: "file-code", tone: "text-accent bg-accent/12" };
  if (mime.startsWith("text/")) return { icon: "file-text", tone: "text-content-dim bg-surface-3" };
  return { icon: "file", tone: "text-content-dim bg-surface-3" };
}

/** Types the browser can show in a tab (served inline by the backend). */
export const opensInline = (mime: string) =>
  mime === "application/pdf" || mime === "text/plain" || mime.startsWith("audio/") || mime.startsWith("video/");
