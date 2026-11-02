import { useMemo, useState } from "react";
import { diffStats, lineDiff, type DiffLine } from "./diff";
import { useT } from "../../../i18n";

const CONTEXT = 3;

type Row = DiffLine | { op: "gap"; count: number; from: number };

function withGaps(lines: DiffLine[]): Row[] {
  const keep = lines.map((l) => l.op !== " ");
  lines.forEach((l, i) => {
    if (l.op === " ") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  const out: Row[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) {
      out.push(lines[i++]);
      continue;
    }
    const from = i;
    while (i < lines.length && !keep[i]) i++;
    out.push({ op: "gap", count: i - from, from });
  }
  return out;
}

/** Unified diff of one edit (old → new), with collapsed unchanged runs. */
export default function DiffView({
  path,
  oldText,
  newText,
  maxRows = 400,
}: {
  path?: string;
  oldText: string;
  newText: string;
  maxRows?: number;
}) {
  const t = useT();
  const lines = useMemo(() => lineDiff(oldText, newText), [oldText, newText]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [all, setAll] = useState(false);
  const { added, removed } = diffStats(lines);
  const rows = useMemo(() => withGaps(lines), [lines]);
  const shown = all ? rows : rows.slice(0, maxRows);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg/70">
      {path && (
        <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-1.5 text-[11px]">
          <span className="truncate font-mono text-content-dim">{path}</span>
          <span className="ml-auto shrink-0 font-mono">
            <span className="text-success">+{added}</span> <span className="text-danger">-{removed}</span>
          </span>
        </div>
      )}
      <div className="max-h-96 overflow-auto font-mono text-[11.5px] leading-[1.55]">
        {shown.map((r, idx) =>
          r.op === "gap" ? (
            expanded.has(r.from) ? (
              lines.slice(r.from, r.from + r.count).map((l, k) => <Line key={`${idx}-${k}`} l={l} />)
            ) : (
              <button
                key={idx}
                onClick={() => setExpanded(new Set(expanded).add(r.from))}
                className="block w-full bg-surface-2/60 px-3 py-0.5 text-left text-[10.5px] text-content-faint hover:text-content-dim"
              >
                ⋯ {t("turn.unchangedLines", { count: r.count })}
              </button>
            )
          ) : (
            <Line key={idx} l={r} />
          ),
        )}
        {!all && rows.length > maxRows && (
          <button onClick={() => setAll(true)} className="block w-full px-3 py-1 text-left text-[11px] text-accent hover:underline">
            {t("turn.showMoreLines", { count: rows.length - maxRows })}
          </button>
        )}
      </div>
    </div>
  );
}

function Line({ l }: { l: DiffLine }) {
  const cls =
    l.op === "+" ? "bg-success/10 text-success/95 light:text-success" : l.op === "-" ? "bg-danger/10 text-danger/90 light:text-danger" : "text-content-dim";
  return (
    <div className={`flex whitespace-pre ${cls}`}>
      <span className="w-10 shrink-0 select-none pr-2 text-right text-content-faint/60 light:text-content-faint">{l.op === "+" ? l.b : l.a}</span>
      <span className="w-4 shrink-0 select-none text-center opacity-70">{l.op === " " ? "" : l.op}</span>
      <span className="pr-3">{l.text || " "}</span>
    </div>
  );
}
