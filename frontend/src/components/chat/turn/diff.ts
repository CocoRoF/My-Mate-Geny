export type DiffLine = { op: " " | "-" | "+"; text: string; a?: number; b?: number };

/** Line diff via LCS. Inputs past `limit` lines fall back to remove-all/add-all. */
export function lineDiff(oldText: string, newText: string, limit = 800): DiffLine[] {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText ? newText.split("\n") : [];
  if (a.length > limit || b.length > limit) {
    return [
      ...a.map((t, i) => ({ op: "-" as const, text: t, a: i + 1 })),
      ...b.map((t, i) => ({ op: "+" as const, text: t, b: i + 1 })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ op: " ", text: a[i], a: ++i, b: ++j });
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", text: a[i], a: ++i });
    else out.push({ op: "+", text: b[j], b: ++j });
  }
  while (i < n) out.push({ op: "-", text: a[i], a: ++i });
  while (j < m) out.push({ op: "+", text: b[j], b: ++j });
  return out;
}

export const diffStats = (lines: DiffLine[]) => ({
  added: lines.filter((l) => l.op === "+").length,
  removed: lines.filter((l) => l.op === "-").length,
});
