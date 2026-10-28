import { useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";

export default function ConnectionForm() {
  const create = useConnectionStore((s) => s.create);
  const [form, setForm] = useState({
    name: "",
    host: "<server-ip>",
    port: 2222,
    username: "hrjang",
    private_key_pem: "",
    default_path: ".",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (k: string, v: string | number) => setForm({ ...form, [k]: v });

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await create({ ...form, private_key_pem: form.private_key_pem || null });
      setForm({ ...form, name: "", private_key_pem: "" });
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 bg-panel border border-border rounded-lg space-y-3">
      <h3 className="font-medium text-sm">Add remote SSH host</h3>
      <div className="grid grid-cols-2 gap-2">
        <input
          placeholder="Name (e.g. prod-2222)"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          className="bg-black/40 border border-border rounded px-2 py-1 text-sm"
        />
        <input
          placeholder="Default path"
          value={form.default_path}
          onChange={(e) => set("default_path", e.target.value)}
          className="bg-black/40 border border-border rounded px-2 py-1 text-sm"
        />
        <input
          placeholder="Host"
          value={form.host}
          onChange={(e) => set("host", e.target.value)}
          className="bg-black/40 border border-border rounded px-2 py-1 text-sm"
        />
        <input
          type="number"
          placeholder="Port"
          value={form.port}
          onChange={(e) => set("port", Number(e.target.value))}
          className="bg-black/40 border border-border rounded px-2 py-1 text-sm"
        />
        <input
          placeholder="Username"
          value={form.username}
          onChange={(e) => set("username", e.target.value)}
          className="col-span-2 bg-black/40 border border-border rounded px-2 py-1 text-sm"
        />
      </div>
      <textarea
        placeholder="Private key (PEM) — stored encrypted in the vault"
        value={form.private_key_pem}
        onChange={(e) => set("private_key_pem", e.target.value)}
        rows={3}
        className="w-full bg-black/40 border border-border rounded px-2 py-1 text-xs font-mono"
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        onClick={submit}
        disabled={busy || !form.name || !form.host}
        className="px-3 py-1.5 rounded bg-accent text-black text-sm font-medium disabled:opacity-50"
      >
        {busy ? "Saving…" : "Add connection"}
      </button>
    </div>
  );
}
