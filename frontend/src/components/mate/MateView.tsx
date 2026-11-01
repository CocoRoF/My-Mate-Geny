/**
 * The Mate view (sidebar → Mate): switcher, avatar stage, conversation, composer, settings.
 * Desktop: like Geny's VTuber tab — the avatar gets half the width (big, bottom-anchored, scaled to the height), the
 * conversation the other half; Mate settings / Global settings open over the conversation half.
 * Phone: a compact (collapsible) stage on top, the conversation below, settings full screen. While the on-screen
 * keyboard is up the stage steps aside (the header keeps her picture, name and mood) so the conversation gets the
 * room; it comes back when the keyboard goes.
 */
import PageLoading from "../ui/Loading";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { importLocal } from "../../api/mates";
import { usePhone } from "../../lib/device";
import { useKeyboardOpen } from "../../lib/keyboard";
import { useBackHandler } from "../../lib/back";
import { useMateStore } from "../../stores/mateStore";
import { useMateConversation } from "../../mate/useMateConversation";
import { OPEN_GLOBAL_SETTINGS_EVENT } from "../../mate/live2dCore";
import { MenuButton } from "../layout/MobileTopBar";
import Icon from "../ui/Icon";
import { DropOverlay, useFileDrop } from "../composer/useFileDrop";
import MateComposer, { ReadAloudToggle } from "./MateComposer";
import MateMessages from "./MateMessages";
import MateStage, { BuiltinBadge, MateThumb, moodLabel } from "./MateStage";
import { useT } from "../../i18n";

const MateSettings = lazy(() => import("./settings/MateSettings"));
const GlobalSettings = lazy(() => import("./settings/GlobalSettings"));

type GlobalSection = Parameters<ReturnType<typeof useMateStore.getState>["openGlobal"]>[0];

const COLLAPSE_KEY = "hrh_mate_stage_collapsed";

export default function MateView() {
  const t = useT();
  const mates = useMateStore((s) => s.mates);
  const loaded = useMateStore((s) => s.loaded);
  const loadError = useMateStore((s) => s.error);
  const activeId = useMateStore((s) => s.activeId);
  const load = useMateStore((s) => s.load);
  const mate = mates.find((m) => m.id === activeId) ?? mates[0] ?? null;
  const conv = useMateConversation(mate);
  // drop files on the conversation, or paste them anywhere on the page: they go to the composer
  const { dragging, dropProps } = useFileDrop(conv.sessionId);
  const phone = usePhone();
  const keyboard = useKeyboardOpen();
  // one panel slot: Mate settings (local) or Global settings (the store's: Mate settings and anything else open it
  // with openGlobal(section); inside Mate settings it swaps itself for Global settings)
  const [mateOpen, setMateOpen] = useState(false);
  const globalOpen = useMateStore((s) => s.globalOpen);
  const settings = mateOpen || globalOpen;
  const closePanels = () => {
    setMateOpen(false);
    useMateStore.getState().closeGlobal();
  };
  const toggleGlobal = () => {
    const st = useMateStore.getState();
    if (st.globalOpen) st.closeGlobal();
    else st.openGlobal();
  };
  const toggleMate = () => {
    if (mateOpen && !globalOpen) return setMateOpen(false);
    useMateStore.getState().closeGlobal();
    setMateOpen(true);
  };
  // leaving the Mate view closes Global settings (it isn't shown anywhere else)
  useEffect(() => () => useMateStore.getState().closeGlobal(), []);
  // a Live2D body without its runtime (or anything else) asks for Global settings
  useEffect(() => {
    const open = (e: Event) => {
      const section = ((e as CustomEvent).detail?.section as GlobalSection) || "live2d";
      useMateStore.getState().openGlobal(section);
    };
    window.addEventListener(OPEN_GLOBAL_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_GLOBAL_SETTINGS_EVENT, open);
  }, []);
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
  // phones: the stage is out of the way (hidden by the user, or the keyboard is up)
  const stageAway = collapsed || keyboard;
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => {
    if (!info) return;
    const timer = setTimeout(() => setInfo(null), 8000);
    return () => clearTimeout(timer);
  }, [info]);
  useBackHandler(settings, closePanels);
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
    if (!window.confirm(t("mate.resetConfirm", { name: mate.name }))) return;
    setResetting(true);
    try {
      await conv.reset();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setResetting(false);
    }
  };

  if (!loaded) return <PageLoading />;
  if (!mate)
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-content-dim">
        <div>
          <p>{loadError ? t("mate.loadFailed", { error: loadError }) : t("mate.noMateYet")}</p>
          <button className="btn-soft mt-3" onClick={() => load()}>
            {t("common.retry")}
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
                      {m.is_default && <span className="pill bg-surface-3 text-content-faint">{t("mate.defaultPill")}</span>}
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
                  <Icon name="plus" size={14} /> {t("mate.newMate")}
                </button>
                <button
                  onClick={async () => {
                    setSwitcher(false);
                    try {
                      const n = await useMateStore.getState().restoreBuiltins();
                      setInfo(n ? t("mate.restoredBuiltins", { count: n }) : t("mate.builtinsAllHere"));
                    } catch (e) {
                      setNotice((e as Error).message);
                    }
                  }}
                  className="flex w-full items-center gap-2 border-t border-border/60 px-3 py-2 text-[12px] text-content-dim hover:bg-surface-3 hover:text-content"
                  data-testid="mate-restore-builtins"
                >
                  <Icon name="rotate" size={13} /> {t("mate.restoreBuiltins")}
                </button>
              </div>
            </>
          )}
        </div>
        {phone && stageAway && moodLabel(t, conv.mood) && (
          <span className="min-w-0 truncate text-[11.5px] text-content-faint" data-testid="mate-header-mood">
            {moodLabel(t, conv.mood)}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {phone && <ReadAloudToggle mate={mate} conv={conv} className="btn-ghost !px-2.5" size={16} />}
          {phone && !keyboard && (
            <button onClick={toggleCollapsed} className="btn-ghost !px-2.5" title={collapsed ? t("mate.showAvatar") : t("mate.hideAvatar")}>
              <Icon name={collapsed ? "chevron-down" : "chevron-up"} size={16} />
            </button>
          )}
          <button onClick={reset} disabled={resetting || conv.streaming} className="btn-ghost !px-2.5" title={t("mate.resetTitle")} data-testid="mate-reset">
            <Icon name="rotate" size={15} spin={resetting} />
          </button>
          <button
            onClick={toggleGlobal}
            className={`btn-ghost !px-2.5 ${globalOpen ? "!bg-surface-3 !text-content" : ""}`}
            title={t("mate.globalSettingsTitle")}
            aria-label={t("mate.globalSettings")}
            data-testid="mate-global-settings-open"
          >
            <Icon name="sliders" size={16} />
          </button>
          <button
            onClick={toggleMate}
            className={`btn-ghost !px-2.5 ${mateOpen && !globalOpen ? "!bg-surface-3 !text-content" : ""}`}
            title={t("mate.mateSettingsTitle", { name: mate.name })}
            aria-label={t("mate.mateSettings")}
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
          {conv.error ? t("mate.cantReach", { name: mate.name, error: conv.error }) : t("mate.reconnecting")}
        </div>
      )}
      {(notice || conv.voiceError) && (
        <div className="mx-auto mt-2 flex w-fit max-w-[92%] items-center gap-2 rounded-lg bg-danger/10 px-3 py-1.5 text-[12px] text-danger">
          <Icon name="warning" size={12} />
          <span className="break-words">{notice || t("mate.voiceError", { error: conv.voiceError ?? "" })}</span>
          <button onClick={() => setNotice(null)} aria-label={t("common.dismiss")} className="opacity-70 hover:opacity-100">
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
    </>
  );

  const conversation = (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" {...dropProps} data-testid="mate-conversation">
      {dragging && <DropOverlay hint={t("mate.dropHint", { name: mate.name })} />}
      {banners}
      <MateMessages turns={conv.turns} emptyText={conv.connection === "open" ? t("mate.sayHi", { name: mate.name }) : t("common.loading")} />
      <div className={`shrink-0 px-3 pt-1 sm:px-4 ${keyboard ? "pb-2" : "pb-3"}`}>
        {/* phones: read-aloud lives in the header, the composer row is + · text · mic · send */}
        <MateComposer mate={mate} conv={conv} showVoiceToggle={!phone} />
      </div>
    </div>
  );

  const settingsPanel = settings && (
    <Suspense fallback={<PageLoading />}>
      {mateOpen ? (
        // shows Global settings itself while those are open (and closes them when it goes)
        <MateSettings mate={mate} conv={conv} onClose={closePanels} />
      ) : (
        <GlobalSettings onClose={() => useMateStore.getState().closeGlobal()} />
      )}
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
            {/* (the keyboard only hides it: her body stays loaded for when it goes) */}
            {!collapsed && (
              <MateStage
                mate={mate}
                mood={conv.mood}
                react={conv.react}
                caption={conv.caption}
                size="sm"
                className={`h-[36dvh] shrink-0 border-b border-border/60 bg-gradient-to-b from-surface-2/40 to-transparent pt-1 ${keyboard ? "!hidden" : ""}`}
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
      {/* half avatar, half conversation (Geny's VTuber tab); settings cover the conversation half */}
      <div className="flex min-h-0 flex-1" data-testid="mate-split">
        <MateStage
          mate={mate}
          mood={conv.mood}
          react={conv.react}
          caption={conv.caption}
          className="min-w-[300px] flex-1 basis-0 border-r border-border/60 bg-[radial-gradient(ellipse_at_50%_100%,rgba(22,26,34,0.9),transparent_70%)] px-4 pt-4"
          onTap={() => conv.poke("greet")}
        />
        <div className="relative flex min-h-0 min-w-[360px] flex-1 basis-0" data-testid="mate-chat-half">
          {conversation}
          {settings && (
            <div className="absolute inset-0 z-20 border-l border-border bg-surface animate-fade-in" data-testid="mate-panel">
              {settingsPanel}
            </div>
          )}
        </div>
      </div>
      <NewMateDialog open={newMate} onClose={() => setNewMate(false)} onImported={setInfo} />
    </div>
  );
}

function NewMateDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (msg: string) => void }) {
  const t = useT();
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
        if (!name.trim()) throw new Error(t("mate.needName"));
        await useMateStore.getState().create(name.trim());
      } else {
        if (!path.trim()) throw new Error(t("mate.needPath"));
        const r = await importLocal({ path: path.trim() });
        const all = r.mates?.length ? r.mates : [r.mate];
        for (const m of all) useMateStore.getState().upsert(m);
        useMateStore.getState().setActive(all[0].id);
        onImported(all.length > 1 ? t("mate.importedMany", { count: all.length, names: all.map((m) => m.name).join(", ") }) : t("mate.importedOne", { name: all[0].name }));
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
      <div className="card relative w-full max-w-md p-5 animate-fade-in" role="dialog" aria-label={t("mate.newMate")}>
        <h2 className="text-[15px] font-semibold">{t("mate.newMate")}</h2>
        <div className="mt-3 flex gap-1">
          <button className="nav-tab" data-active={tab === "blank"} onClick={() => setTab("blank")}>
            {t("mate.startBlank")}
          </button>
          <button className="nav-tab" data-active={tab === "import"} onClick={() => setTab("import")}>
            {t("mate.importFromServer")}
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
              {t("mate.name")}
              <input ref={input} className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("mate.namePlaceholder")} />
            </label>
          ) : (
            <label className="block text-[12.5px] text-content-dim">
              {t("mate.importPathLabel")}
              <input
                ref={input}
                className="field mt-1 font-mono text-[12.5px]"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t("mate.importPathPlaceholder")}
                data-testid="mate-import-path"
              />
              <span className="mt-1 block text-[11.5px] text-content-faint">
                {t("mate.importPathHint")}
              </span>
            </label>
          )}
          {err && <p className="text-[12px] text-danger">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn-primary" disabled={busy} data-testid="mate-new-submit">
              {busy && <Icon name="spinner" size={14} spin />} {tab === "blank" ? t("mate.create") : t("mate.import")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
