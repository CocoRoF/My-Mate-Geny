import { useEffect, useRef } from "react";

/** a row that scrolls sideways (steps, tabs): the current child stays in view */
export function useCenteredChild<T extends HTMLElement>(index: number) {
  const row = useRef<T>(null);
  useEffect(() => {
    const box = row.current;
    const child = box?.children[index];
    if (!box || !child || box.scrollWidth <= box.clientWidth) return;
    const b = box.getBoundingClientRect();
    const c = child.getBoundingClientRect();
    box.scrollLeft += c.left - b.left - (b.width - c.width) / 2;
  }, [index]);
  return row;
}
