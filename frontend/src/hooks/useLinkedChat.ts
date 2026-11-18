/**
 * Another chat, live and read-only (components/chat/LinkedChat.tsx): its latest turns (/api/history), the older ones on
 * request, and what happens in it as it happens (/ws/chat, attached as on screen) — in a chat store of its own, so the chat
 * open here is never touched.
 */
import { useEffect, useMemo, useState } from "react";
import { toLogin, wsUrl } from "../api/client";
import { getHistoryPage } from "../api/sessions";
import { onResync } from "../lib/sync";
import { createChatStore, FIRST_TURNS } from "../stores/chatStore";
import type { ProviderEvent } from "../types";

export function useLinkedChat(sid: string) {
  const store = useMemo(() => createChatStore({ lite: true }), [sid]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const { reset, loadHistory, applyEvent, setConnection } = store.getState();
    reset(sid);
    let alive = true;
    let retry = 0;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      setConnection("reconnecting");
      timer = setTimeout(() => alive && void connect(), Math.min(15000, 800 * 2 ** retry++));
    };
    const connect = async () => {
      setConnection(retry ? "reconnecting" : "connecting");
      try {
        const s = store.getState();
        const h = await getHistoryPage(sid, s.opened && s.paging.paged ? { since: s.paging.cursor ?? "" } : { turns: FIRST_TURNS }, true);
        if (!alive) return;
        loadHistory(h);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
        schedule();
        return;
      }
      const sock = new WebSocket(wsUrl(`/ws/chat/${sid}`));
      ws = sock;
      sock.onopen = () => {
        retry = 0;
        setConnection("open");
        sock.send(JSON.stringify({ type: "attach", after: store.getState().lastEid, visible: document.visibilityState === "visible" }));
      };
      sock.onmessage = (e) => {
        let ev: ProviderEvent;
        try {
          ev = JSON.parse(e.data);
        } catch {
          return;
        }
        if (ev.type === "task.state" || ev.type === "usage.update" || ev.type === "session.notify") return;
        applyEvent(ev);
      };
      sock.onclose = (e) => {
        if (ws !== sock) return;
        ws = null;
        if (e.code === 4401) return toLogin();
        if (alive) schedule();
      };
    };
    const offResync = onResync(() => ws?.close());
    void connect();
    return () => {
      alive = false;
      clearTimeout(timer);
      offResync();
      const old = ws;
      ws = null;
      old?.close();
    };
  }, [sid, store]);
  return { store, error };
}
