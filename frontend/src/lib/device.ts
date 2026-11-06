import { useCallback, useRef, useState, useSyncExternalStore } from "react";

// Touch-first: the primary input is a finger and there's no hover (phones,
// tablets without a mouse/trackpad), or the Android app. There the on-screen
// keyboard's Enter key adds a line; messages go with the send button.
// Width alone can't tell: a small desktop window is not a phone, a tablet is.
const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";
const PHONE_QUERY = "(max-width: 639px)"; // Tailwind's `sm` breakpoint

const isNativeApp = () => document.documentElement.classList.contains("native-android");

function matches(query: string): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
}

export function isTouchFirst(): boolean {
  return typeof document !== "undefined" && (isNativeApp() || matches(TOUCH_QUERY));
}

function useMedia(query: string, read: () => boolean): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia?.(query);
      mq?.addEventListener?.("change", cb);
      return () => mq?.removeEventListener?.("change", cb);
    },
    read,
    () => false,
  );
}

/** Live `isTouchFirst()`: follows a mouse being attached/detached. */
export function useTouchFirst(): boolean {
  return useMedia(TOUCH_QUERY, isTouchFirst);
}

const SHORT_QUERY = "(max-height: 500px)"; // a phone on its side

/** Too short for chrome around a panel: a phone on its side. */
export function useShortScreen(): boolean {
  return useMedia(SHORT_QUERY, () => matches(SHORT_QUERY));
}

/** An element narrower than `px`, whatever the viewport (the main area beside the sidebar). → [narrow, its ref] */
export function useNarrowerThan(px: number): [boolean, (el: HTMLElement | null) => void] {
  const [narrow, setNarrow] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect();
      if (!el) return;
      const measure = () => setNarrow(el.clientWidth < px);
      measure();
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    },
    [px],
  );
  return [narrow, ref];
}

/** Phone-width viewport (below Tailwind's `sm`). */
export function usePhone(): boolean {
  return useMedia(PHONE_QUERY, () => matches(PHONE_QUERY));
}
