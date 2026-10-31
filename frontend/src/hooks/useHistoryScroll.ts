import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatStoreApi } from "../stores/chatStore";

/** Fetch the previous page this far (px) before the reader reaches the top. */
const NEAR_TOP = 800;

/**
 * Scrolling of a transcript that loads upward (paged history, chatStore):
 * opens at the end, follows new output while the reader is at the bottom,
 * fetches older turns near the top (one request at a time) and keeps the view
 * still when they are prepended: the first visible item is measured right
 * before the store changes and put back at the same spot in a layout effect,
 * i.e. before the browser paints (whatever else changed below doesn't move it).
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

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < nearBottom;
    stick.current = atBottom;
    setShowJump(!atBottom);
    maybeLoad();
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.current;
    anchor.current = null;
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

  // Keep the top filled: a short first page, or a fling to the top while a
  // page was loading, fetches the next one.
  useEffect(() => {
    maybeLoad();
  }, [turns, paging.hasMore, paging.loading, maybeLoad]);

  const jump = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return { ref, onScroll, showJump, jump, paging, loadOlder };
}
