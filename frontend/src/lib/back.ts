import { useEffect, useRef } from "react";

// Android back button / Escape-like "go back" for whatever is open on top:
// the most recently opened overlay closes first.
const stack: Array<{ current: () => void }> = [];

export function useBackHandler(active: boolean, onBack: () => void) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!active) return;
    stack.push(ref);
    return () => {
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

/** Close the top overlay. False when nothing was open. */
export function runBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.current();
  return true;
}
