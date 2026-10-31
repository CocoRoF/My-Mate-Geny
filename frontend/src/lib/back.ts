import { useEffect, useRef } from "react";
import { isTouchFirst } from "./device";

// Android back button / Escape-like "go back" for whatever is open on top:
// the most recently opened overlay closes first.
const stack: Array<{ current: () => void }> = [];

export function useBackHandler(active: boolean, onBack: () => void) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!active) return;
    stack.push(ref);
    syncHistory();
    return () => {
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
      syncHistory();
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

// Phone/tablet browsers (no app shell to deliver the back button): mirror each
// open overlay with a history entry, so the browser's back button / swipe closes
// the drawer or sheet instead of leaving the console. The app shells (Android:
// native back button; desktop: none) and mouse-driven browsers are left alone.
let mirrored = 0; // history entries pushed for open overlays
let ownPops = 0; // our own history.go(-n) traversals still to arrive
let scheduled = false;
let listening = false;

const mirrorsHistory = () =>
  typeof window !== "undefined" && !window.hrhNative && !(window as any).Capacitor?.isNativePlatform?.() && isTouchFirst();

function onPopState() {
  if (ownPops) {
    ownPops -= 1;
    syncHistory();
    return;
  }
  if (mirrored > 0) {
    mirrored -= 1; // the browser already stepped back over our entry
    runBack(); // the overlay's cleanup re-syncs
  }
}

function sync() {
  scheduled = false;
  if (ownPops) return; // a traversal is in flight; its popstate re-syncs
  if (stack.length > mirrored) {
    for (; mirrored < stack.length; mirrored++) window.history.pushState({ hrhOverlay: true }, "");
  } else if (stack.length < mirrored) {
    // Closed from the UI (✕, backdrop): drop the entries it no longer needs.
    const n = mirrored - stack.length;
    mirrored = stack.length;
    ownPops += 1;
    window.history.go(-n);
  }
}

function syncHistory() {
  if (scheduled || !mirrorsHistory()) return;
  if (!listening) {
    window.addEventListener("popstate", onPopState);
    listening = true;
  }
  scheduled = true;
  setTimeout(sync, 0); // after the render settles: a swap (close one, open one) is a no-op
}
