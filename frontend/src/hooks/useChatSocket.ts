import { useCallback, useEffect, useRef } from "react";
import { wsUrl } from "../api/client";
import { getHistory } from "../api/sessions";
import { useChatStore } from "../stores/chatStore";
import { useSessionStore } from "../stores/sessionStore";
import type { Attachment, ProviderEvent } from "../types";

/**
 * Owns a session's live view: load history, then a WebSocket that attaches
 * with the last event id seen (so nothing is missed or duplicated). Turns run
 * server-side; if the socket drops (network, sleep, deploy) we reconnect with
 * backoff, reload history and re-attach — the agent keeps working meanwhile.
 */
export function useChatSocket(sessionId: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const store = useChatStore;

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { reset, loadHistory, applyEvent, setConnection } = store.getState();
    reset();

    const connect = async () => {
      setConnection(retry ? "reconnecting" : "connecting");
      try {
        const h = await getHistory(sessionId);
        if (!alive) return;
        loadHistory(h);
        useSessionStore.getState().patchLocal(sessionId, { ...h.session });
      } catch {
        if (alive) schedule();
        return;
      }
      const ws = new WebSocket(wsUrl(`/ws/chat/${sessionId}`));
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnection("open");
        ws.send(JSON.stringify({ type: "attach", after: store.getState().lastEid }));
      };
      ws.onmessage = (e) => {
        let ev: ProviderEvent;
        try {
          ev = JSON.parse(e.data);
        } catch {
          return;
        }
        applyEvent(ev);
        if (ev.type === "run.state") {
          useSessionStore.getState().patchLocal(sessionId, { running: Boolean(ev.data.running) });
          if (!ev.data.running) useSessionStore.getState().load().catch(() => {}); // titles, order
        } else if (ev.type === "session.info") {
          useSessionStore.getState().patchLocal(sessionId, { cli_info: ev.data as any });
        }
      };
      ws.onclose = (e) => {
        if (wsRef.current === ws) wsRef.current = null;
        if (!alive || e.code === 4401) return; // unmounted / logged out
        schedule();
      };
    };

    const schedule = () => {
      setConnection("reconnecting");
      const delay = Math.min(15000, 800 * 2 ** retry++);
      timer = setTimeout(() => alive && connect(), delay);
    };

    // Back from sleep / tab hidden for long: reconnect immediately.
    const onVisible = () => {
      if (document.visibilityState === "visible" && alive && !wsRef.current) {
        clearTimeout(timer);
        retry = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    connect();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [sessionId, store]);

  /** Returns false when not connected (the caller keeps the draft). */
  const send = useCallback(
    (input: string, attachments: Attachment[] = []): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const clientMsgId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      store.getState().pushUser(input, attachments, clientMsgId);
      store.getState().setStreaming(true);
      ws.send(
        JSON.stringify({
          type: "chat",
          input,
          attachments: attachments.map((a) => a.id),
          client_msg_id: clientMsgId,
        }),
      );
      return true;
    },
    [store],
  );

  const stop = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: "stop" }));
  }, []);

  return { send, stop };
}
