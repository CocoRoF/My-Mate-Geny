/**
 * Paths in agent text → things you can click.
 *
 * The agent prints paths as `inline code`, markdown links or bare absolute
 * paths, often with a line suffix (`src/app.ts:42`, `a.py#L10-20`). These
 * helpers decide what looks like a path and resolve it against the session's
 * workspace (or a markdown file's own folder). Whether it exists is checked
 * only on click (one stat), so rendering stays free.
 */

export interface PathRef {
  path: string; // as written, without the line suffix
  line?: number;
  endLine?: number;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// Things that are code, not paths.
const NOT_PATH = /[\s*?<>(){}[\]=,;|'"`$^!\\]|^@|^-|\.\.\.$|^\/\/|::/;
const FILE_EXT = /^[\w\-.ㄱ-힝]+\.[A-Za-z][A-Za-z0-9]{0,7}$/;
// Dotted names that are code far more often than files.
const CODE_LIKE = /^(console|window|document|process|self|this|os|sys|np|pd|math|json|re|path|fs|React|Object|Array|Promise|Math|JSON|String|Number|app|req|res|e|err|ctx|props|state|settings|config|module|exports)\.[a-z]/;

/** Split `file.ts:12`, `file.ts:12:5`, `file.ts:12-20`, `file.ts#L12-L20`. */
export function parsePathRef(raw: string): PathRef {
  let s = raw.trim().replace(/^file:\/\//, "");
  try {
    if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s);
  } catch {
    /* keep as is */
  }
  let m = /#L(\d+)(?:-L?(\d+))?$/.exec(s);
  if (m) return { path: s.slice(0, m.index), line: +m[1], endLine: m[2] ? +m[2] : undefined };
  m = /:(\d+)(?::\d+)?(?:-(\d+))?$/.exec(s);
  if (m) return { path: s.slice(0, m.index), line: +m[1], endLine: m[2] ? +m[2] : undefined };
  return { path: s.replace(/[.,:;]+$/, "") };
}

/** Does this `inline code` / link target read as a file or folder path? */
export function looksLikePath(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 2 || s.length > 400) return false;
  if (s.startsWith("file://")) return true;
  if (SCHEME.test(s) || NOT_PATH.test(s)) return false;
  const { path } = parsePathRef(s);
  if (!path || /^[./~]+$/.test(path)) return false;
  if (path.startsWith("/") || path.startsWith("~/") || path.startsWith("./") || path.startsWith("../")) return true;
  if (path.includes("/")) {
    // `a/b` — a path when segments look like names, not `and/or` prose or `1/2`
    const segs = path.split("/").filter(Boolean);
    if (segs.length < 2 && !path.endsWith("/")) return false;
    if (segs.every((x) => /^\d+$/.test(x))) return false;
    return segs.every((x) => /^[\w\-.@+ㄱ-힝]+$/.test(x));
  }
  return FILE_EXT.test(path) && !CODE_LIKE.test(path) && !/^\d+(\.\d+)+$/.test(path) && !/^v\d/.test(path);
}

/** Normalise `a/./b/../c` (POSIX). */
export function normalize(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}

/** Absolute path for a reference: absolute and `~` stay (the server expands `~`),
 * relative ones resolve against `base` (the workspace, or a markdown file's folder). */
export function resolvePath(p: string, base: string): string {
  if (p.startsWith("/")) return normalize(p);
  if (p === "~" || p.startsWith("~/")) return p.replace(/\/+$/, "") || "~";
  return normalize(`${base.replace(/\/+$/, "")}/${p}`);
}

/** Workspace-relative display path (VS Code style); outside the roots stays absolute. */
export function displayPath(p: string, roots: string[]): string {
  for (const r of roots) {
    const root = r.replace(/\/+$/, "");
    if (p === root) return root.split("/").pop() || root;
    if (p.startsWith(root + "/")) return p.slice(root.length + 1);
  }
  return p;
}

/** Bare absolute paths in prose (`/home/x/y`, `~/proj`) — ASCII only; Korean
 * names need backticks so "~/tb-build에서" doesn't swallow the particle. */
export const BARE_PATH = /(^|[\s(（「'"“])((?:~|\/)(?:[\w.\-+@%]+\/)*[\w.\-+@%]+\/?)(?=$|[\s)）」'"”,.:;!?]|[ㄱ-힝])/g;

export function isBarePathCandidate(p: string): boolean {
  // at least two segments (`/home/x`, `~/x`) so "/" or "/s" in prose stay text
  const segs = p.replace(/^~/, "").split("/").filter(Boolean);
  return p.startsWith("~/") ? segs.length >= 1 : segs.length >= 2;
}
