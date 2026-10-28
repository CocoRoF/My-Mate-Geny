import { useEffect, useState } from "react";
import { SafeAreaView, Text, TouchableOpacity, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import LoginScreen from "./src/screens/LoginScreen";
import SessionsScreen from "./src/screens/SessionsScreen";
import NewSessionScreen from "./src/screens/NewSessionScreen";
import ChatScreen from "./src/screens/ChatScreen";
import { loadToken, logout, type Session } from "./src/api/client";

type Screen = "login" | "sessions" | "new" | "chat";

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [active, setActive] = useState<Session | null>(null);

  useEffect(() => {
    loadToken().then((t) => setScreen(t ? "sessions" : "login"));
  }, []);

  const header = () => {
    const back = screen === "chat" || screen === "new";
    return (
      <View style={bar}>
        {back ? (
          <TouchableOpacity onPress={() => setScreen("sessions")}>
            <Text style={{ color: "#6aa8ff" }}>‹ 세션</Text>
          </TouchableOpacity>
        ) : (
          <Text style={{ color: "#e5e7eb", fontWeight: "700" }}>hr·harnessor</Text>
        )}
        <Text style={{ color: "#e5e7eb", marginLeft: 12, flex: 1 }} numberOfLines={1}>
          {screen === "chat" && active ? active.title : ""}
        </Text>
        {screen === "sessions" && (
          <TouchableOpacity onPress={async () => { await logout(); setScreen("login"); }}>
            <Text style={{ color: "#9ca3af" }}>로그아웃</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0f1115" }}>
      <StatusBar style="light" />
      {screen !== "login" && header()}
      {screen === "login" && <LoginScreen onDone={() => setScreen("sessions")} />}
      {screen === "sessions" && (
        <SessionsScreen
          onOpen={(s) => { setActive(s); setScreen("chat"); }}
          onNew={() => setScreen("new")}
        />
      )}
      {screen === "new" && (
        <NewSessionScreen onCreated={(s) => { setActive(s); setScreen("chat"); }} />
      )}
      {screen === "chat" && active && <ChatScreen sessionId={active.id} />}
    </SafeAreaView>
  );
}

const bar = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  padding: 12,
  borderBottomColor: "#272b35",
  borderBottomWidth: 1,
};
