// Her memories gathered by what they are about (docs/mate-memory-graph.md "One record per thing"): one group per thing —
// the user first, then the two of them, then her, then the rest by the most recently changed; the ones not put in
// order yet last. Pure, for the 기억 tab (components/mate/MemoryNotebook.tsx).
import type { GraphKind, Memory } from "../api/mates";

const ORDER: Partial<Record<GraphKind, number>> = { user: 0, us: 1, self: 2 };

export interface MemoryGroup {
  key: string;
  entity: Memory["entity"];
  items: Memory[];
  at: string;
}

export function groupByEntity(items: Memory[]): MemoryGroup[] {
  const by = new Map<string, MemoryGroup>();
  for (const m of items) {
    const key = m.entity?.id ?? "";
    const g = by.get(key) ?? { key, entity: m.entity ?? null, items: [], at: "" };
    g.items.push(m);
    if (m.updated_at > g.at) g.at = m.updated_at;
    by.set(key, g);
  }
  const rank = (g: MemoryGroup) => (g.entity ? (ORDER[g.entity.kind] ?? 3) : 9);
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
