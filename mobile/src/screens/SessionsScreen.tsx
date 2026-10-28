import { useEffect, useState } from "react";
import { FlatList, Text, TouchableOpacity, View } from "react-native";
import { listSessions, type Session } from "../api/client";

export default function SessionsScreen({
  onOpen,
  onNew,
}: {
  onOpen: (s: Session) => void;
  onNew: () => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch((e) => setError(String(e.message || e)));
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#0f1115", padding: 12 }}>
      <TouchableOpacity
        onPress={onNew}
        style={{ backgroundColor: "#6aa8ff", borderRadius: 8, padding: 12, marginBottom: 12 }}
      >
        <Text style={{ color: "#000", fontWeight: "600", textAlign: "center" }}>+ 새 채팅</Text>
      </TouchableOpacity>
      {error ? <Text style={{ color: "#f87171" }}>{error}</Text> : null}
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={() => onOpen(item)}
            style={{ backgroundColor: "#171a21", borderRadius: 8, padding: 12, marginVertical: 4 }}
          >
            <Text style={{ color: "#e5e7eb" }}>{item.title}</Text>
            <Text style={{ color: "#6b7280", fontSize: 12 }}>
              {item.connection_id ? "🌐 " : "💻 "}
              {item.provider} · {item.workspace_path}
            </Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={<Text style={{ color: "#6b7280" }}>세션이 없습니다. 새 채팅을 시작하세요.</Text>}
      />
    </View>
  );
}
