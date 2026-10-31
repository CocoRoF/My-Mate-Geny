/**
 * The Mate view (sidebar → Mate): switcher, avatar stage, conversation, composer, settings.
 * Desktop: stage on the left, conversation on the right, settings as a side panel.
 * Phone: a compact (collapsible) stage on top, the conversation below, settings full screen.
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { importLocal } from "../../api/mates";
import { usePhone } from "../../lib/device";
import { useBackHandler } from "../../lib/back";
import { useMateStore } from "../../stores/mateStore";
import { useMateConversation } from "../../mate/useMateConversation";
import { MenuButton } from "../layout/MobileTopBar";
import Icon from "../ui/Icon";
import MateComposer from "./MateComposer";
import MateMessages from "./MateMessages";
import MateStage, { BuiltinBadge, MateThumb, MOOD_LABEL } from "./MateStage";

const MateSettings = lazy(() => import("./settings/MateSettings"));

const COLLAPSE_KEY = "hrh_mate_stage_collapsed";

export default function MateView() {
  const mates = useMateStore((s) => s.mates);
  const loaded = useMateStore((s) => s.loaded);
  const loadError = useMateStore((s) => s.error);
  const activeId = useMateStore((s) => s.activeId);
  const load = useMateStore((s) => s.load);
  const mate = mates.find((m) => m.id === activeId) ?? mates[0] ?? null;
  const conv = useMateConversation(mate);
  const phone = usePhone();
  const [settings, setSettings] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  // a press anywhere outside the switcher closes it (a fixed backdrop would be
  // clipped to the header: backdrop-filter makes it the containing block)
  useEffect(() => {
    if (!switcher) return;
    const onDown = (e: PointerEvent) => {
      if (!switcherRef.current?.contains(e.target as Node)) setSwitcher(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSwitcher(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [switcher]);
  const [newMate, setNewMate] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => setInfo(null), 8000);
    return () => clearTimeout(t);
  }, [info]);
  useBackHandler(settings, () => setSettings(false));
  useBackHandler(switcher || newMate, () => {
    setSwitcher(false);
    setNewMate(false);
  });

  useEffect(() => {
    load();
  }, [load]);

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      localStorage.setItem(COLLAPSE_KEY, v ? "0" : "1");
      return !v;
    });
  };

  const reset = async () => {
    if (!mate || resetting) return;
    if (!window.confirm(`Start a fresh conversation with ${mate.name}? The messages stay here, but ${mate.name} won't remember them (memories are kept).`)) return;
    setResetting(true);
    try {
      await conv.reset();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setResetting(false);
    }
  };

  if (!loaded) return <div className="grid h-full place-items-center text-sm text-content-faint">Loading…</div>;
  if (!mate)
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-content-dim">
        <div>
          <p>{loadError ? `Couldn't load your mates: ${loadError}` : "No mate yet."}</p>
          <button className="btn-soft mt-3" onClick={() => load()}>
            Retry
          </button>
        </div>
      </div>
    );

  const header = (
    <div className={`relative z-30 flex shrink-0 items-center gap-1.5 border-b border-border/70 bg-surface/80 backdrop-blur-xl px-3 ${phone ? "pt-safe" : ""}`}>
      <div className="flex h-12 w-full items-center gap-1.5">
        <MenuButton />
        <div className="relative min-w-0" ref={switcherRef}>
          <button
            onClick={() => setSwitcher((v) => !v)}
            className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2"
            data-testid="mate-switcher"
          >
            <MateThumb mate={mate} />
            <span className="truncate text-[14.5px] font-semibold">{mate.name}</span>
            <Icon name="chevron-down" size={14} className="shrink-0 text-content-faint" />
          </button>
          {switcher && (
            <>
              <div className="absolute left-0 top-11 z-40 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-border bg-surface-2 shadow-float animate-fade-in" data-testid="mate-switcher-menu">
                <div className="max-h-72 overflow-y-auto py-1">
                  {mates.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        useMateStore.getState().setActive(m.id);
                        setSwitcher(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-surface-3 ${m.id === mate.id ? "text-content" : "text-content-dim"}`}
                      data-testid="mate-switcher-item"
                    >
                      <MateThumb mate={m} className="h-6 w-6" />
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      <BuiltinBadge mate={m} />
                      {m.is_default && <span className="pill bg-surface-3 text-content-faint">default</span>}
                      {m.id === mate.id && <Icon name="check" size={13} className="text-accent" />}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => {
                    setSwitcher(false);
                    setNewMate(true);
                  }}
                  className="flex w-full items-center gap-2 border-t border-border px-3 py-2.5 text-[13px] text-accent hover:bg-surface-3"
                  data-testid="mate-new"
                >
                  <Icon name="plus" size={14} /> New mate
                </button>
                <button
                  onClick={async () => {
                    setSwitcher(false);
                    try {
                      const n = await useMateStore.getState().restoreBuiltins();
                      setInfo(n ? `Restored ${n} built-in mate${n === 1 ? "" : "s"}` : "All built-in mates are already here");
                    } catch (e) {
                      setNotice((e as Error).message);
                    }
                  }}
                  className="flex w-full items-center gap-2 border-t border-border/60 px-3 py-2 text-[12px] text-content-dim hover:bg-surface-3 hover:text-content"
                  data-testid="mate-restore-builtins"
                >
                  <Icon name="rotate" size={13} /> Restore built-in mates
                </button>
              </div>
            </>
          )}
        </div>
        {phone && collapsed && MOOD_LABEL[conv.mood] && <span className="truncate text-[11.5px] text-content-faint">{MOOD_LABEL[conv.mood]}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          {phone && (
            <button onClick={toggleCollapsed} className="btn-ghost !px-2.5" title={collapsed ? "Show the avatar" : "Hide the avatar"}>
              <Icon name={collapsed ? "chevron-down" : "chevron-up"} size={16} />
            </button>
          )}
          <button onClick={reset} disabled={resetting || conv.streaming} className="btn-ghost !px-2.5" title="New conversation (she forgets the chat above; memories stay)" data-testid="mate-reset">
            <Icon name="rotate" size={15} spin={resetting} />
          </button>
          <button
            onClick={() => setSettings((v) => !v)}
            className={`btn-ghost !px-2.5 ${settings ? "!bg-surface-3 !text-content" : ""}`}
            title="Mate settings"
            data-testid="mate-settings-open"
          >
            <Icon name="settings" size={16} />
          </button>
        </div>
      </div>
    </div>
  );

  const banners = (
    <>
      {info && (
        <div className="mx-auto mt-2 flex w-fit max-w-[92%] items-center gap-2 rounded-lg bg-success/10 px-3 py-1.5 text-[12px] text-success" data-testid="mate-info">
          <Icon name="check" size={12} />
          <span className="break-words">{info}</span>
        </div>
      )}
      {(conv.error || conv.connection === "reconnecting") && (
        <div className="mx-auto mt-2 w-fit rounded-full border border-warning/30 bg-surface-2 px-3 py-1 text-[11.5px] text-warning">
          {conv.error ? `Can't reach ${mate.name}: ${conv.error}` : "Reconnecting…"}
        </div>
      )}
      {(notice || conv.voiceError) && (
        <div className="mx-auto mt-2 flex w-fit max-w-[92%] items-center gap-2 rounded-lg bg-danger/10 px-3 py-1.5 text-[12px] text-danger">
          <Icon name="warning" size={12} />
          <span className="break-words">{notice || `Voice: ${conv.voiceError}`}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
    </>
  );

  const conversation = (
    <div className="flex min-h-0 min-w-[280px] flex-1 flex-col">
      {banners}
      <MateMessages turns={conv.turns} emptyText={conv.connection === "open" ? `Say hi to ${mate.name}.` : "Loading…"} />
      <div className="shrink-0 px-3 pb-3 pt-1 sm:px-4">
        <MateComposer mate={mate} conv={conv} />
      </div>
    </div>
  );

  const settingsPanel = settings && (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-content-faint">Loading…</div>}>
      <MateSettings mate={mate} conv={conv} onClose={() => setSettings(false)} />
    </Suspense>
  );

  if (phone) {
    return (
      <div className="flex h-full flex-col" data-testid="mate-view">
        {header}
        {settings ? (
          <div className="min-h-0 flex-1">{settingsPanel}</div>
        ) : (
          <>
            {!collapsed && (
              <MateStage
                mate={mate}
                mood={conv.mood}
                react={conv.react}
                caption={conv.caption}
                size="sm"
                className="h-[32dvh] shrink-0 border-b border-border/60 bg-gradient-to-b from-surface-2/40 to-transparent"
                onTap={() => conv.poke("greet")}
              />
            )}
            {conversation}
          </>
        )}
        <NewMateDialog open={newMate} onClose={() => setNewMate(false)} onImported={setInfo} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="mate-view">
      {header}
      <div className="flex min-h-0 flex-1">
        <MateStage
          mate={mate}
          mood={conv.mood}
          react={conv.react}
          caption={conv.caption}
          className={`w-[38%] min-w-[260px] max-w-[440px] shrink-0 border-r ${settings ? "hidden min-[1440px]:flex" : ""} border-border/60 bg-gradient-to-b from-surface-2/40 to-transparent pt-4`}
          onTap={() => conv.poke("greet")}
        />
        {conversation}
        {settings && (
          <div className="w-[min(540px,50vw)] shrink-0 border-l border-border bg-surface/95 animate-fade-in">{settingsPanel}</div>
        )}
      </div>
      <NewMateDialog open={newMate} onClose={() => setNewMate(false)} onImported={setInfo} />
    </div>
  );
}

function NewMateDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (msg: string) => void }) {
  const [tab, setTab] = useState<"blank" | "import">("blank");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setErr(null);
      setTimeout(() => input.current?.focus(), 30);
    }
  }, [open, tab]);
  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (tab === "blank") {
        if (!name.trim()) throw new Error("Give your mate a name");
        await useMateStore.getState().create(name.trim());
      } else {
        if (!path.trim()) throw new Error("Enter a folder or file path on the server");
        const r = await importLocal({ path: path.trim() });
        const all = r.mates?.length ? r.mates : [r.mate];
        for (const m of all) useMateStore.getState().upsert(m);
        useMateStore.getState().setActive(all[0].id);
        onImported(all.length > 1 ? `Imported ${all.length} mates: ${all.map((m) => m.name).join(", ")}` : `Imported ${all[0].name}`);
      }
      setName("");
      setPath("");
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/55 animate-fade-in" onClick={onClose} />
      <div className="card relative w-full max-w-md p-5 animate-fade-in" role="dialog" aria-label="New mate">
        <h2 className="text-[15px] font-semibold">New mate</h2>
        <div className="mt-3 flex gap-1">
          <button className="nav-tab" data-active={tab === "blank"} onClick={() => setTab("blank")}>
            Start blank
          </button>
          <button className="nav-tab" data-active={tab === "import"} onClick={() => setTab("import")}>
            Import from the server
          </button>
        </div>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {tab === "blank" ? (
            <label className="block text-[12.5px] text-content-dim">
              Name
              <input ref={input} className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Geny" />
            </label>
          ) : (
            <label className="block text-[12.5px] text-content-dim">
              Folder or file on this server
              <input
                ref={input}
                className="field mt-1 font-mono text-[12.5px]"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/path/to/content/mates/estelle.json  or a Live2D model folder"
                data-testid="mate-import-path"
              />
              <span className="mt-1 block text-[11.5px] text-content-faint">
                An ailism content folder (every character in it, with voices), one mates/&lt;name&gt;.json, a folder with rig.json, or a Live2D model folder (*.model3.json). Re-importing updates the mate with the same name.
              </span>
            </label>
          )}
          {err && <p className="text-[12px] text-danger">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={busy} data-testid="mate-new-submit">
              {busy && <Icon name="spinner" size={14} spin />} {tab === "blank" ? "Create" : "Import"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
