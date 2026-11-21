/**
 * A reply still streaming, cut where it is safe to (components/ui/Markdown.tsx LiveMarkdown): at blank lines outside
 * fenced code. Every chunk but the last is finished — rendered once and kept — so each new token re-parses only the
 * last chunk, never the whole reply (it did: the cost grew with the square of the reply's length). A finished reply is
 * rendered whole, as one document.
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function stableChunks(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let start = 0;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]);
    if (m) {
      const mark = m[1];
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length && lines[i].trim() === mark) fence = null;
      continue;
    }
    // a blank line outside code ends a chunk (an indented code block or a list item's own paragraph may continue
    // after it: then the next line is indented, and the chunk goes on)
    if (fence === null && lines[i].trim() === "" && i > start && i + 1 < lines.length && !/^\s/.test(lines[i + 1])) {
      out.push(lines.slice(start, i).join("\n"));
      start = i + 1;
    }
  }
  out.push(lines.slice(start).join("\n"));
  return out.filter((c, k) => c.trim() !== "" || k === out.length - 1);
}
