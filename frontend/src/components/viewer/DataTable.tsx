import { useMemo, useState } from "react";
import { colLabel, nextTableSort, sortedRowOrder, TABLE_PAGE, type TableSort } from "../../lib/fileView";
import Icon from "../ui/Icon";

/**
 * Sortable, filterable grid for csv and sheets. Rows never move: sorting
 * yields an order of ORIGINAL indexes, so row numbers stay the file's.
 * `header` = first row names the columns (csv); otherwise A, B, C… (sheets).
 */
export default function DataTable({
  rows,
  header,
  wrap,
  rowBase = 1,
}: {
  rows: string[][];
  header: boolean;
  wrap: boolean;
  rowBase?: number; // number shown for the first data row
}) {
  const [sort, setSort] = useState<TableSort>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(TABLE_PAGE);
  const head = header ? rows[0] || [] : null;
  const body = useMemo(() => (header ? rows.slice(1) : rows), [rows, header]);
  const cols = useMemo(() => Math.max(head?.length || 0, ...body.slice(0, 5000).map((r) => r.length), 0), [head, body]);

  const order = useMemo(() => {
    let o = sortedRowOrder(body, sort);
    const q = query.trim().toLowerCase();
    if (q) o = o.filter((i) => body[i].some((c) => String(c).toLowerCase().includes(q)));
    return o;
  }, [body, sort, query]);
  const shown = order.slice(0, limit);

  const cell = `px-2.5 py-1 border-r border-b border-border/60 ${wrap ? "whitespace-pre-wrap break-words max-w-[32rem]" : "whitespace-nowrap max-w-[24rem] truncate"}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11.5px] text-content-faint">
        <span>
          {body.length.toLocaleString()} rows × {cols} columns
          {query && ` · ${order.length.toLocaleString()} match`}
        </span>
        {sort && (
          <button onClick={() => setSort(null)} className="pill bg-surface-3 text-content-dim hover:text-content">
            sorted by {head?.[sort.col] || colLabel(sort.col)} {sort.dir === "asc" ? "↑" : "↓"} <Icon name="x" size={10} />
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-0.5">
          <Icon name="search" size={11} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter rows"
            className="w-28 bg-transparent text-[11.5px] text-content placeholder:text-content-faint outline-none"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-separate border-spacing-0 text-[12px] text-content/90">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 border-b border-r border-border bg-surface-2 px-2 text-right font-mono text-[10.5px] font-normal text-content-faint">
                #
              </th>
              {Array.from({ length: cols }, (_, c) => {
                const label = head ? head[c] ?? "" : colLabel(c);
                return (
                  <th
                    key={c}
                    onClick={() => setSort(nextTableSort(sort, c))}
                    className={`cursor-pointer select-none border-b border-r border-border bg-surface-2 px-2.5 py-1.5 text-left font-semibold hover:bg-surface-3 ${
                      head ? "text-content max-w-[24rem] truncate" : "text-center font-mono text-[11px] font-normal text-content-faint"
                    }`}
                    title={head ? `${label} — click to sort` : "click to sort"}
                  >
                    {label}
                    {sort?.col === c && <span className="ml-1 text-accent">{sort.dir === "asc" ? "↑" : "↓"}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i} className="hover:bg-surface-2/60">
                <td className="sticky left-0 border-b border-r border-border/60 bg-bg px-2 text-right font-mono text-[10.5px] text-content-faint">
                  {i + rowBase}
                </td>
                {Array.from({ length: cols }, (_, c) => {
                  const v = body[i][c] ?? "";
                  return (
                    <td key={c} className={cell} title={!wrap && v.length > 40 ? v : undefined}>
                      {v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {order.length > shown.length && (
          <div className="flex items-center gap-3 px-3 py-3 text-[12px] text-content-faint">
            Showing {shown.length.toLocaleString()} of {order.length.toLocaleString()} rows
            <button onClick={() => setLimit((l) => l + TABLE_PAGE)} className="btn-soft py-1 px-2 text-[11.5px]">
              Show {Math.min(TABLE_PAGE, order.length - shown.length).toLocaleString()} more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
