import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatStoreApi } from "../stores/chatStore";

/** Fetch the previous page this far (px) before the reader reaches the top. */
const NEAR_TOP = 800;
/** a scroll this soon after the reader's touch / wheel / key is theirs (a fling runs on after the finger) */
const USER_SCROLL_MS = 1200;

/**
 * Scrolling of a transcript that loads upward (paged history, chatStore):
 * opens at the end, follows new output while the reader is at the bottom,
 * fetches older turns near the top (one request at a time) and keeps the view
 * still when they are prepended: the first visible item is measured right
 * before the store changes and put back at the same spot in a layout effect,
 * i.e. before the browser paints (whatever else changed below doesn't move it).
 * At the bottom it stays there when the list or the transcript changes size
 * (keyboard, composer, images).
 */
export function useHistoryScroll(store: ChatStoreApi, nearBottom = 120) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow new output only while the reader is at the bottom
  // The first visible item and where it sat before older turns went in.
  const anchor = useRef<{ node: HTMLElement | null; offset: number; height: number; top: number } | null>(null);
  const [showJump, setShowJump] = useState(false);
  const turns = store((s) => s.turns);
  const openSeq = store((s) => s.openSeq);
  const paging = store((s) => s.paging);

  const loadOlder = useCallback(() => {
    void store.getState().loadOlder(() => {
      const el = ref.current;
      if (!el) return;
      // offsetTop: layout position (a fading-in item's transform doesn't count)
      const items = Array.from(el.firstElementChild?.children || []) as HTMLElement[];
      const node = items.find((c) => c.offsetTop + c.offsetHeight > el.scrollTop) || null;
      anchor.current = {
        node,
        offset: node ? node.offsetTop - el.scrollTop : 0,
        height: el.scrollHeight,
        top: el.scrollTop,
      };
    });
  }, [store]);

  const maybeLoad = useCallback(() => {
    const el = ref.current;
    const p = store.getState().paging;
    if (!el || !p.hasMore || p.loading || p.error) return;
    if (el.scrollTop < NEAR_TOP) loadOlder();
  }, [store, loadOlder]);

  // Only the reader lets go of the bottom. A scroll event can also come from layout (the browser's scroll
  // anchoring when an image or the composer changes size, the keyboard, the app coming back from the camera):
  // those must not leave the list stranded above the newest message.
  const touching = useRef(false);
  const userAt = useRef(0);
  const lastKey = useRef<string | null>(null);
  const byUser = () => touching.current || Date.now() - userAt.current < USER_SCROLL_MS;

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < nearBottom;
    if (atBottom || byUser()) {
      if (!atBottom) userAt.current = Date.now(); // (a fling keeps going after the finger left)
      stick.current = atBottom;
      setShowJump(!atBottom);
    } else if (stick.current) el.scrollTop = el.scrollHeight;
    else setShowJump(true);
    maybeLoad();
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mark = () => (userAt.current = Date.now());
    const down = () => {
      touching.current = true;
      mark();
    };
    const up = () => {
      touching.current = false;
      mark();
    };
    const opts = { passive: true } as const;
    el.addEventListener("touchstart", down, opts);
    el.addEventListener("touchend", up, opts);
    el.addEventListener("touchcancel", up, opts);
    el.addEventListener("wheel", mark, opts);
    el.addEventListener("pointerdown", mark, opts); // (a dragged scrollbar)
    el.addEventListener("keydown", mark);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
      el.removeEventListener("wheel", mark);
      el.removeEventListener("pointerdown", mark);
      el.removeEventListener("keydown", mark);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.current;
    anchor.current = null;
    // the reader just sent something: show it (and what answers it), wherever they had scrolled to
    const last = turns[turns.length - 1];
    if (last && last.key !== lastKey.current && last.role === "user" && !last.meta?.internal && lastKey.current !== null) {
      stick.current = true;
      setShowJump(false);
    }
    lastKey.current = last?.key ?? null;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (a?.node?.isConnected) el.scrollTop = a.node.offsetTop - a.offset; // older turns went in above
    else if (a) el.scrollTop = a.top + (el.scrollHeight - a.height);
  }, [turns]);

  // A chat (re)opened: start at its latest message.
  useLayoutEffect(() => {
    stick.current = true;
    setShowJump(false);
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [openSeq]);

  // Stay at the bottom when the room changes rather than the transcript: the on-screen keyboard or the composer
  // (growing text, an attachment tray) shrinks the list, a closing keyboard grows it, images and late-rendered
  // content grow the transcript. Away from the bottom, only "Latest" follows.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      else setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight >= nearBottom);
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [nearBottom]);

  // Keep the top filled: a short first page, or a fling to the top while a
  // page was loading, fetches the next one.
  useEffect(() => {
    maybeLoad();
  }, [turns, paging.hasMore, paging.loading, maybeLoad]);

  const jump = () => {
    const el = ref.current;
    if (!el) return;
    // (instantly: a smooth scroll's in-between positions would read as "not at the bottom")
    stick.current = true;
    userAt.current = 0;
    setShowJump(false);
    el.scrollTop = el.scrollHeight;
  };

  return { ref, onScroll, showJump, jump, paging, loadOlder };
}
