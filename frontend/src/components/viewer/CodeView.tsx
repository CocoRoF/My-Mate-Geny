import { useEffect, useMemo, useRef } from "react";
import { highlightLines } from "./highlight";

const BLOCK = 400; // lines per block; off-screen blocks skip layout (content-visibility)
const LINE_H = 20;

/** Read-only editor: line numbers, highlighting, wrap, jump to a line (range). */
export default function CodeView({
  code,
  lang,
  wrap,
  line,
  endLine,
  nonce,
}: {
  code: string;
  lang: string;
  wrap: boolean;
  line?: number;
  endLine?: number;
  nonce?: number;
}) {
  const lines = useMemo(() => highlightLines(code.replace(/\n$/, ""), lang), [code, lang]);
  const ref = useRef<HTMLDivElement>(null);
  const gutter = String(lines.length).length;

  useEffect(() => {
    if (!line || !ref.current) return;
    const el = ref.current.querySelector<HTMLElement>(`[data-ln="${line}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [line, nonce, lines]);

  const blocks: string[][] = [];
  for (let i = 0; i < lines.length; i += BLOCK) blocks.push(lines.slice(i, i + BLOCK));
  const hit = (n: number) => !!line && n >= line && n <= (endLine || line);

  return (
    <div ref={ref} className="hljs-view min-w-0 py-2 font-mono text-[12.5px]" style={{ lineHeight: `${LINE_H}px` }}>
      {blocks.map((block, b) => (
        <div
          key={b}
          style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${block.length * LINE_H}px` } as React.CSSProperties}
        >
          {block.map((html, i) => {
            const n = b * BLOCK + i + 1;
            return (
              <div key={n} data-ln={n} className={`flex ${hit(n) ? "bg-warning/10" : ""}`}>
                <span
                  className={`sticky left-0 shrink-0 select-none bg-bg pl-3 pr-4 text-right ${
                    hit(n) ? "text-warning" : "text-content-faint/70 light:text-content-faint"
                  }`}
                  style={{ width: `${gutter + 3}ch` }}
                >
                  {n}
                </span>
                <span
                  className={`flex-1 pr-6 text-content/90 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}
                  dangerouslySetInnerHTML={{ __html: html || " " }}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
