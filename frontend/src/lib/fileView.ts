/**
 * File viewer rules — pure, no React. Every screen that shows a file (viewer
 * tabs, explorer icons, chat path links) decides "how to draw it" here, so the
 * same file never renders differently in two places. Ported from xgen-dex
 * (`packages/protocol/src/file-view.ts`), extended for the formats the
 * browser renders itself here (no server-side office renderer):
 *
 *   code     → read-only editor (line numbers + highlighting)
 *   markdown → rendered (source toggle)
 *   csv      → sortable table (source toggle)
 *   sheet    → xlsx/xls/ods via SheetJS, sheet tabs
 *   docx     → docx-preview (pages)
 *   pptx     → slide outline (text + images)
 *   pdf      → pdf.js pages (works in the Android WebView too)
 *   html / notebook → rendered in a sandbox / cells (source toggle)
 *   image / audio / video → native (Blob URL); svg gets a source toggle
 *   binary   → info panel (download); unknown extensions are promoted to
 *              code when the content sniffs as text
 */
import { fmtDate, fmtTime } from "../i18n/format";

export type ViewerKind =
  | "code"
  | "markdown"
  | "csv"
  | "sheet"
  | "docx"
  | "pptx"
  | "pdf"
  | "html"
  | "notebook"
  | "image"
  | "audio"
  | "video"
  | "binary";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv", "m4v", "ogv"]);
const SHEET_EXT = new Set(["xlsx", "xlsm", "xlsb", "xls", "ods", "fods"]);
/** Formats there is no browser renderer for: download only, with a reason. */
export const LEGACY_OFFICE = new Set(["doc", "ppt", "hwp", "hwpx", "odt", "odp", "key", "pages", "numbers"]);

/** highlight.js language ids — also the list of extensions that open as text. */
const LANG_BY_EXT: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", pyi: "python", rb: "ruby", php: "php", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", m: "objectivec", mm: "objectivec",
  cs: "csharp", go: "go", rs: "rust", swift: "swift", scala: "scala",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell", bat: "dos", cmd: "dos",
  sql: "sql", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", svelte: "xml", xaml: "xml", plist: "xml",
  css: "css", scss: "scss", sass: "scss", less: "less",
  json: "json", jsonc: "json", json5: "json", jsonl: "json", ndjson: "json", ipynb: "json", geojson: "json",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini",
  conf: "ini", env: "ini", properties: "ini", editorconfig: "ini",
  dockerfile: "dockerfile", makefile: "makefile", mk: "makefile", cmake: "cmake",
  gradle: "groovy", groovy: "groovy", lua: "lua", r: "r", pl: "perl", dart: "dart",
  gd: "gdscript", tres: "ini", tscn: "ini", godot: "ini",
  diff: "diff", patch: "diff", graphql: "graphql", gql: "graphql", proto: "protobuf",
  md: "markdown", markdown: "markdown", mdx: "markdown", rst: "plaintext", tex: "latex",
  txt: "plaintext", text: "plaintext", log: "plaintext", out: "plaintext",
  gitignore: "plaintext", gitattributes: "plaintext", dockerignore: "plaintext", npmrc: "ini",
  lock: "plaintext", csv: "plaintext", tsv: "plaintext", srt: "plaintext", vtt: "plaintext",
};

/** Lower-case extension; a whole-name dotfile gives what follows the dot (".gitignore" → "gitignore"). */
export function extOf(name: string): string {
  const base = (name.split("/").pop() ?? name).toLowerCase();
  const i = base.lastIndexOf(".");
  if (i <= 0) return base === "makefile" || base === "dockerfile" ? base : base.startsWith(".") ? base.slice(1) : "";
  return base.slice(i + 1);
}

export const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
export const dirName = (p: string) => {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i <= 0 ? "/" : s.slice(0, i);
};

/** File name → viewer kind, before the content is seen. */
export function kindForFile(name: string): ViewerKind {
  const ext = extOf(name);
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (SHEET_EXT.has(ext)) return "sheet";
  if (ext === "docx" || ext === "docm" || ext === "dotx") return "docx";
  if (ext === "pptx" || ext === "pptm" || ext === "potx") return "pptx";
  if (ext === "pdf") return "pdf";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "ipynb") return "notebook";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  if (ext in LANG_BY_EXT) return "code";
  return "binary"; // unknown — promoted to code if the bytes sniff as text
}

/** Kinds read as text (through /api/fs/text); the rest load raw bytes. */
export const TEXT_KINDS = new Set<ViewerKind>(["code", "markdown", "csv", "html", "notebook", "binary"]);

/** Kinds with a [Rendered | Source] toggle. */
export function hasSourceToggle(name: string): boolean {
  const k = kindForFile(name);
  return k === "markdown" || k === "csv" || k === "html" || k === "notebook" || extOf(name) === "svg";
}

export function langForFile(name: string): string {
  return LANG_BY_EXT[extOf(name)] ?? "plaintext";
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  avif: "image/avif", pdf: "application/pdf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac", opus: "audio/ogg",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", m4v: "video/mp4", ogv: "video/ogg",
};
/** MIME from the extension — the server may say octet-stream for media it doesn't know. */
export const mimeForFile = (name: string) => MIME[extOf(name)] ?? "application/octet-stream";

/** Render the whole text up to here; past it, the head plus a note. */
export const TEXT_RENDER_LIMIT = 2 * 1024 * 1024;
/** Highlight up to here; past it, plain text (the highlighter takes seconds). */
export const HIGHLIGHT_LIMIT = 512 * 1024;
/** Table rows drawn at once (csv / sheets); "show more" adds this many. */
export const TABLE_PAGE = 2000;

/** Table column sort: none → asc → desc → none on the same header. */
export type TableSort = { col: number; dir: "asc" | "desc" } | null;

export function nextTableSort(current: TableSort, col: number): TableSort {
  if (!current || current.col !== col) return { col, dir: "asc" };
  return current.dir === "asc" ? { col, dir: "desc" } : null;
}

const NUMERIC_CELL = /^[+-]?(\d{1,3}(,\d{3})+|\d+\.?\d*|\.\d+)(\.\d+)?(e[+-]?\d+)?%?$/i;
const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });
const num = (s: string) => Number(s.replace(/[,%]/g, ""));

/**
 * The ORIGINAL indexes of the rows in sorted order — rows never move, so the
 * view keeps showing original row numbers.
 *  - numeric when every non-empty cell is a number, else natural text order (Korean too)
 *  - empty cells always last, whatever the direction
 *  - stable for equal values
 */
export function sortedRowOrder(rows: readonly (readonly unknown[])[], sort: TableSort): number[] {
  const order = rows.map((_, i) => i);
  if (!sort) return order;
  const { col, dir } = sort;
  const cell = (i: number) => String(rows[i]?.[col] ?? "").trim();
  const filled = order.filter((i) => cell(i) !== "");
  const empty = order.filter((i) => cell(i) === "");
  const numeric = filled.length > 0 && filled.every((i) => NUMERIC_CELL.test(cell(i)));
  const sign = dir === "asc" ? 1 : -1;
  filled.sort((a, b) => {
    const d = numeric ? num(cell(a)) - num(cell(b)) : collator.compare(cell(a), cell(b));
    return d !== 0 ? sign * d : a - b;
  });
  return [...filled, ...empty];
}

/** CSV/TSV — RFC 4180 quoting (doubled quotes, newlines inside quotes). */
export function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.length > 1 || row[0] !== "") rows.push(row); // drop fully blank lines
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) pushField();
    else if (ch === "\n") {
      if (field.endsWith("\r")) field = field.slice(0, -1);
      pushRow();
    } else field += ch;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

/** Delimiter: tab for .tsv, else whichever of , ; \t | splits the first lines most consistently. */
export function sniffDelimiter(name: string, text: string): string {
  if (extOf(name) === "tsv") return "\t";
  const lines = text.split("\n", 6).filter(Boolean).slice(0, 5);
  if (!lines.length) return ",";
  let best = ",";
  let bestScore = 0;
  for (const d of [",", "\t", ";", "|"]) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts);
    // consistent column counts beat a higher but ragged count
    const score = min > 0 && counts.every((c) => c === counts[0]) ? min * 2 : min;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Spreadsheet column label: 0 → A, 26 → AA. */
export function colLabel(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

export function formatTime(epochSec: number | null | undefined): string {
  if (!epochSec) return "";
  const d = new Date(epochSec * 1000);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same
    ? fmtTime(d)
    : fmtDate(d, { year: d.getFullYear() === now.getFullYear() ? undefined : "numeric", month: "short", day: "numeric" });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Split highlighted HTML into lines — close spans open at a line break and
 * reopen them on the next line, so "one line = one row" for line numbers.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = [];
  let cur = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      const end = html.indexOf(">", i);
      if (end === -1) {
        cur += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith("</")) stack.pop();
      else if (!tag.endsWith("/>")) stack.push(tag);
      cur += tag;
      i = end + 1;
      continue;
    }
    if (ch === "\n") {
      lines.push(cur + "</span>".repeat(stack.length));
      cur = stack.join("");
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  lines.push(cur + "</span>".repeat(stack.length));
  return lines;
}
