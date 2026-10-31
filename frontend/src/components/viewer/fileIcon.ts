import { extOf, kindForFile, LEGACY_OFFICE } from "../../lib/fileView";
import type { IconName } from "../ui/Icon";

/** Explorer / tab icon + tint for a file, from the same rules as the viewer. */
export function fileIcon(name: string): { icon: IconName; tone: string } {
  const ext = extOf(name);
  switch (kindForFile(name)) {
    case "markdown":
      return { icon: "file-text", tone: "text-accent" };
    case "csv":
    case "sheet":
      return { icon: "file-sheet", tone: "text-success" };
    case "docx":
      return { icon: "file-text", tone: "text-[#5b9bff]" };
    case "pptx":
      return { icon: "file-slides", tone: "text-[#f0883e]" };
    case "pdf":
      return { icon: "file-text", tone: "text-danger" };
    case "notebook":
      return { icon: "notebook", tone: "text-warning" };
    case "image":
      return { icon: "file-image", tone: "text-violet" };
    case "audio":
      return { icon: "file-audio", tone: "text-cyan" };
    case "video":
      return { icon: "file-video", tone: "text-cyan" };
    case "html":
      return { icon: "file-code", tone: "text-[#f0883e]" };
    case "code":
      if (["json", "jsonc", "jsonl", "ndjson", "geojson"].includes(ext)) return { icon: "file-json", tone: "text-warning" };
      if (["txt", "log", "out", "text", "lock", "rst"].includes(ext)) return { icon: "file-text", tone: "text-content-dim" };
      return { icon: "file-code", tone: "text-cyan" };
    default:
      if (/^(zip|tar|gz|tgz|bz2|xz|7z|rar|jar|whl|apk|dmg)$/.test(ext)) return { icon: "file-archive", tone: "text-warning" };
      if (LEGACY_OFFICE.has(ext)) return { icon: "file-text", tone: "text-content-dim" };
      return { icon: "file", tone: "text-content-faint" };
  }
}
