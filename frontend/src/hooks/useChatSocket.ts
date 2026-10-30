import { useCallback, useEffect, useRef } from "react";
import { wsUrl } from "../api/client";
import { getHistory } from "../api/sessions";
import { useChatStore } from "../stores/chatStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTaskStore } from "../stores/taskStore";
import type { Attachment, ProviderEvent } from "../types";

declare global {
  interface Window {
    // Bridge the desktop (Electron) / Android (Capacitor) shells inject.
    hrhNative?: {
      platform: string;
      version: string;
      notify?: (title: string, body: string) => void;
      openExternal?: (url: string) => void;
    };
  }
}

/** Tell the user a turn finished while they were looking elsewhere. */
function notifyDone(title: string, body: string) {
  if (!document.hidden) return;
  if (window.hrhNative?.notify) return window.hrhNative.notify(title, body);
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, { body, tag: "hrh-turn", icon: "/favicon.svg" });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  }
}

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
        useTaskStore.getState().loadSession(sessionId).catch(() => {});
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
        if (ev.type === "task.state") {
          useTaskStore.getState().upsert(sessionId, ev.data as any);
          return;
        }
        if (ev.type === "usage.update") {
          useTaskStore.getState().setUsage(ev.data as any);
          return;
        }
        applyEvent(ev);
        if (ev.type === "run.state") {
          useSessionStore.getState().patchLocal(sessionId, { running: Boolean(ev.data.running) });
          if (!ev.data.running) {
            useSessionStore.getState().load().catch(() => {}); // titles, order
            const turns = store.getState().turns;
            const last = turns[turns.length - 1];
            const title = useSessionStore.getState().sessions.find((x) => x.id === sessionId)?.title || "hr·harnessor";
            if (last?.role === "assistant") {
              const body =
                last.status === "error" ? `Failed: ${last.error?.message || ""}` :
                last.status === "interrupted" ? "Stopped" :
                (last.text.trim().split("\n").find((l) => l.trim()) || "Done").slice(0, 160);
              notifyDone(title, body);
            }
          }
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
      if (!window.hrhNative && "Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
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

  /** Add instructions to the RUNNING turn. False when not connected. */
  const steer = useCallback(
    (input: string, attachments: Attachment[] = []): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const clientMsgId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      store.getState().pushSteer(input, attachments, clientMsgId);
      ws.send(
        JSON.stringify({
          type: "steer",
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

  return { send, steer, stop };
}
