import { useCallback, useEffect, useRef } from "react";
import { toLogin, wsUrl } from "../api/client";
import { getHistoryPage } from "../api/sessions";
import { onResync } from "../lib/sync";
import { FIRST_TURNS, useChatStore } from "../stores/chatStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTaskStore } from "../stores/taskStore";
import { useUsageStore } from "../stores/usageStore";
import type { Attachment, PlanUsage, ProviderEvent } from "../types";

declare global {
  interface Window {
    // Bridge the desktop (Electron) / Android (Capacitor) shells inject.
    hrhNative?: {
      platform: string;
      version: string;
      notify?: (title: string, body: string) => void;
      openExternal?: (url: string) => void;
      /** desktop: which window this page is in (console | mate-overlay | mate-quick | mate-chat | bar) */
      surface?: string;
      /** desktop: the Mate windows (docs/mate.md §7) */
      mate?: import("../mate/desktop").MateBridge;
      /** desktop: the window draws its own title bar (lib/nativeWindow.ts) */
      window?: import("../lib/nativeWindow").WindowBridge;
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
 * Back in the foreground, a re-sent attach both catches up and proves the
 * socket alive (a phone may hand back a dead one); the sidebar's refresh
 * forces a full reload.
 */
export function useChatSocket(sessionId: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const store = useChatStore;

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let probe: ReturnType<typeof setTimeout> | undefined;
    let gen = 0; // a newer connect() supersedes one still loading history
    const { reset, loadHistory, applyEvent, setConnection } = store.getState();
    reset(sessionId);

    const connect = async () => {
      const mine = ++gen;
      setConnection(retry ? "reconnecting" : "connecting");
      try {
        // First the newest turns; a reconnect reloads what is shown (from the
        // oldest loaded turn on), so pages already scrolled through stay.
        const s = store.getState();
        const h = await getHistoryPage(
          sessionId,
          s.opened && s.sid === sessionId && s.paging.paged ? { since: s.paging.cursor ?? "" } : { turns: FIRST_TURNS },
        );
        if (!alive || mine !== gen) return;
        loadHistory(h);
        useUsageStore.getState().setAccount(sessionId, h.account);
        useUsageStore.getState().setLive(sessionId, h.live_usage);
        useSessionStore.getState().patchLocal(sessionId, { ...h.session });
        useTaskStore.getState().loadSession(sessionId).catch(() => {});
      } catch {
        if (alive && mine === gen) schedule();
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
        clearTimeout(probe);
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
          // Tagged with its chat by the backend; ignore anything else's.
          const u = ev.data as PlanUsage;
          if (!u.session_id || u.session_id === sessionId) useUsageStore.getState().setLive(sessionId, u);
          return;
        }
        if (ev.type === "session.start" && ev.data.account) {
          useUsageStore.getState().setAccount(sessionId, {
            account: String(ev.data.account),
            account_id: (ev.data.account_id as string) ?? null,
            provider: (ev.data.provider as string) ?? null,
          });
        }
        applyEvent(ev);
        if (ev.type === "run.state") {
          useSessionStore.getState().patchLocal(sessionId, { running: Boolean(ev.data.running) });
          if (!ev.data.running) {
            // (titles / order: the session feed refetches the list)
            const turns = store.getState().turns;
            const last = turns[turns.length - 1];
            const title = useSessionStore.getState().sessions.find((x) => x.id === sessionId)?.title || "My Mate Geny";
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
        if (wsRef.current !== ws) return; // replaced by a newer connection
        wsRef.current = null;
        clearTimeout(probe);
        if (e.code === 4401) return toLogin(); // session expired / revoked
        if (!alive) return; // unmounted
        schedule();
      };
    };

    const schedule = () => {
      setConnection("reconnecting");
      const delay = Math.min(15000, 800 * 2 ** retry++);
      timer = setTimeout(() => alive && connect(), delay);
    };

    // Drop the current socket (if any) and reload + re-attach right away.
    const reconnectNow = () => {
      if (!alive) return;
      clearTimeout(timer);
      clearTimeout(probe);
      const old = wsRef.current;
      wsRef.current = null;
      old?.close();
      retry = 0;
      connect();
    };

    // Back from sleep / background: re-attach on the open socket — it replays
    // what was missed and answers at once; silence means the socket is dead.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !alive) return;
      const ws = wsRef.current;
      if (!ws) return reconnectNow();
      if (ws.readyState !== WebSocket.OPEN) return; // connecting
      try {
        ws.send(JSON.stringify({ type: "attach", after: store.getState().lastEid }));
      } catch {
        return reconnectNow();
      }
      clearTimeout(probe);
      probe = setTimeout(reconnectNow, 5000);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    const offResync = onResync(reconnectNow);

    connect();
    return () => {
      alive = false;
      clearTimeout(timer);
      clearTimeout(probe);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      offResync();
      const old = wsRef.current;
      wsRef.current = null;
      old?.close();
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
