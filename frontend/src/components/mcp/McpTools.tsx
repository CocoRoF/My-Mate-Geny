import { useEffect, useRef, useState } from "react";
import { getMcpTools, type McpToolSummary } from "../../api/mcp";
import { useT } from "../../i18n";

/** Descriptions are fetched only when opened, fifty at a time. */
export default function McpTools({
  id,
  count,
  revision,
}: {
  id: string;
  count: number;
  revision: string;
}) {
  const t = useT(),
    [open, setOpen] = useState(false),
    [items, setItems] = useState<McpToolSummary[]>([]);
  const [more, setMore] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    let active = true;
    setItems([]);
    setError("");
    setMore(false);
    if (open) {
      setBusy(true);
      getMcpTools(id)
        .then((result) => {
          if (active) {
            setItems(result.items);
            setMore(result.has_more);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }
    return () => {
      active = false;
      generation.current++;
    };
  }, [id, revision, open]);
  const next = async () => {
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await getMcpTools(id, items.length);
      if (generation.current === current) {
        setItems((old) => [...old, ...result.items]);
        setMore(result.has_more);
      }
    } catch (e) {
      if (generation.current === current) setError((e as Error).message);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };
  return (
    <details
      className="mt-3 text-xs text-content-dim"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer">
        {t("mcp.toolsCount", { count })}
      </summary>
      {open && (
        <div
          className="mt-2 max-h-64 space-y-2 overflow-y-auto"
          data-testid={`mcp-tools-${id}`}
        >
          {items.map((tool) => (
            <div key={tool.name} className="rounded-lg bg-surface-2 p-2">
              <div className="font-mono font-medium">{tool.name}</div>
              <p className="mt-1 whitespace-pre-wrap break-words text-content-faint">
                {tool.description}
              </p>
            </div>
          ))}
          {error && (
            <p className="text-danger" role="alert">
              {error}
            </p>
          )}
          {busy && (
            <p role="status" className="py-1 text-content-faint">
              {t("mcp.loadingTools")}
            </p>
          )}
          {more && (
            <button
              className="btn-ghost w-full !py-1"
              disabled={busy}
              onClick={() => void next()}
            >
              {t("mcp.moreTools")}
            </button>
          )}
        </div>
      )}
    </details>
  );
}
