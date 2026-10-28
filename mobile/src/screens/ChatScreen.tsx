import { useEffect, useRef, useState } from "react";
import { FlatList, Text, TextInput, TouchableOpacity, View } from "react-native";
import { wsUrl } from "../api/client";

interface Bubble {
  role: "user" | "assistant";
  text: string;
}

/**
 * Minimal chat screen — connects to /ws/chat/{sid} and renders the streaming
 * assistant turn. Mirrors the web useChatSocket + chatStore logic, trimmed.
 */
export default function ChatScreen({ sessionId }: { sessionId: string }) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(wsUrl(`/ws/chat/${sessionId}`));
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      setBubbles((prev) => {
        const next = [...prev];
        let last = next[next.length - 1];
        if (!last || last.role !== "assistant") {
          last = { role: "assistant", text: "" };
          next.push(last);
        }
        if (ev.type === "text.delta") last.text += ev.data.text || "";
        else if (ev.type === "turn.complete" && ev.data.text) last.text = ev.data.text;
        else if (ev.type === "error") last.text += `\n⚠️ ${ev.data.message}`;
        return next;
      });
    };
    wsRef.current = ws;
    return () => ws.close();
  }, [sessionId]);

  const send = () => {
    const text = input.trim();
    if (!text || wsRef.current?.readyState !== WebSocket.OPEN) return;
    setBubbles((p) => [...p, { role: "user", text }]);
    wsRef.current.send(JSON.stringify({ type: "chat", input: text }));
    setInput("");
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#0f1115", padding: 12 }}>
      <FlatList
        data={bubbles}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => (
          <View
            style={{
              alignSelf: item.role === "user" ? "flex-end" : "flex-start",
              backgroundColor: item.role === "user" ? "#2b3a55" : "#171a21",
              borderRadius: 10,
              padding: 10,
              marginVertical: 4,
              maxWidth: "85%",
            }}
          >
            <Text style={{ color: "#e5e7eb" }}>{item.text}</Text>
          </View>
        )}
      />
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Message…"
          placeholderTextColor="#6b7280"
          style={{
            flex: 1,
            backgroundColor: "#171a21",
            color: "#e5e7eb",
            borderRadius: 8,
            paddingHorizontal: 12,
          }}
        />
        <TouchableOpacity
          onPress={send}
          style={{ backgroundColor: "#6aa8ff", borderRadius: 8, paddingHorizontal: 16, justifyContent: "center" }}
        >
          <Text style={{ color: "#000", fontWeight: "600" }}>Send</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
