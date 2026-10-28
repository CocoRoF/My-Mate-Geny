import { useEffect, useState } from "react";
import { FlatList, Text, TouchableOpacity, View } from "react-native";
import { listSessions, type Session } from "../api/client";

export default function SessionsScreen({ onOpen }: { onOpen: (s: Session) => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch((e) => setError(String(e.message || e)));
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#0f1115", padding: 12 }}>
      <Text style={{ color: "#e5e7eb", fontSize: 18, fontWeight: "600", marginBottom: 12 }}>
        Sessions
      </Text>
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
              {item.provider} · {item.workspace_path}
            </Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <Text style={{ color: "#6b7280" }}>No sessions. Create one from the web UI.</Text>
        }
      />
    </View>
  );
}
