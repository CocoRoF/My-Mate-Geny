export interface PatchLine {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  a?: number;
  b?: number;
}

export interface PatchFile {
  path: string;
  oldPath?: string;
  binary: boolean;
  lines: PatchLine[];
}

/** Parse `git diff` output into files with numbered lines. */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let cur: PatchFile | null = null;
  let a = 0;
  let b = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      cur = { path: m ? m[2] : raw.slice(11), oldPath: m && m[1] !== m[2] ? m[1] : undefined, binary: false, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("Binary files")) {
      cur.binary = true;
      continue;
    }
    if (/^(index |new file|deleted file|similarity|rename |old mode|new mode|--- |\+\+\+ )/.test(raw)) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      a = Number(h[1]);
      b = Number(h[2]);
      cur.lines.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) cur.lines.push({ kind: "add", text: raw.slice(1), b: b++ });
    else if (raw.startsWith("-")) cur.lines.push({ kind: "del", text: raw.slice(1), a: a++ });
    else if (raw.startsWith("\\")) cur.lines.push({ kind: "meta", text: raw });
    else if (raw.length || cur.lines.length) cur.lines.push({ kind: "ctx", text: raw.slice(1), a: a++, b: b++ });
  }
  for (const f of files) while (f.lines.length && f.lines[f.lines.length - 1].kind === "ctx" && !f.lines[f.lines.length - 1].text) f.lines.pop();
  return files;
}
