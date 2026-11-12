/**
 * The Mate view (sidebar → Mate): switcher, avatar stage, conversation, composer, settings.
 * Two layouts (mate/layout.ts), picked in the header (자동 / 위아래 / 좌우, kept on this device):
 * - side by side, like Geny's VTuber tab — the avatar gets half the width (big, bottom-anchored, fitted whole), the
 *   conversation the other half; Mate settings and the ♥ panel open over the conversation half.
 * - stacked — the stage on top, the conversation below; the panels open below the stage, in the conversation's place,
 *   and she stays in sight. Automatic stacks a narrow or tall view (sidebar folded or not); a phone is always stacked.
 * Phone (and a very short screen): a compact (collapsible) stage, the panels full screen. While the on-screen keyboard
 * is up the stage steps aside (the header keeps her picture, name and mood) so the conversation gets the room; it
 * comes back when the keyboard goes. A change of layout keeps her body as it is (the same stage, moved).
 * The picker's New mate (and ✨ Avatar Create) open the Mate Create studio over the whole view (studio/MateStudio).
 * Her guide (guide/MateGuide) opens over it the first time the Mate view opens (once per account on this device), after
 * a mate is created in the studio, and from Mate settings' header (the phone's ⋯).
 */
import PageLoading from "../ui/Loading";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { listDrafts, type DraftSummary } from "../../api/avatar";
import { useBoxSize, usePhone, useShortScreen, useTouchFirst } from "../../lib/device";
import { LAYOUT_KEY, readLayout, SPLIT_MIN, splitFits, splitNow, type LayoutPref } from "../../mate/layout";
import { useKeyboardOpen } from "../../lib/keyboard";
import { useBackHandler } from "../../lib/back";
import { useMateStore } from "../../stores/mateStore";
import { useMateConversation } from "../../mate/useMateConversation";
import { MenuButton } from "../layout/MobileTopBar";
import Icon, { type IconName } from "../ui/Icon";
import { DropOverlay, useFileDrop } from "../composer/useFileDrop";
import MateComposer, { ReadAloudToggle } from "./MateComposer";
import MateMessages from "./MateMessages";
import MateStage, { BuiltinBadge, MateThumb, moodLabel } from "./MateStage";
import type { StageWindowKind } from "./stage/StageMenu";
import { takeMatePanelLink } from "../../lib/nav";
import { useT } from "../../i18n";
import { useStudio } from "../../stores/studioStore";
import { confirmDialog } from "../ui/ConfirmDialog";
import { sharedAuthStatus } from "../../api/admin";
import { automated, GUIDE_SEEN_KEY, guideSeen, markGuideSeen } from "../../mate/guide";

const MateSettings = lazy(() => import("./settings/MateSettings"));
const RelationPanel = lazy(() => import("./RelationPanel"));
const StatusWindow = lazy(() => import("./stage/StatusWindow"));
const PlacesWindow = lazy(() => import("./stage/PlacesWindow"));
const OutfitsWindow = lazy(() => import("./stage/OutfitsWindow"));
const MateStudio = lazy(() => import("./studio/MateStudio"));
const MateGuide = lazy(() => import("./guide/MateGuide"));

type SettingsTab = "relation" | "memory" | undefined;

const COLLAPSE_KEY = "hrh_mate_stage_collapsed";
/** stacked, below this height a panel takes the whole view (under the stage it would have too little room) */
const PANEL_UNDER_MIN = 560;

const LAYOUTS: { id: LayoutPref; icon: IconName; label: "mate.layoutAuto" | "mate.layoutStacked" | "mate.layoutSplit" }[] = [
  { id: "auto", icon: "layout-auto", label: "mate.layoutAuto" },
  { id: "stacked", icon: "layout-stacked", label: "mate.layoutStacked" },
  { id: "split", icon: "layout-split", label: "mate.layoutSplit" },
];

const readPref = (): LayoutPref => {
  try {
    return readLayout(localStorage.getItem(LAYOUT_KEY));
  } catch {
    return "auto";
  }
};

export default function MateView() {
  const t = useT();
  const mates = useMateStore((s) => s.mates);
  const loaded = useMateStore((s) => s.loaded);
  const loadError = useMateStore((s) => s.error);
  const activeId = useMateStore((s) => s.activeId);
  const load = useMateStore((s) => s.load);
  const mate = mates.find((m) => m.id === activeId) ?? mates[0] ?? null;
  // the Mate Create studio (docs/avatar-create.md §11): its own screen over the whole view — her conversation rests
  const studioOpen = useStudio((s) => s.open);
  const studioStarting = useStudio((s) => s.starting);
  const studio = studioOpen || studioStarting;
  const conv = useMateConversation(studio ? null : mate);
  // drop files on the conversation, or paste them anywhere on the page: they go to the composer
  const { dragging, dropProps } = useFileDrop(conv.sessionId);
  // the layout goes by the view's own box (beside the sidebar, folded or not), not the window's
  const [box, rootRef] = useBoxSize();
  const phoneScreen = usePhone();
  // compact: a phone, or a view too narrow for the halves side by side (the phone's header, sheets, smaller clips)
  const compact = phoneScreen || box.w < SPLIT_MIN;
  const [layoutPref, setLayoutPref] = useState<LayoutPref>(readPref);
  const wasSplit = useRef(false);
  const split = !phoneScreen && splitNow(layoutPref, box.w, box.h, wasSplit.current);
  wasSplit.current = split;
  const pickLayout = (p: LayoutPref) => {
    setLayoutPref(p);
    try {
      if (p === "auto") localStorage.removeItem(LAYOUT_KEY);
      else localStorage.setItem(LAYOUT_KEY, p);
    } catch {
      /* private mode: for this visit */
    }
  };
  const touch = useTouchFirst();
  const short = useShortScreen();
  const keyboard = useKeyboardOpen();
  // one panel slot: Mate settings or the ♥ panel (app-wide settings are Settings' own: openAppSettings)
  const [panel, setPanel] = useState<"mate" | "relation" | null>(null);
  // her menu on the stage: one window at a time, over her (a sheet on a phone)
  const [stageWindow, setStageWindow] = useState<StageWindowKind | null>(null);
  const [mateTab, setMateTab] = useState<"profile" | "avatar" | "bond" | undefined>(undefined);
  const [bondTab, setBondTab] = useState<"memory" | "relation">("relation");
  const mateOpen = panel === "mate";
  const relationOpen = panel === "relation";
  const settings = panel !== null;
  const closePanels = () => setPanel(null);
  const openMate = (tab?: SettingsTab) => {
    if (tab) {
      setBondTab(tab);
      setPanel("relation");
      return;
    }
    setMateTab("profile");
    setPanel("mate");
  };
  const toggleMate = () => {
    if (mateOpen) return setPanel(null);
    openMate();
  };
  const toggleRelation = () => {
    if (relationOpen) return setPanel(null);
    setPanel("relation");
  };
  const openWindow = (k: StageWindowKind) => setStageWindow((w) => (w === k ? null : k));
  // a link from another window: the ♥ panel, or Mate settings → 관계와 기억 (settings-relation / settings-memory)
  useEffect(() => {
    const link = takeMatePanelLink();
    if (!link) return;
    if (link.mate) useMateStore.getState().setActive(link.mate);
    if (link.panel === "relation") setPanel("relation");
    else {
      setMateTab("bond");
      setPanel("mate");
    }
  }, []);
  // Esc closes the open panel (not while typing in a field: those use Esc themselves)
  useEffect(() => {
    if (!settings) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      closePanels();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settings]);
  const [switcher, setSwitcher] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  // phones: the header keeps what is used all the time, the rest is one press away
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more) return;
    const onDown = (e: PointerEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMore(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [more]);
  // the layout menu (자동 / 위아래 / 좌우)
  const [layoutMenu, setLayoutMenu] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!layoutMenu) return;
    const onDown = (e: PointerEvent) => {
      if (!layoutRef.current?.contains(e.target as Node)) setLayoutMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setLayoutMenu(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [layoutMenu]);
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
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  useEffect(() => {
    if (switcher) listDrafts().then(setDrafts).catch(() => setDrafts([]));
  }, [switcher]);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  // compact: the stage is out of the way (hidden by the user — the ⋯ menu — or the keyboard is up)
  const stageAway = compact && (collapsed || keyboard);
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => {
    if (!info) return;
    const timer = setTimeout(() => setInfo(null), 8000);
    return () => clearTimeout(timer);
  }, [info]);
  useBackHandler(settings, closePanels);
  useBackHandler(switcher, () => setSwitcher(false));
  useBackHandler(more, () => setMore(false));
  useBackHandler(layoutMenu, () => setLayoutMenu(false));
  // the studio closed with something to say (created, discarded, imported)
  const studioNotice = useStudio((s) => s.notice);
  useEffect(() => {
    if (!studioNotice || studio) return;
    setInfo(studioNotice);
    useStudio.getState().note(null);
  }, [studioNotice, studio]);
  const startError = useStudio((s) => s.startError);
  // her guide: for which mate it is open
  const [guide, setGuide] = useState<string | null>(null);
  const guideChecked = useRef(false);
  useEffect(() => {
    if (!loaded || !mate || studio || guideChecked.current) return;
    guideChecked.current = true;
    if (automated()) return;
    const id = mate.id;
    void sharedAuthStatus()
      .then((a) => a.username || "")
      .catch(() => "")
      .then((account) => {
        try {
          const raw = localStorage.getItem(GUIDE_SEEN_KEY);
          if (guideSeen(raw, account)) return;
          localStorage.setItem(GUIDE_SEEN_KEY, markGuideSeen(raw, account));
        } catch {
          return; // (no storage: it would come back every time)
        }
        setGuide((g) => g ?? id);
      });
  }, [loaded, mate, studio]);
  // a mate just created in the studio: her guide, once the studio closed
  const guideFor = useStudio((s) => s.guideFor);
  useEffect(() => {
    if (!guideFor || studio) return;
    useStudio.getState().askGuide(null);
    if (!automated()) setGuide(guideFor);
  }, [guideFor, studio]);
  const guideMate = guide ? mates.find((m) => m.id === guide) ?? null : null;
  // (Android's Back: 나중에 할래요, like any way out of it)
  useBackHandler(!!guideMate, () => setGuide(null));
  // her affinity just opened an outfit
  const waiting = useRef<{ mate: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!mate) return;
    const items = mate.outfits?.items ?? [];
    const ids = new Set(items.filter((c) => c.locked).map((c) => c.id));
    const was = waiting.current?.mate === mate.id ? waiting.current.ids : null;
    waiting.current = { mate: mate.id, ids };
    const opened = items.find((c) => was?.has(c.id) && !c.locked);
    if (opened) setInfo(t("mate.outfitUnlocked", { name: opened.name }));
  }, [mate, t]);

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
    if (!(await confirmDialog({ body: t("mate.resetConfirm", { name: mate.name }), confirmLabel: t("mate.newConversation") }))) return;
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
  if (studio)
    return (
      <Suspense fallback={<PageLoading />}>
        <MateStudio />
      </Suspense>
    );
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
    <div className="relative z-30 flex shrink-0 items-center gap-1.5 border-b border-border/70 bg-surface/80 px-3 pt-safe backdrop-blur-xl">
      <div className="flex h-12 w-full items-center gap-1.5">
        <MenuButton />
        {/* (flex: a long name truncates instead of running under the indicator) */}
        {/* (phones: the menu takes the header's width, not this button's) */}
        <div className={`flex min-w-0 ${compact ? "" : "relative"}`} ref={switcherRef}>
          <button
            onClick={() => setSwitcher((v) => !v)}
            className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2"
            data-testid="mate-switcher"
          >
            <MateThumb mate={mate} />
            <span className="truncate text-[14.5px] font-semibold">{mate.name}</span>
            {/* (phones: no room for it next to the indicator — her picture and name open the switcher) */}
            {!compact && <Icon name="chevron-down" size={14} className="shrink-0 text-content-faint" />}
          </button>
          {switcher && (
            <>
              <div className={`absolute z-40 overflow-hidden rounded-xl border border-border bg-surface-2 shadow-float animate-fade-in ${compact ? "inset-x-3 top-[calc(100%+4px)]" : "left-0 top-11 w-80 max-w-[calc(100vw-1.5rem)]"}`} data-testid="mate-switcher-menu">
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
                      {m.id === mate.id && <Icon name="check" size={13} className="text-accent" />}
                    </button>
                  ))}
                </div>
                {drafts.length > 0 && (
                  <div className="border-t border-border/70 py-1" data-testid="mate-drafts">
                    <div className="px-3 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-content-faint">{t("studio.draftsTitle")}</div>
                    {drafts.slice(0, 4).map((d) => (
                      <button
                        key={d.project_id}
                        onClick={() => {
                          setSwitcher(false);
                          useStudio.getState().openCreate(d.mate_id);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-content-dim hover:bg-surface-3 hover:text-content"
                        data-testid="mate-draft-item"
                      >
                        <Icon name="pencil" size={12} className="shrink-0 text-content-faint" />
                        <span className="min-w-0 flex-1 truncate">{d.name || t("studio.untitled")}</span>
                        <span className="pill bg-surface-3 text-content-faint">{t("studio.draftPill")}</span>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => {
                    setSwitcher(false);
                    void useStudio.getState().startNew();
                  }}
                  className="flex w-full items-center gap-2 border-t border-border px-3 py-2.5 text-[13px] text-accent hover:bg-surface-3"
                  data-testid="mate-new"
                >
                  <Icon name="plus" size={14} />
                  <span className="min-w-0 flex-1 text-left">{t("mate.newMate")}</span>
                  <span className="text-[11px] text-content-faint">{t("studio.newMateHint")}</span>
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
        {stageAway && moodLabel(t, conv.mood) && (
          <span className="min-w-0 truncate text-[11.5px] text-content-faint" data-testid="mate-header-mood">
            {moodLabel(t, conv.mood)}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {(compact || touch) && <ReadAloudToggle mate={mate} conv={conv} className="btn-ghost !px-2.5" size={16} />}
          {!compact && (
            <>
              <button
                onClick={() => useStudio.getState().openAvatar(mate.id)}
                className="btn-ghost !px-2.5"
                title={t("avatar.openTitle", { name: mate.name })}
                aria-label={t("avatar.title")}
                data-testid="mate-avatar-create"
              >
                <Icon name="sparkles" size={15} />
                <span className="ml-1 text-[12.5px]">{t("avatar.title")}</span>
              </button>
              <button onClick={reset} disabled={resetting || conv.streaming} className="btn-ghost !px-2.5" title={t("mate.resetTitle")} data-testid="mate-reset">
                <Icon name="rotate" size={15} spin={resetting} />
              </button>
            </>
          )}
          {/* the layout: 자동 / 위아래 / 좌우 (a phone has only the one) */}
          {!phoneScreen && (
            <div ref={layoutRef} className="relative flex">
              <button
                onClick={() => setLayoutMenu((v) => !v)}
                className={`btn-ghost !px-2.5 ${layoutMenu ? "!bg-surface-3 !text-content" : ""}`}
                title={t("mate.layoutTitle")}
                aria-label={t("mate.layoutTitle")}
                aria-haspopup="menu"
                aria-expanded={layoutMenu}
                data-testid="mate-layout"
                data-pref={layoutPref}
              >
                <Icon name={LAYOUTS.find((x) => x.id === layoutPref)!.icon} size={16} />
              </button>
              {layoutMenu && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-40 w-60 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-border bg-surface-2 py-1 shadow-float animate-fade-in" role="menu" aria-label={t("mate.layoutTitle")} data-testid="mate-layout-menu">
                  {LAYOUTS.map((x) => (
                    <button
                      key={x.id}
                      role="menuitemradio"
                      aria-checked={layoutPref === x.id}
                      onClick={() => {
                        setLayoutMenu(false);
                        pickLayout(x.id);
                      }}
                      className={`flex min-h-[40px] w-full items-center gap-2.5 px-3 text-left text-[13px] hover:bg-surface-3 ${layoutPref === x.id ? "text-content" : "text-content-dim"}`}
                      data-testid={`mate-layout-${x.id}`}
                    >
                      <Icon name={x.icon} size={15} className="shrink-0 text-content-faint" />
                      <span className="min-w-0 flex-1 truncate">{t(x.label)}</span>
                      {layoutPref === x.id && <Icon name="check" size={13} className="shrink-0 text-accent" />}
                    </button>
                  ))}
                  <p className="border-t border-border/60 px-3 pb-1.5 pt-2 text-[11px] leading-relaxed text-content-faint" data-testid="mate-layout-note">
                    {layoutPref === "split" && !splitFits(box.w) ? t("mate.layoutSplitNarrow") : t("mate.layoutHint")}
                  </p>
                </div>
              )}
            </div>
          )}
          <button
            onClick={toggleRelation}
            className={`btn-ghost !px-2.5 ${relationOpen ? "!bg-surface-3 !text-content" : ""}`}
            title={t("mate.relPanelOpenTitle", { name: mate.name })}
            aria-label={t("mate.relPanelOpen")}
            aria-pressed={relationOpen}
            data-testid="mate-relation-open"
          >
            <Icon name="heart" size={16} />
          </button>
          <button
            onClick={toggleMate}
            className={`btn-ghost !px-2.5 ${mateOpen ? "!bg-surface-3 !text-content" : ""}`}
            title={t("mate.mateSettingsTitle", { name: mate.name })}
            aria-label={t("mate.mateSettings")}
            data-testid="mate-settings-open"
          >
            <Icon name="settings" size={16} />
          </button>
          {compact && (
            <div ref={moreRef} className="flex">
              <button onClick={() => setMore((v) => !v)} className={`btn-ghost !px-2.5 ${more ? "!bg-surface-3 !text-content" : ""}`} aria-label={t("mate.moreActions")} aria-expanded={more} data-testid="mate-more">
                <Icon name="more" size={16} />
              </button>
              {more && (
                <div className="absolute right-3 top-[calc(100%+4px)] z-40 w-60 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-border bg-surface-2 py-1 shadow-float animate-fade-in" role="menu" data-testid="mate-more-menu">
                  {[
                    { icon: collapsed ? "chevron-down" : "chevron-up", label: collapsed ? t("mate.showAvatar") : t("mate.hideAvatar"), run: toggleCollapsed, id: "mate-avatar-toggle" },
                    { icon: "sparkles", label: t("avatar.title"), run: () => useStudio.getState().openAvatar(mate.id), id: "mate-avatar-create" },
                    { icon: "heart", label: t("stage.status"), run: () => setStageWindow("status"), id: "mate-status-open" },
                    { icon: "rotate", label: t("mate.newConversation"), run: () => void reset(), id: "mate-reset", disabled: resetting || conv.streaming },
                    { icon: "book", label: t("guide.open"), run: () => setGuide(mate.id), id: "mate-guide-open" },
                  ].map((x) => (
                    <button
                      key={x.id}
                      role="menuitem"
                      disabled={x.disabled}
                      onClick={() => {
                        setMore(false);
                        x.run();
                      }}
                      className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left text-[13.5px] text-content hover:bg-surface-3 disabled:opacity-40"
                      data-testid={x.id}
                    >
                      <Icon name={x.icon as IconName} size={15} className="shrink-0 text-content-dim" />
                      <span className="min-w-0 flex-1 truncate">{x.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const infoLine = info && (
    <div className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-1.5 text-[12px] text-success" data-testid="mate-info">
      <Icon name="check" size={12} className="shrink-0" />
      <span className="break-words">{info}</span>
    </div>
  );
  // (a panel covers the conversation: what happened while it is open, like a value set by hand, shows over it)
  const infoOverPanel = settings && infoLine && (
    <div className="pointer-events-none absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-30 flex justify-center">
      <div className="max-w-full rounded-lg bg-surface-2 shadow-float">{infoLine}</div>
    </div>
  );

  const banners = (
    <>
      {!settings && infoLine && <div className="mx-auto mt-2 w-fit max-w-[92%]">{infoLine}</div>}
      {(conv.error || conv.connection === "reconnecting") && (
        <div className="mx-auto mt-2 w-fit rounded-full border border-warning/30 bg-surface-2 px-3 py-1 text-[11.5px] text-warning">
          {conv.error ? t("mate.cantReach", { name: mate.name, error: conv.error }) : t("mate.reconnecting")}
        </div>
      )}
      {startError && (
        <div className="mx-auto mt-2 flex w-fit max-w-[92%] items-center gap-2 rounded-lg bg-danger/10 px-3 py-1.5 text-[12px] text-danger" data-testid="mate-studio-error">
          <Icon name="warning" size={12} />
          <span className="break-words">{t("studio.startFailedWith", { error: startError })}</span>
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
      <MateMessages turns={conv.turns} compact={compact} emptyText={conv.connection === "open" ? t("mate.sayHi", { name: mate.name }) : t("common.loading")} />
      <div className={`shrink-0 px-3 pt-1 sm:px-4 ${keyboard ? "pb-2" : "pb-3"}`}>
        {/* phones: read-aloud lives in the header, the composer row is + · text · mic · send */}
        <MateComposer mate={mate} conv={conv} showVoiceToggle={!compact && !touch} />
      </div>
    </div>
  );

  const settingsPanel = settings && (
    <Suspense fallback={<PageLoading />}>
      {mateOpen ? (
        <MateSettings key={mateTab ?? ""} mate={mate} conv={conv} onClose={closePanels} initialTab={mateTab} onGuide={() => setGuide(mate.id)} />
      ) : (
        <RelationPanel
          key={bondTab}
          mate={mate}
          onClose={closePanels}
          initialTab={bondTab}
          onSettings={() => {
            setMateTab("bond");
            setPanel("mate");
          }}
        />
      )}
    </Suspense>
  );

  const guideNode = guideMate && (
    <Suspense fallback={null}>
      <MateGuide key={guideMate.id} mate={guideMate} onClose={() => setGuide(null)} />
    </Suspense>
  );

  const closeWindow = () => setStageWindow(null);
  const say = (text: string) => {
    closeWindow();
    conv.send(text);
  };
  const stageWindowNode = stageWindow && (
    <Suspense fallback={null}>
      {stageWindow === "status" ? (
        <StatusWindow
          key={mate.id}
          mate={mate}
          phone={compact}
          onClose={closeWindow}
          onSay={say}
          onRelation={() => {
            closeWindow();
            setPanel("relation");
          }}
        />
      ) : stageWindow === "places" ? (
        <PlacesWindow key={mate.id} mate={mate} phone={compact} onClose={closeWindow} onSay={say} />
      ) : (
        <OutfitsWindow
          key={mate.id}
          mate={mate}
          phone={compact}
          onClose={closeWindow}
          onManage={() => {
            closeWindow();
            setMateTab("avatar");
            setPanel("mate");
          }}
        />
      )}
    </Suspense>
  );

  // a panel takes the whole view on a phone and on a very short screen (a phone on its side keeps the stage beside the
  // conversation, but a panel needs all of its little height); elsewhere it opens where the conversation is, she stays
  const fullPanel = settings && (phoneScreen || short || (!split && box.h > 0 && box.h < PANEL_UNDER_MIN));

  return (
    <div ref={rootRef} className={`flex h-full flex-col ${compact || touch ? "touch-ui" : ""}`} data-testid="mate-view" data-layout={split ? "split" : "stacked"}>
      {/* (a panel over everything: its own title bar closes it, and Android's Back) */}
      {!fullPanel && header}
      {fullPanel ? (
        <div className="relative min-h-0 flex-1 pt-safe">
          {settingsPanel}
          {infoOverPanel}
        </div>
      ) : (
        // side by side: half avatar, half conversation (Geny's VTuber tab) · stacked: the stage on top. Either way the
        // panels cover the conversation's part. (One tree for both: a change of layout moves her stage, never remakes it.)
        <div className={`flex min-h-0 flex-1 ${split ? "" : "flex-col"}`} data-testid={split ? "mate-split" : "mate-stack"}>
          {/* (the keyboard only hides it: her body stays loaded for when it goes. Not before the view is measured: her
              body is made once, at the size it will have) */}
          {box.w > 0 && !(compact && collapsed) && (
            <MateStage
              mate={mate}
              mood={conv.mood}
              videoMood={conv.videoMood}
              react={conv.react}
              caption={conv.caption}
              size={compact ? "sm" : "lg"}
              layout={split ? "split" : "stacked"}
              className={
                split
                  ? "min-w-[300px] flex-1 basis-0 border-r border-border/60 bg-[radial-gradient(ellipse_at_50%_100%,rgb(var(--c-surface-2)/0.9),transparent_70%)] px-4 pt-4"
                  : `${phoneScreen ? "h-[36dvh]" : "h-[40dvh]"} shrink-0 border-b border-border/60 bg-gradient-to-b from-surface-2/40 to-transparent pt-1 ${keyboard ? "!hidden" : ""}`
              }
              onTap={() => conv.poke("greet")}
              onLife={() => openWindow("status")}
              menu={{ open: stageWindow, onOpen: openWindow, compact }}
              window={!compact && stageWindowNode}
            />
          )}
          <div className={`relative flex min-h-0 flex-1 ${split ? "min-w-[360px] basis-0" : "min-w-0"}`} data-testid="mate-chat-half">
            {conversation}
            {settings && (
              <div className={`absolute inset-0 z-20 bg-surface animate-fade-in ${split ? "border-l border-border" : ""}`} data-testid="mate-panel">
                {settingsPanel}
                {infoOverPanel}
              </div>
            )}
          </div>
        </div>
      )}
      {compact && stageWindowNode}
      {guideNode}
    </div>
  );
}
