/**
 * Avatar: kind (none / video / photo / Live2D), imports (zip, a folder on the server), simple asset upload for photo
 * stills and video clips, a note when the Live2D runtime is missing (installed in Global settings) and emotion → expression / motion mapping, with
 * a live preview and test buttons. Video/photo rigs get the clip library + trigger editor (ClipLibrary.tsx); built-ins a
 * "Reset to the bundled version".
 */
import { useEffect, useRef, useState } from "react";
import { coreStatus, importAvatarZip, importLocal, uploadAsset, type Mate } from "../../../api/mates";
import { MateAvatar } from "../../../mate/avatar/MateAvatar";
import { EMOTIONS } from "../../../mate/emotion";
import type { Avatar, BodyMood, Live2D, MateReact, Rig } from "../../../mate/types";
import type { MateConversation } from "../../../mate/useMateConversation";
import { end as voiceEnd, fakeLevel, level as voiceLevel, start as voiceStart } from "../../../mate/voiceBridge";
import { useMateStore } from "../../../stores/mateStore";
import Icon from "../../ui/Icon";
import { previewMateAvatar } from "../../../mate/livePreview";
import { BundledReset, ClipLibrary, StillTriggers, TriggerPreview, type TriggerPick } from "./ClipLibrary";
import { Banner, ErrorLine, Field, SaveBar, Section, useSaver } from "./ui";

const MOODS: BodyMood[] = ["idle", "listening", "thinking", "talking", "away"];
const STILLS = ["neutral", "smile", "laugh", "shy", "surprised", "sad", "thinking", "sleepy", "blink", "mouth_half", "mouth_open", "mouth_o"];

const emptyRig = (): Rig => ({ aspect: [3, 4], home: "", stills: {}, clips: [] });
const rigOf = (a: Avatar): Rig => (a.kind === "video" || a.kind === "photo" ? a.rig : emptyRig());

function imageSize(file: Blob): Promise<[number, number] | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img.naturalWidth && img.naturalHeight ? [img.naturalWidth, img.naturalHeight] : null);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

const extOf = (f: File, fallback: string) => (f.name.match(/\.([a-z0-9]{2,5})$/i)?.[1] || fallback).toLowerCase();

export default function AvatarTab({ mate, conv }: { mate: Mate; conv: MateConversation }) {
  const [avatar, setAvatar] = useState<Avatar>(mate.avatar);
  const saver = useSaver();
  const dirty = JSON.stringify(avatar) !== JSON.stringify(mate.avatar);
  // the server replaced the avatar (an import): start from it
  const serverAvatar = JSON.stringify(mate.avatar);
  useEffect(() => setAvatar(JSON.parse(serverAvatar)), [serverAvatar]);
  const save = () => saver.run(() => useMateStore.getState().patch(mate.id, { avatar }));
  // the draft is live: every avatar of this browser (overlay, chat window, quick card, other tabs) shows it while it
  // differs from the saved one; saving or leaving the tab puts the saved one back (mate/livePreview)
  const draftKey = dirty ? JSON.stringify(avatar) : "";
  useEffect(() => {
    previewMateAvatar(mate.id, draftKey ? (JSON.parse(draftKey) as Avatar) : null);
  }, [draftKey, mate.id]);
  useEffect(() => () => previewMateAvatar(mate.id, null), [mate.id]);
  // the clip editor's "show it on the avatar preview"
  const [poke, setPoke] = useState<{ pick: TriggerPick; at: number } | null>(null);
  const onPoke = (pick: TriggerPick) => setPoke({ pick, at: Date.now() });

  const setKind = (kind: Avatar["kind"]) => {
    if (kind === avatar.kind) return;
    if (kind === "none") setAvatar({ kind: "none" });
    else if (kind === "photo") setAvatar({ kind: "photo", rig: { ...rigOf(avatar), clips: [] } });
    else if (kind === "video") setAvatar({ kind: "video", rig: rigOf(avatar.kind === "video" ? avatar : mate.avatar) });
    else setAvatar({ kind: "live2d", live2d: mate.avatar.kind === "live2d" ? mate.avatar.live2d : { model: "" } });
  };

  return (
    <>
      <Preview mate={mate} avatar={avatar} conv={conv} poke={poke} />
      <Section title="Kind">
        <div className="grid grid-cols-4 gap-1.5">
          {(["none", "photo", "video", "live2d"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-lg border px-2 py-2 text-[12.5px] transition ${
                avatar.kind === k ? "border-accent/60 bg-accent-soft text-content" : "border-border text-content-dim hover:border-border-strong hover:text-content"
              }`}
              data-testid={`mate-avatar-kind-${k}`}
            >
              {k === "none" ? "None" : k === "photo" ? "Photo" : k === "video" ? "Video" : "Live2D"}
            </button>
          ))}
        </div>
      </Section>
      <ImportSection mate={mate} />
      {avatar.kind === "photo" && (
        <>
          <StillsEditor mate={mate} rig={avatar.rig} onChange={(rig) => setAvatar({ kind: "photo", rig })} />
          <StillTriggers rig={avatar.rig} onChange={(rig) => setAvatar({ kind: "photo", rig })} onPoke={onPoke} video={false} />
        </>
      )}
      {avatar.kind === "video" && (
        <>
          <ClipLibrary mate={mate} rig={avatar.rig} onChange={(rig) => setAvatar({ kind: "video", rig })} />
          <TriggerPreview rig={avatar.rig} onChange={(rig) => setAvatar({ kind: "video", rig })} onPoke={onPoke} />
          <StillsEditor mate={mate} rig={avatar.rig} onChange={(rig) => setAvatar({ kind: "video", rig })} />
          <StillTriggers rig={avatar.rig} onChange={(rig) => setAvatar({ kind: "video", rig })} onPoke={onPoke} video />
        </>
      )}
      {avatar.kind === "live2d" && (
        <>
          <CoreNotice />
          <Live2DEditor live2d={avatar.live2d} onChange={(live2d) => setAvatar({ kind: "live2d", live2d })} />
        </>
      )}
      <BundledReset mate={mate} dirty={dirty} />
      <SaveBar saver={saver} onSave={save} dirty={dirty} onReset={() => setAvatar(mate.avatar)} />
    </>
  );
}

function Preview({ mate, avatar, conv, poke }: { mate: Mate; avatar: Avatar; conv: MateConversation; poke: { pick: TriggerPick; at: number } | null }) {
  const [mood, setMood] = useState<BodyMood>("idle");
  const [react, setReact] = useState<MateReact>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!poke) return;
    if (poke.pick.type === "mood") setMood(poke.pick.mood);
    else setReact({ name: poke.pick.name, at: poke.at });
    box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [poke]);
  const talkTimer = useRef<number | null>(null);
  const fakeTalk = () => {
    if (talkTimer.current) cancelAnimationFrame(talkTimer.current);
    const id = `preview-${Date.now()}`;
    const t0 = performance.now();
    voiceStart(id);
    const tick = (now: number) => {
      if (now - t0 > 2600) {
        voiceEnd(id);
        talkTimer.current = null;
        return;
      }
      voiceLevel(fakeLevel(now - t0));
      talkTimer.current = requestAnimationFrame(tick);
    };
    talkTimer.current = requestAnimationFrame(tick);
  };
  useEffect(() => () => {
    if (talkTimer.current) cancelAnimationFrame(talkTimer.current);
  }, []);
  return (
    <Section title="Preview" hint="Unsaved changes show here first.">
      <div ref={box} className="mx-auto h-64 w-full max-w-xs overflow-hidden rounded-xl border border-border bg-[repeating-conic-gradient(#161a22_0%_25%,#11141b_0%_50%)] [background-size:24px_24px]" data-testid="mate-avatar-preview">
        <MateAvatar avatar={avatar} name={mate.name} mood={mood} react={react} />
      </div>
      <div className="flex flex-wrap gap-1">
        {MOODS.map((m) => (
          <button key={m} onClick={() => setMood(m)} data-testid={`mate-preview-mood-${m}`} className={`pill border ${mood === m ? "border-accent/50 bg-accent-soft text-accent" : "border-border text-content-dim hover:text-content"}`}>
            {m}
          </button>
        ))}
        <button onClick={fakeTalk} className="pill border border-border text-content-dim hover:text-content">
          <Icon name="volume" size={11} /> speak
        </button>
        <button onClick={() => conv.say(mate.persona.greeting || `Hi, I'm ${mate.name}.`)} className="pill border border-border text-content-dim hover:text-content" title="Say the greeting with this mate's voice">
          <Icon name="play" size={11} /> say greeting
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {EMOTIONS.map((e) => (
          <button key={e} onClick={() => setReact({ name: e, at: Date.now() })} className="pill border border-border text-content-faint hover:text-content" data-testid={`mate-preview-emotion-${e}`}>
            {e}
          </button>
        ))}
      </div>
    </Section>
  );
}

function ImportSection({ mate }: { mate: Mate }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState<"zip" | "local" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const done = (m: Mate, what: string) => {
    useMateStore.getState().upsert(m);
    setOk(`Imported (${what}) and applied.`);
  };
  const zip = async (f: File) => {
    setBusy("zip");
    setErr(null);
    setOk(null);
    try {
      const r = await importAvatarZip(mate.id, f);
      done(r.mate, r.avatar.kind);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      if (file.current) file.current.value = "";
    }
  };
  const local = async () => {
    if (!path.trim()) return;
    setBusy("local");
    setErr(null);
    setOk(null);
    try {
      const r = await importLocal({ path: path.trim(), mate_id: mate.id });
      const all = r.mates?.length ? r.mates : [r.mate];
      if (all.length > 1) {
        // a whole content folder: every character came in as its own mate
        for (const m of all) useMateStore.getState().upsert(m);
        setOk(`Imported ${all.length} mates: ${all.map((m) => m.name).join(", ")} (pick them in the switcher).`);
      } else done(r.mate, r.imported);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section title="Import" hint="A zip (an ailism-style pack with rig.json, or a Live2D model) or a folder on the server. Replaces this mate's avatar right away.">
      <div className="flex flex-wrap gap-2">
        <input ref={file} type="file" accept=".zip,application/zip" hidden onChange={(e) => e.target.files?.[0] && zip(e.target.files[0])} />
        <button className="btn-soft" onClick={() => file.current?.click()} disabled={!!busy}>
          {busy === "zip" ? <Icon name="spinner" size={14} spin /> : <Icon name="upload" size={14} />} Upload a zip
        </button>
      </div>
      <Field label="Folder on the server" hint="A Live2D model folder (*.model3.json), a folder with rig.json, or an ailism mates/<name>.json (avatar only here).">
        <div className="flex gap-2">
          <input className="field font-mono text-[12.5px]" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/model/runtime" data-testid="mate-avatar-import-path" />
          <button className="btn-soft shrink-0" onClick={local} disabled={!!busy || !path.trim()} data-testid="mate-avatar-import">
            {busy === "local" && <Icon name="spinner" size={14} spin />} Import
          </button>
        </div>
      </Field>
      <ErrorLine text={err} />
      {ok && <p className="text-[12px] text-success">{ok}</p>}
    </Section>
  );
}

function StillsEditor({ mate, rig, onChange }: { mate: Mate; rig: Rig; onChange: (r: Rig) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const up = async (name: string, f: File) => {
    setBusy(name);
    setErr(null);
    try {
      const r = await uploadAsset(mate.id, f, `stills/${name}.${extOf(f, "png")}`);
      const next: Rig = { ...rig, stills: { ...rig.stills, [name]: r.url } };
      if (name === "neutral" || !rig.home) {
        next.home = r.url;
        const size = await imageSize(f);
        if (size) next.aspect = size;
      }
      onChange(next);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = (name: string) => {
    const stills = { ...rig.stills };
    const url = stills[name];
    delete stills[name];
    onChange({ ...rig, stills, home: rig.home === url ? stills.neutral || Object.values(stills)[0] || "" : rig.home });
  };
  return (
    <Section title="Stills" hint="Pictures of the same frame: neutral is the home picture; the others show for emotions. blink / mouth_* make it blink and talk.">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {STILLS.map((n) => {
          const url = rig.stills[n];
          return (
            <div key={n} className="group relative overflow-hidden rounded-lg border border-border bg-surface/60">
              <label className="block cursor-pointer">
                <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && up(n, e.target.files[0])} />
                <div className="grid aspect-[3/4] place-items-center">
                  {busy === n ? (
                    <Icon name="spinner" size={16} spin className="text-content-faint" />
                  ) : url ? (
                    <img src={url} alt={n} className="h-full w-full object-contain" />
                  ) : (
                    <Icon name="upload" size={15} className="text-content-faint" />
                  )}
                </div>
                <div className="truncate border-t border-border px-1.5 py-0.5 text-center text-[10.5px] text-content-dim">
                  {n}
                  {rig.home === url && url ? " · home" : ""}
                </div>
              </label>
              {url && (
                <button onClick={() => remove(n)} className="absolute right-1 top-1 hidden rounded bg-black/60 p-0.5 text-white group-hover:block" aria-label={`Remove ${n}`}>
                  <Icon name="x" size={11} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <ErrorLine text={err} />
    </Section>
  );
}

/** Live2D needs the Cubism Core, installed once in Global settings: say so here while it's missing. */
function CoreNotice() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () => {
      coreStatus()
        .then((s) => alive && setInstalled(s.installed))
        .catch(() => alive && setInstalled(null));
    };
    check();
    window.addEventListener("hrh:live2d-core-installed", check);
    return () => {
      alive = false;
      window.removeEventListener("hrh:live2d-core-installed", check);
    };
  }, []);
  if (installed !== false) return null;
  return (
    <Banner
      tone="warn"
      testId="mate-core-missing"
      action={
        <button className="btn-soft !px-2.5 !py-1 text-[12px]" onClick={() => useMateStore.getState().openGlobal("live2d")} data-testid="mate-core-open-global">
          <Icon name="download" size={12} /> Install in Global settings
        </button>
      }
    >
      The Live2D runtime (Cubism Core) isn't installed yet — Live2D avatars can't be shown until it is. It's installed once, for every mate.
    </Banner>
  );
}

interface ModelInfo {
  expressions: string[];
  motions: string[];
  hitAreas: string[];
}

function useModelInfo(url: string): { info: ModelInfo | null; err: string | null } {
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setInfo(null);
    setErr(null);
    if (!url) return;
    let alive = true;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (!alive) return;
        const refs = j?.FileReferences || {};
        setInfo({
          expressions: (refs.Expressions || []).map((e: any) => String(e.Name ?? "")).filter(Boolean),
          motions: Object.keys(refs.Motions || {}),
          hitAreas: (j?.HitAreas || []).map((h: any) => String(h.Name || h.Id || "")).filter(Boolean),
        });
      })
      .catch((e) => alive && setErr(`Couldn't read the model: ${(e as Error).message}`));
    return () => {
      alive = false;
    };
  }, [url]);
  return { info, err };
}

function Live2DEditor({ live2d, onChange }: { live2d: Live2D; onChange: (l: Live2D) => void }) {
  const { info, err } = useModelInfo(live2d.model);
  const set = (patch: Partial<Live2D>) => onChange({ ...live2d, ...patch });
  const setMap = (k: "emotions" | "emotion_motions", emotion: string, value: string) => {
    const map = { ...(live2d[k] || {}) } as Record<string, string | number>;
    if (value === "") delete map[emotion];
    else map[emotion] = value;
    set({ [k]: map } as Partial<Live2D>);
  };
  const num = (v: string) => (v === "" ? undefined : Number(v));
  return (
    <Section title="Live2D model">
      <Field label="Model (*.model3.json URL)" hint="Set by an import; an asset URL of this mate.">
        <input className="field font-mono text-[12px]" value={live2d.model} onChange={(e) => set({ model: e.target.value })} />
      </Field>
      <ErrorLine text={err} />
      <div className="grid grid-cols-3 gap-2">
        <Field label="Scale">
          <input className="field" type="number" step="0.05" value={live2d.scale ?? ""} placeholder="0.85" onChange={(e) => set({ scale: num(e.target.value) })} />
        </Field>
        <Field label="Shift x">
          <input className="field" type="number" value={live2d.x ?? ""} placeholder="0" onChange={(e) => set({ x: num(e.target.value) })} />
        </Field>
        <Field label="Shift y">
          <input className="field" type="number" value={live2d.y ?? ""} placeholder="0" onChange={(e) => set({ y: num(e.target.value) })} />
        </Field>
      </div>
      <Field label="Idle motion group">
        <select className="field" value={live2d.idle_group || ""} onChange={(e) => set({ idle_group: e.target.value || undefined })}>
          <option value="">Idle (default)</option>
          {(info?.motions || []).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Field>
      <div>
        <div className="mb-1 grid grid-cols-[90px_1fr_1fr] gap-2 text-[11px] font-medium text-content-faint">
          <span>emotion</span>
          <span>expression</span>
          <span>motion</span>
        </div>
        <div className="space-y-1" data-testid="mate-l2d-map">
          {EMOTIONS.map((e) => (
            <div key={e} className="grid grid-cols-[90px_1fr_1fr] items-center gap-2">
              <span className="text-[12px] text-content-dim">{e}</span>
              <select className="field !py-1 text-[12px]" value={String(live2d.emotions?.[e] ?? "")} onChange={(ev) => setMap("emotions", e, ev.target.value)}>
                <option value="">{info?.expressions.length ? "— by name —" : "—"}</option>
                {(info?.expressions || []).map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
                {live2d.emotions?.[e] !== undefined && !info?.expressions.includes(String(live2d.emotions[e])) && (
                  <option value={String(live2d.emotions[e])}>{String(live2d.emotions[e])}</option>
                )}
              </select>
              <select className="field !py-1 text-[12px]" value={live2d.emotion_motions?.[e] ?? ""} onChange={(ev) => setMap("emotion_motions", e, ev.target.value)}>
                <option value="">—</option>
                {(info?.motions || []).map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        {info && !info.expressions.length && <p className="mt-1 text-[11.5px] text-content-faint">This model lists no expressions.</p>}
      </div>
    </Section>
  );
}
