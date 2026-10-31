import { useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import Icon from "../ui/Icon";

export default function ConnectionForm() {
  const create = useConnectionStore((s) => s.create);
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: 22,
    username: "",
    private_key_pem: "",
    default_path: ".",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);

  const set = (k: string, v: string | number) => setForm({ ...form, [k]: v });

  const submit = async () => {
    setBusy(true);
    setError("");
    setOk(false);
    try {
      await create({ ...form, private_key_pem: form.private_key_pem || null });
      setForm({ ...form, name: "", private_key_pem: "" });
      setOk(true);
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium mb-3">
        <Icon name="plus" size={15} className="text-accent" /> Add remote SSH host
      </h3>
      <div className="grid grid-cols-2 gap-2">
        <input placeholder="Name (e.g. build-box)" value={form.name} onChange={(e) => set("name", e.target.value)} className="field" />
        <input placeholder="Default path" value={form.default_path} onChange={(e) => set("default_path", e.target.value)} className="field font-mono" />
        <input placeholder="Host (e.g. 192.168.1.20 or build.example.com)" value={form.host} onChange={(e) => set("host", e.target.value)} className="field font-mono" />
        <input type="number" placeholder="Port" value={form.port} onChange={(e) => set("port", Number(e.target.value))} className="field font-mono" />
        <input placeholder="Username" value={form.username} onChange={(e) => set("username", e.target.value)} className="field col-span-2 font-mono" />
      </div>
      <textarea
        placeholder="Private key (PEM) — stored encrypted in the vault"
        value={form.private_key_pem}
        onChange={(e) => set("private_key_pem", e.target.value)}
        rows={3}
        className="field mt-2 font-mono text-[11px]"
      />
      {error && <p className="mt-2 text-xs text-danger flex items-center gap-1.5"><Icon name="x" size={13} /> {error}</p>}
      {ok && <p className="mt-2 text-xs text-success flex items-center gap-1.5"><Icon name="check" size={13} /> Connection added.</p>}
      <button onClick={submit} disabled={busy || !form.name || !form.host} className="btn-primary mt-3">
        {busy ? <Icon name="spinner" size={15} spin /> : <Icon name="server" size={15} />}
        Add connection
      </button>
    </div>
  );
}
