import { useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import { login } from "../api/client";

export default function LoginScreen({ onDone }: { onDone: () => void }) {
  const [u, setU] = useState("admin");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      await login(u, p);
      onDone();
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#0f1115", justifyContent: "center", padding: 24 }}>
      <Text style={{ color: "#e5e7eb", fontSize: 22, fontWeight: "700", marginBottom: 4 }}>
        hr·harnessor
      </Text>
      <Text style={{ color: "#9ca3af", marginBottom: 20 }}>관리자 로그인</Text>
      <TextInput
        value={u}
        onChangeText={setU}
        autoCapitalize="none"
        placeholder="ID"
        placeholderTextColor="#6b7280"
        style={inp}
      />
      <TextInput
        value={p}
        onChangeText={setP}
        secureTextEntry
        placeholder="Password"
        placeholderTextColor="#6b7280"
        style={inp}
      />
      {err ? <Text style={{ color: "#f87171", marginBottom: 8 }}>{err}</Text> : null}
      <TouchableOpacity onPress={submit} disabled={busy} style={btn}>
        <Text style={{ color: "#000", fontWeight: "600", textAlign: "center" }}>
          {busy ? "로그인 중…" : "로그인"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const inp = {
  backgroundColor: "#171a21",
  color: "#e5e7eb",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
  borderWidth: 1,
  borderColor: "#272b35",
} as const;
const btn = { backgroundColor: "#6aa8ff", borderRadius: 8, padding: 14, marginTop: 4 } as const;
