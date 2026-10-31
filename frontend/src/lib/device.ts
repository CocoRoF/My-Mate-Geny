import { useSyncExternalStore } from "react";

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

/** Phone-width viewport (below Tailwind's `sm`). */
export function usePhone(): boolean {
  return useMedia(PHONE_QUERY, () => matches(PHONE_QUERY));
}
