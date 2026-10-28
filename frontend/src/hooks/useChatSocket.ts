import { useCallback, useEffect, useRef } from "react";
import { wsUrl } from "../api/client";
import { useChatStore } from "../stores/chatStore";
import type { ProviderEvent } from "../types";

/**
 * Manages a WebSocket to /ws/chat/{sid}. Reconnects when the session changes.
 * Sending a message streams normalized events into the chat store.
 */
export function useChatSocket(sessionId: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const applyEvent = useChatStore((s) => s.applyEvent);
  const pushUser = useChatStore((s) => s.pushUser);
  const setStreaming = useChatStore((s) => s.setStreaming);

  useEffect(() => {
    if (!sessionId) return;
    const ws = new WebSocket(wsUrl(`/ws/chat/${sessionId}`));
    ws.onmessage = (e) => {
      try {
        applyEvent(JSON.parse(e.data) as ProviderEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => setStreaming(false);
    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId, applyEvent, setStreaming]);

  const send = useCallback(
    (input: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      pushUser(input);
      setStreaming(true);
      ws.send(JSON.stringify({ type: "chat", input }));
    },
    [pushUser, setStreaming],
  );

  return { send };
}
