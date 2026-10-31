import { useEffect, useState } from "react";
import { read, utils, type WorkBook } from "xlsx";
import DataTable from "./DataTable";

const MAX_ROWS = 50000; // parse cap per sheet

interface Sheet {
  name: string;
  hidden: boolean;
  rows: string[][];
  range: string;
}

/** xlsx / xls / xlsm / xlsb / ods — SheetJS, formatted cell text, Excel-style sheet tabs. */
export default function SheetView({ data, wrap }: { data: ArrayBuffer; wrap: boolean }) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    try {
      const wb: WorkBook = read(data, { type: "array", cellDates: true, sheetRows: MAX_ROWS + 1, dense: true });
      const out = wb.SheetNames.map((name, i) => {
        const ws = wb.Sheets[name];
        const rows = utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", blankrows: true });
        return {
          name,
          hidden: !!wb.Workbook?.Sheets?.[i]?.Hidden,
          rows: rows.map((r) => r.map((c) => (c == null ? "" : String(c)))),
          range: (ws["!ref"] as string) || "",
        };
      });
      setSheets(out);
      setActive(Math.max(0, out.findIndex((s) => !s.hidden)));
    } catch (e: any) {
      setError(String(e.message || e));
    }
  }, [data]);

  if (error) return <p className="p-6 text-sm text-danger">Could not read this workbook: {error}</p>;
  if (!sheets) return <p className="p-6 text-sm text-content-faint">Reading workbook…</p>;
  const sheet = sheets[active];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {sheet && sheet.rows.length > 0 ? (
          <DataTable key={active} rows={sheet.rows} header={false} wrap={wrap} />
        ) : (
          <p className="p-6 text-sm text-content-faint">This sheet is empty.</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-t border-border bg-surface/60 px-2 py-1">
        {sheets.map((s, i) => (
          <button
            key={s.name}
            onClick={() => setActive(i)}
            className={`shrink-0 rounded-md px-3 py-1 text-[12px] transition ${
              i === active ? "bg-surface-3 text-content font-medium shadow-card" : "text-content-dim hover:bg-surface-2"
            } ${s.hidden ? "italic opacity-60" : ""}`}
            title={`${s.name}${s.range ? ` · ${s.range}` : ""}${s.hidden ? " · hidden" : ""}`}
          >
            {s.name}
          </button>
        ))}
        {sheet && sheet.rows.length > MAX_ROWS && (
          <span className="ml-auto shrink-0 px-2 text-[11px] text-warning">first {MAX_ROWS.toLocaleString()} rows</span>
        )}
      </div>
    </div>
  );
}
