import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  createSession,
  listConnections,
  listProviders,
  type Connection,
  type ProviderStatus,
  type Session,
} from "../api/client";

export default function NewSessionScreen({ onCreated }: { onCreated: (s: Session) => void }) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [provider, setProvider] = useState("claude");
  const [model, setModel] = useState("sonnet");
  const [connId, setConnId] = useState<string | null>(null);
  const [path, setPath] = useState("/home");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listProviders().then(setProviders).catch(() => {});
    listConnections().then(setConnections).catch(() => {});
  }, []);

  const start = async () => {
    setBusy(true);
    setErr("");
    try {
      const s = await createSession({
        provider,
        model,
        connection_id: connId,
        workspace_path: path,
        title: path.split("/").pop() || "chat",
      });
      onCreated(s);
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const chip = (active: boolean) => ({
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginRight: 8,
    backgroundColor: active ? "#6aa8ff" : "#171a21",
    borderWidth: 1,
    borderColor: "#272b35",
  });

  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#0f1115" }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ color: "#e5e7eb", fontSize: 18, fontWeight: "600", marginBottom: 12 }}>
        새 채팅
      </Text>

      <Text style={lbl}>Provider</Text>
      <View style={{ flexDirection: "row", marginBottom: 12 }}>
        {providers.map((p) => (
          <TouchableOpacity key={p.provider} onPress={() => setProvider(p.provider)} style={chip(provider === p.provider)}>
            <Text style={{ color: provider === p.provider ? "#000" : "#e5e7eb" }}>{p.provider}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={lbl}>Model</Text>
      <TextInput value={model} onChangeText={setModel} style={inp} placeholderTextColor="#6b7280" />

      <Text style={lbl}>Location</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", marginBottom: 8 }}>
        <TouchableOpacity onPress={() => { setConnId(null); setPath("/home"); }} style={chip(connId === null)}>
          <Text style={{ color: connId === null ? "#000" : "#e5e7eb" }}>Local (2223)</Text>
        </TouchableOpacity>
        {connections.map((c) => (
          <TouchableOpacity key={c.id} onPress={() => { setConnId(c.id); setPath("/home/hrjang"); }} style={chip(connId === c.id)}>
            <Text style={{ color: connId === c.id ? "#000" : "#e5e7eb" }}>{c.name}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={lbl}>Workspace path</Text>
      <TextInput value={path} onChangeText={setPath} autoCapitalize="none" style={inp} placeholderTextColor="#6b7280" />

      {err ? <Text style={{ color: "#f87171", marginVertical: 8 }}>{err}</Text> : null}
      <TouchableOpacity onPress={start} disabled={busy} style={{ backgroundColor: "#6aa8ff", borderRadius: 8, padding: 14, marginTop: 8 }}>
        <Text style={{ color: "#000", fontWeight: "600", textAlign: "center" }}>
          {busy ? "생성 중…" : "채팅 시작"}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const lbl = { color: "#9ca3af", fontSize: 12, marginBottom: 4 } as const;
const inp = {
  backgroundColor: "#171a21",
  color: "#e5e7eb",
  borderRadius: 8,
  padding: 10,
  marginBottom: 12,
  borderWidth: 1,
  borderColor: "#272b35",
} as const;
