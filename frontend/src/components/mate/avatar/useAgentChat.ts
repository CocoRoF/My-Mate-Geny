/**
 * The Avatar Create agent's conversation, live: the session's history (/api/history) + /ws/chat, in its own chat
 * store (so the Mate conversation stays live next to it). No voice, no avatar moods — a plain agent chat.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toLogin, wsUrl } from "../../../api/client";
import { getHistoryPage } from "../../../api/sessions";
import { onResync } from "../../../lib/sync";
import { createChatStore, FIRST_TURNS } from "../../../stores/chatStore";
import type { Attachment, ProviderEvent } from "../../../types";
import { clientMsgId } from "../../../mate/voiceOwner";

export const useAvatarChat = createChatStore();

export interface AgentChat {
  connection: "connecting" | "open" | "reconnecting";
  error: string | null;
  streaming: boolean;
  send: (text: string, attachments?: Attachment[]) => boolean;
  stop: () => void;
}

/** ``onToolResult``: an agent tool finished (the project changed: the panel reloads it) */
export function useAgentChat(sid: string | null, onToolResult?: () => void): AgentChat {
  const store = useAvatarChat;
  const wsRef = useRef<WebSocket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connection = store((s) => s.connection);
  const streaming = store((s) => s.isStreaming);
  const cb = useRef(onToolResult);
  cb.current = onToolResult;

  useEffect(() => {
    const { reset, loadHistory, applyEvent, setConnection } = store.getState();
    reset(sid);
    if (!sid) return;
    let alive = true;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      setConnection(retry ? "reconnecting" : "connecting");
      try {
        const s = store.getState();
        const h = await getHistoryPage(sid, s.opened && s.sid === sid && s.paging.paged ? { since: s.paging.cursor ?? "" } : { turns: FIRST_TURNS });
        if (!alive) return;
        loadHistory(h);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
        schedule();
        return;
      }
      const ws = new WebSocket(wsUrl(`/ws/chat/${sid}`));
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
        if (ev.type === "task.state" || ev.type === "usage.update") return;
        applyEvent(ev);
        if (ev.type === "tool.result" || ev.type === "turn.complete") cb.current?.();
      };
      ws.onclose = (e) => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (e.code === 4401) return toLogin();
        if (alive) schedule();
      };
    };
    const schedule = () => {
      setConnection("reconnecting");
      timer = setTimeout(() => alive && connect(), Math.min(15000, 800 * 2 ** retry++));
    };
    const offResync = onResync(() => {
      wsRef.current?.close();
    });
    connect();
    return () => {
      alive = false;
      clearTimeout(timer);
      offResync();
      const old = wsRef.current;
      wsRef.current = null;
      old?.close();
    };
  }, [sid, store]);

  const send = useCallback(
    (input: string, attachments: Attachment[] = []): boolean => {
      const text = input.trim();
      if (!text && !attachments.length) return false;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const cid = clientMsgId("a");
      if (store.getState().isStreaming) {
        store.getState().pushSteer(text, attachments, cid);
        ws.send(JSON.stringify({ type: "steer", input: text, attachments: attachments.map((a) => a.id), client_msg_id: cid }));
        return true;
      }
      store.getState().pushUser(text, attachments, cid);
      store.getState().setStreaming(true);
      ws.send(JSON.stringify({ type: "chat", input: text, attachments: attachments.map((a) => a.id), client_msg_id: cid }));
      return true;
    },
    [store],
  );
  const stop = useCallback(() => wsRef.current?.send(JSON.stringify({ type: "stop" })), []);

  // A message the server didn't take (a run was still on): sent again, first, once the run has ended (lib/queue.ts).
  const bounced = store((s) => s.bounced);
  const runActive = store((s) => s.runActive);
  const [again, setAgain] = useState<{ text: string; attachments: Attachment[] }[]>([]);
  useEffect(() => {
    if (!bounced.length) return;
    const back = store.getState().takeBounced();
    if (back.length) setAgain((q) => [...back.map((b) => ({ text: b.text, attachments: b.attachments })), ...q]);
  }, [bounced, store]);
  useEffect(() => {
    if (!again.length || streaming || runActive || connection !== "open") return;
    const [next, ...rest] = again;
    if (send(next.text, next.attachments)) setAgain(rest);
  }, [again, streaming, runActive, connection, send]);
  return { connection, error, streaming, send, stop };
}
