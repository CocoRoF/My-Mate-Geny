import type { ReactNode } from "react";

/** Light markdown for mate bubbles: **bold**, *italic*, `code`, [links](https://…) and bare URLs. No blocks. */
const TOKEN =
  /(\*\*(?=\S)([^*]+?)\*\*|__(?=\S)([^_]+?)__|\*(?=\S)([^*\n]+?)\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"]))/g;

export default function MiniMarkdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [, , bold, bold2, ital, code, label, href, bare] = m;
    if (bold || bold2) out.push(<strong key={k++} className="font-semibold">{bold || bold2}</strong>);
    else if (ital) out.push(<em key={k++}>{ital}</em>);
    else if (code) out.push(<code key={k++} className="rounded bg-black/25 px-1 py-px font-mono text-[0.9em]">{code}</code>);
    else if (href || bare)
      out.push(
        <a key={k++} href={href || bare} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2 break-all">
          {label || bare}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
