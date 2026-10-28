import { useState } from "react";
import { SafeAreaView, Text, TouchableOpacity, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import SessionsScreen from "./src/screens/SessionsScreen";
import ChatScreen from "./src/screens/ChatScreen";
import type { Session } from "./src/api/client";

export default function App() {
  const [active, setActive] = useState<Session | null>(null);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0f1115" }}>
      <StatusBar style="light" />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          padding: 12,
          borderBottomColor: "#272b35",
          borderBottomWidth: 1,
        }}
      >
        {active ? (
          <TouchableOpacity onPress={() => setActive(null)}>
            <Text style={{ color: "#6aa8ff" }}>‹ Sessions</Text>
          </TouchableOpacity>
        ) : (
          <Text style={{ color: "#e5e7eb", fontWeight: "700" }}>hr·harnessor</Text>
        )}
        {active ? (
          <Text style={{ color: "#e5e7eb", marginLeft: 12 }}>{active.title}</Text>
        ) : null}
      </View>
      {active ? <ChatScreen sessionId={active.id} /> : <SessionsScreen onOpen={setActive} />}
    </SafeAreaView>
  );
}
