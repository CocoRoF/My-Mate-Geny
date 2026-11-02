import { useEffect } from "react";
import { toLogin, wsUrl } from "../api/client";
import { onResync } from "../lib/sync";
import { useCliToolsStore } from "../stores/cliToolsStore";
import { useMateStore } from "../stores/mateStore";
import { useSessionStore } from "../stores/sessionStore";

const SETTLE_MS = 250; // a turn start = message + title + run state: one fetch
const PROBE_MS = 5000; // no answer to "sync" this long → the socket is dead

/**
 * Keeps the session list in sync across devices without polling: the server
 * pushes a version over /ws/sessions whenever the list changes (a chat is
 * created / renamed / deleted, a turn starts or ends), and the list is
 * refetched only when that version is newer than the one it has. Back from
 * the background (phones suspend sockets), one "sync" message checks the
 * socket is alive and the list current; a dead socket reconnects.
 *
 * The same feed announces mate changes (`mates.changed`, and `mates_version` in
 * hello/pong): every window refetches its mates, so the desktop overlay, the
 * quick card or another device never keeps a stale copy (e.g. the old voice
 * volume). The Mate surfaces use it with `{ sessions: false }`.
 */
export function useSessionSync({ sessions = true }: { sessions?: boolean } = {}) {
  useEffect(() => {
    let alive = true;
    let ws: WebSocket | null = null;
    let retry = 0;
    let target = 0; // newest version the server announced
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;

    const store = useSessionStore;
    const stale = () => {
      const have = store.getState().version;
      return have === null || target > have;
    };
    const announce = (v: unknown) => {
      if (typeof v !== "number") return;
      target = Math.max(target, v);
      if (!stale()) return;
      clearTimeout(settleTimer);
      // Re-checked when it fires: a fetch in the meantime may have caught up.
      settleTimer = setTimeout(() => {
        if (alive && stale()) store.getState().load().catch(() => {});
      }, SETTLE_MS);
    };

    const connect = () => {
      clearTimeout(reconnectTimer);
      const sock = new WebSocket(wsUrl("/ws/sessions"));
      ws = sock;
      sock.onopen = () => {
        retry = 0;
      };
      sock.onmessage = (e) => {
        clearTimeout(probeTimer);
        let msg: { type?: string; data?: { version?: unknown; mates_version?: unknown; reason?: unknown; mate_id?: unknown } };
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === "cli.changed" || msg.type === "cli.log") {
          // Settings → Providers → CLI versions: a status change / an upgrade's new log lines (stores/cliToolsStore.ts)
          useCliToolsStore.getState().remote(msg as { type: string; data?: Record<string, unknown> });
          return;
        }
        if (msg.type === "mates.changed") {
          const d = msg.data ?? {};
          useMateStore.getState().remoteChanged(d.version, typeof d.reason === "string" ? d.reason : undefined, typeof d.mate_id === "string" ? d.mate_id : undefined);
          return;
        }
        if (msg.type === "hello" || msg.type === "pong") useMateStore.getState().remoteChanged(msg.data?.mates_version);
        if (sessions && (msg.type === "hello" || msg.type === "pong" || msg.type === "sessions.changed")) announce(msg.data?.version);
      };
      sock.onclose = (e) => {
        if (ws !== sock) return; // replaced
        ws = null;
        clearTimeout(probeTimer);
        if (e.code === 4401) return toLogin();
        if (!alive) return;
        reconnectTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
      };
    };

    const restart = () => {
      const old = ws;
      ws = null;
      old?.close();
      retry = 0;
      connect();
    };

    // Back to the foreground / network: confirm the socket still answers.
    const check = () => {
      if (!alive || document.visibilityState !== "visible") return;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return restart();
      if (ws.readyState !== WebSocket.OPEN) return; // still connecting
      try {
        ws.send(JSON.stringify({ type: "sync" }));
      } catch {
        return restart();
      }
      clearTimeout(probeTimer);
      probeTimer = setTimeout(restart, PROBE_MS);
    };

    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    const offResync = onResync(check);
    connect();
    return () => {
      alive = false;
      clearTimeout(reconnectTimer);
      clearTimeout(settleTimer);
      clearTimeout(probeTimer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
      offResync();
      const old = ws;
      ws = null;
      old?.close();
    };
  }, [sessions]);
}
