import { useMemo } from "react";
import Markdown from "../ui/Markdown";
import CodeView from "./CodeView";

type Src = string | string[] | undefined;
const src = (s: Src) => (Array.isArray(s) ? s.join("") : s || "");
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

interface Output {
  output_type: string;
  text?: Src;
  name?: string;
  data?: Record<string, Src>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

function OutputView({ o }: { o: Output }) {
  if (o.output_type === "stream")
    return (
      <pre className={`whitespace-pre-wrap break-words text-[12px] ${o.name === "stderr" ? "text-danger/90" : "text-content/85"}`}>
        {stripAnsi(src(o.text))}
      </pre>
    );
  if (o.output_type === "error")
    return <pre className="whitespace-pre-wrap break-words text-[12px] text-danger/90">{stripAnsi((o.traceback || [`${o.ename}: ${o.evalue}`]).join("\n"))}</pre>;
  const d = o.data || {};
  for (const t of ["image/png", "image/jpeg", "image/gif"])
    if (d[t]) return <img src={`data:${t};base64,${src(d[t]).replace(/\s/g, "")}`} alt="" className="max-w-full rounded bg-white" />;
  if (d["image/svg+xml"])
    return <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(src(d["image/svg+xml"]))}`} alt="" className="max-w-full rounded bg-white" />;
  if (d["text/html"])
    // pandas tables etc.: a script-less sandbox (same-origin only so it can be
    // measured — without allow-scripts nothing in it runs), sized by its content
    return (
      <iframe
        sandbox="allow-same-origin"
        srcDoc={`<style>body{margin:0;font:12px system-ui;color:#111;background:#fff}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:3px 6px}</style>${src(d["text/html"])}`}
        className="w-full rounded bg-white"
        style={{ height: 240 }}
        onLoad={(e) => {
          const f = e.currentTarget;
          const h = f.contentDocument?.body?.scrollHeight;
          if (h) f.style.height = `${Math.min(h + 8, 600)}px`;
        }}
      />
    );
  if (d["text/markdown"]) return <Markdown>{src(d["text/markdown"])}</Markdown>;
  if (d["text/plain"]) return <pre className="whitespace-pre-wrap break-words text-[12px] text-content/85">{stripAnsi(src(d["text/plain"]))}</pre>;
  return null;
}

/** .ipynb — markdown cells rendered, code cells highlighted, outputs (text, images, tables). */
export default function NotebookView({ text, baseDir }: { text: string; baseDir: string }) {
  const nb = useMemo(() => {
    try {
      return { ok: true as const, v: JSON.parse(text) };
    } catch (e: any) {
      return { ok: false as const, err: String(e.message || e) };
    }
  }, [text]);
  if (!nb.ok) return <p className="p-6 text-sm text-danger">Not a valid notebook: {nb.err}</p>;
  const lang = nb.v.metadata?.kernelspec?.language || nb.v.metadata?.language_info?.name || "python";
  const cells: any[] = nb.v.cells || nb.v.worksheets?.[0]?.cells || [];

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl space-y-3 px-4 py-5">
        {cells.map((c, i) =>
          c.cell_type === "markdown" ? (
            <div key={i} className="px-2">
              <Markdown baseDir={baseDir} doc>
                {src(c.source)}
              </Markdown>
            </div>
          ) : c.cell_type === "code" ? (
            <div key={i} className="flex gap-2">
              <span className="w-12 shrink-0 pt-2 text-right font-mono text-[11px] text-content-faint">
                [{c.execution_count ?? " "}]
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="overflow-x-auto rounded-lg border border-border bg-bg">
                  <CodeView code={src(c.source)} lang={lang} wrap={false} />
                </div>
                {(c.outputs || []).map((o: Output, j: number) => (
                  <div key={j} className="overflow-x-auto px-1">
                    <OutputView o={o} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <pre key={i} className="whitespace-pre-wrap px-2 text-[12px] text-content-faint">
              {src(c.source)}
            </pre>
          ),
        )}
      </div>
    </div>
  );
}
