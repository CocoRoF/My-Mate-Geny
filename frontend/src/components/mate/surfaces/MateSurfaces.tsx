import { useReplySpeech } from "../../../mate/useReplySpeech";
import { toast } from "../../../lib/toast";
/**
 * Full-page Mate surfaces for the desktop app's windows (docs/mate.md §6–7), no console chrome:
 *   ?surface=mate-overlay&mate=<id>  the avatar + caption bubble on a transparent page; plays the voice; pan / zoom
 *                                    the avatar when it takes the mouse; move mode: move bar + resize frame
 *   ?surface=mate-quick&mate=<id>    a one-line card (draggable, fixed width, grows downwards): Enter sends, then it
 *                                    closes (the reply shows by the avatar); a draft keeps it open (✕ closes)
 *   ?surface=mate-chat&mate=<id>     a compact conversation window
 * They all attach to the same mate session (useMateConversation), so every window stays in sync.
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_OUTFIT, type Mate } from "../../../api/mates";
import { useSessionSync } from "../../../hooks/useSessionSync";
import { useConfigStore } from "../../../stores/configStore";
import { useMateStore } from "../../../stores/mateStore";
import { desktopMate, useDesktopMate, type DesktopCommand, type DesktopMateState } from "../../../mate/desktop";
import { useMateConversation } from "../../../mate/useMateConversation";
import { parseEmotionText } from "../../../mate/emotion";
import { plainText } from "../../../mate/markdown";
import MateReply from "../MateReply";
import { LiveMateAvatar } from "../../../mate/avatar/MateAvatar";
import { isHome, useAvatarView } from "../../../mate/avatar/view";
import Icon from "../../ui/Icon";
import { WindowControls } from "../../layout/TitleBar";
import { nativeWindow } from "../../../lib/nativeWindow";
import { DropOverlay, useFileDrop } from "../../composer/useFileDrop";
import MateComposer from "../MateComposer";
import MateMessages from "../MateMessages";
import { MateThumb, moodLabel, useFadingCaption } from "../MateStage";
import RelationBadge from "../RelationBadge";
import StateBadge from "../StateBadge";
import { useT } from "../../../i18n";

const RelationPanel = lazy(() => import("../RelationPanel"));

type Kind = "mate-overlay" | "mate-quick" | "mate-chat";

/** the mate this window shows: ?mate=, then the desktop's choice, then the default */
function useSurfaceMate(onCommand?: (cmd: DesktopCommand) => void): { mate: Mate | null; loaded: boolean; desk: DesktopMateState | null } {
  const mates = useMateStore((s) => s.mates);
  const loaded = useMateStore((s) => s.loaded);
  const [wanted] = useState(() => new URLSearchParams(window.location.search).get("mate"));
  const desk = useDesktopMate(onCommand);
  useEffect(() => {
    useMateStore.getState().load();
  }, []);
  const id = desk?.mateId || wanted;
  const mate = mates.find((m) => m.id === id) ?? mates.find((m) => m.is_default) ?? mates[0] ?? null;
  return { mate, loaded, desk };
}

/** the change in screen position since the last event of a press (screen-based: the window moving under the pointer
 *  while it drags / resizes that window does not feed back) */
function pressDeltas(e: { screenX: number; screenY: number }, onDelta: (dx: number, dy: number) => void, onEnd: () => void) {
  let lx = e.screenX;
  let ly = e.screenY;
  const move = (ev: PointerEvent | MouseEvent) => {
    const dx = ev.screenX - lx;
    const dy = ev.screenY - ly;
    lx = ev.screenX;
    ly = ev.screenY;
    if (dx || dy) onDelta(dx, dy);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    window.removeEventListener("blur", up);
    onEnd();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  window.addEventListener("blur", up);
}

export default function MateSurface({ kind }: { kind: Kind }) {
  // mates changed elsewhere (settings in the console, another device): this window follows (no stale volume, avatar…)
  useSessionSync({ sessions: false });
  if (kind === "mate-overlay") return <Overlay />;
  if (kind === "mate-quick") return <Quick />;
  return <ChatWindow />;
}

// ── overlay ─────────────────────────────────────────────────────────────

function Overlay() {
  const t = useT();
  const [moveMode, setMoveMode] = useState(false);
  const [sizeKey, setSizeKey] = useState(0);
  const resetRef = useRef<() => void>(() => {});
  const speechCommand = useRef<(cmd: DesktopCommand) => void>(() => {});
  const onCommand = useCallback((cmd: DesktopCommand) => {
    if (cmd.type === "reply-speech") speechCommand.current(cmd);
    if (cmd.type === "move-mode") setMoveMode(!!cmd.on);
    if (cmd.type === "state" && typeof cmd.moveMode === "boolean") setMoveMode(cmd.moveMode);
    if (cmd.type === "reset-view") resetRef.current(); // tray → Reset Mate position & size
  }, []);
  const { mate, desk } = useSurfaceMate(onCommand);
  const conv = useMateConversation(mate);
  const speech = useReplySpeech(mate);
  speechCommand.current = (cmd) => {
    if (cmd.mateId === mate?.id && typeof cmd.on === "boolean") void speech.setEnabled(cmd.on);
  };
  useEffect(() => {
    desktopMate()?.voiceState?.(mate ? { mateId: mate.id, enabled: speech.enabled, available: speech.available, busy: speech.busy } : null);
  }, [mate?.id, speech.enabled, speech.available, speech.busy]);
  useEffect(() => () => desktopMate()?.voiceState?.(null), []);
  useEffect(() => { if (speech.error) toast(speech.error, 4000); }, [speech.error]);
  const caption = useFadingCaption(conv.caption, 7000);
  const live = useLiveLine(conv);
  const line = caption || live;
  const bridge = desktopMate();

  // This page draws its own move UI (bar = move the window, avatar = pan / zoom, edges = resize), so the desktop app
  // must not turn the whole page into a drag area in move mode (desktop/src/mate.js DRAG_CSS).
  useEffect(() => {
    document.documentElement.dataset.hrhOwnMove = "1";
  }, []);

  // The avatar takes the mouse when the window does: click-through off, or move mode (Geny: unlocked). Then a drag
  // pans her inside the window, the wheel zooms, a tap still pokes her — per mate, remembered (Geny's viewStorageKey).
  const interactive = moveMode || (desk ? !desk.clickThrough : true);
  const area = useRef<HTMLDivElement>(null);
  const { view, reset, dragging } = useAvatarView(area, mate ? `hrh.mate.view.${mate.id}` : null, interactive);
  resetRef.current = () => {
    reset();
    setSizeKey((k) => k + 1);
  };

  // the window's size follows the avatar's shape (bottom-right corner stays put); a size the user set wins (desktop)
  const aspect = mate ? aspectOf(mate) : 0.75;
  useEffect(() => {
    if (!mate) return;
    const h = 400;
    const w = Math.max(220, Math.min(420, Math.round((h - 40) * aspect)));
    desktopMate()?.setAvatarSize(w, h);
  }, [mate?.id, aspect, sizeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mate) return null; // signed out / not loaded: nothing on the screen
  const canResize = !!bridge?.resizeBy;
  return (
    <div
      className="group relative h-full w-full select-none overflow-hidden"
      data-testid="mate-overlay"
      data-mood={conv.mood}
      data-interactive={interactive ? "true" : "false"}
      data-voice-volume={conv.volume}
      data-speaks={conv.speaks ? "true" : "false"}
      data-view={`${view.x.toFixed(4)},${view.y.toFixed(4)},${view.z.toFixed(4)}`}
    >
      {line && (
        <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex justify-center">
          <div
            key={line}
            className="max-h-[38%] max-w-full overflow-hidden rounded-2xl border border-glass-line bg-glass/90 px-3 py-1.5 text-center text-[13px] leading-snug text-content shadow-float animate-fade-in"
            data-testid="mate-caption"
          >
            {line}
          </div>
        </div>
      )}
      <div
        ref={area}
        className="absolute inset-x-0 bottom-0 top-10"
        style={interactive ? { cursor: dragging ? "grabbing" : "grab", touchAction: "none" } : undefined}
        data-testid="mate-avatar-area"
      >
        <LiveMateAvatar key={mate.id} mate={mate} mood={conv.mood} videoMood={conv.videoMood} react={conv.react} onTap={() => conv.poke("greet")} view={view} />
      </div>
      {interactive && !moveMode && !isHome(view) && (
        <button
          className="absolute right-1.5 top-1.5 z-20 grid h-6 w-6 place-items-center rounded-full border border-glass-line bg-glass/85 text-content-dim opacity-0 shadow-float transition hover:text-content group-hover:opacity-100"
          onClick={reset}
          title={t("mate.resetViewTitle")}
          data-no-drag
          data-testid="mate-view-reset"
        >
          <Icon name="refresh" size={12} />
        </button>
      )}
      {moveMode && canResize && <ResizeFrame />}
      {moveMode && <MoveBar onReset={reset} canReset={!isHome(view)} />}
    </div>
  );
}

/** Move mode's bar (top of the window: the desktop's action bar sits at the bottom). Its background is the window's
 *  move handle (moveBy, like Geny's dock bar); the avatar below pans, the edges resize. */
function MoveBar({ onReset, canReset }: { onReset: () => void; canReset: boolean }) {
  const t = useT();
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const m = desktopMate();
    if (!m) return;
    pressDeltas(e, (dx, dy) => m.moveBy(dx, dy), () => m.moveEnd());
  };
  return (
    // (the full-width row lets the pointer through: the frame's top corners / edge are under it)
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-5">
      <div
        className="pointer-events-auto flex max-w-full cursor-move items-center gap-1.5 rounded-full border border-accent/40 bg-glass/95 py-1 pl-2.5 pr-1 text-[12px] text-content shadow-float"
        onPointerDown={onDown}
        data-no-drag
        data-no-pan
        title={t("mate.moveBarTitle")}
        data-testid="mate-move-bar"
      >
        <Icon name="move" size={13} className="shrink-0 text-accent" />
        <span className="truncate">{t("mate.move")}</span>
        <button
          className="rounded-full px-2 py-0.5 text-content-dim hover:bg-surface-3 hover:text-content disabled:opacity-40"
          onClick={onReset}
          disabled={!canReset}
          title={t("mate.resetViewBack")}
          data-testid="mate-view-reset-move"
        >
          {t("mate.resetView")}
        </button>
        <button className="rounded-full bg-accent px-2.5 py-0.5 font-medium text-white" onClick={() => desktopMate()?.setMoveMode(false)} data-testid="mate-move-done">
          {t("common.done")}
        </button>
      </div>
    </div>
  );
}

// Geny's overlay resize frame: a dashed outline + 8 edge / corner handles; a handle's drag resizes the window from
// that edge (desktop/src/mate.js resizeBy), the size is kept per mate. Only the handles take the pointer.
const RESIZE_HANDLES: { edge: string; cls: string; cursor: string }[] = [
  { edge: "n", cls: "left-4 right-4 top-0 h-2", cursor: "ns-resize" },
  { edge: "s", cls: "bottom-0 left-4 right-4 h-2", cursor: "ns-resize" },
  { edge: "w", cls: "bottom-4 left-0 top-4 w-2", cursor: "ew-resize" },
  { edge: "e", cls: "bottom-4 right-0 top-4 w-2", cursor: "ew-resize" },
  { edge: "nw", cls: "left-0 top-0 h-4 w-4", cursor: "nwse-resize" },
  { edge: "ne", cls: "right-0 top-0 h-4 w-4", cursor: "nesw-resize" },
  { edge: "sw", cls: "bottom-0 left-0 h-4 w-4", cursor: "nesw-resize" },
  { edge: "se", cls: "bottom-0 right-0 h-4 w-4", cursor: "nwse-resize" },
];

function ResizeFrame() {
  const start = (edge: string) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const m = desktopMate();
    if (!m?.resizeBy) return;
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* optional */
    }
    pressDeltas(e, (dx, dy) => m.resizeBy!(edge, dx, dy), () => m.resizeEnd?.());
  };
  return (
    <div className="pointer-events-none absolute inset-0 z-20 rounded-md border-2 border-dashed border-accent/80 bg-accent/5" data-testid="mate-resize-frame">
      {RESIZE_HANDLES.map((h) => (
        <div
          key={h.edge}
          className={`pointer-events-auto absolute ${h.cls}`}
          style={{ cursor: h.cursor }}
          onPointerDown={start(h.edge)}
          data-no-drag
          data-no-pan
          data-edge={h.edge}
          data-testid={`mate-resize-${h.edge}`}
        />
      ))}
      <span className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 rounded-br-sm border-b-2 border-r-2 border-accent" />
    </div>
  );
}

/** the shape of her default set: what she has on stands in it, so a change of clothes doesn't change the window */
function aspectOf(mate: Mate): number {
  const base = mate.outfits?.items.find((c) => c.id === DEFAULT_OUTFIT);
  if (base && base.kind !== "none" && base.kind !== "live2d" && base.aspect?.[0] > 0 && base.aspect?.[1] > 0) return base.aspect[0] / base.aspect[1];
  const a = mate.avatar;
  if ((a.kind === "video" || a.kind === "photo") && a.rig.aspect?.[0] > 0 && a.rig.aspect?.[1] > 0) return a.rig.aspect[0] / a.rig.aspect[1];
  return 0.75;
}

/** while she writes and nothing is spoken yet: the sentence being written (tags and markdown hidden), short */
function useLiveLine(conv: ReturnType<typeof useMateConversation>): string | null {
  if (conv.speaks || !conv.streaming) return null;
  const last = conv.turns[conv.turns.length - 1];
  if (!last || last.role !== "assistant" || last.complete) return null;
  // (plain words: no markdown symbols, no code)
  const text = plainText(parseEmotionText(last.text, { streaming: true }).text).trim();
  const lines = text.split("\n").filter((l) => l.trim());
  const l = lines[lines.length - 1] || "";
  return l ? (l.length > 140 ? "…" + l.slice(-139) : l) : null;
}

// ── quick card ──────────────────────────────────────────────────────────

const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
const DRAG = { WebkitAppRegion: "drag" } as React.CSSProperties;

function Quick() {
  const t = useT();
  const [focusKey, setFocusKey] = useState(1);
  const onCommand = useCallback((cmd: DesktopCommand) => {
    // (the draft stays: what was typed before a click elsewhere / Esc is there again)
    if (cmd.type === "quick-open") setFocusKey((k) => k + 1);
    else if (cmd.type === "quick-close") (document.activeElement as HTMLElement | null)?.blur?.();
  }, []);
  const { mate, loaded, desk } = useSurfaceMate(onCommand);
  const conv = useMateConversation(mate, { voice: false });
  const { dragging, dropProps } = useFileDrop(conv.sessionId);
  const card = useRef<HTMLDivElement>(null);
  const [sentAt, setSentAt] = useState(0);

  // Something written (text or files): a click elsewhere must not close the card and lose the user's place — it
  // stays, with an ✕ in its corner; ✕, Esc or sending closes it. Empty: it goes when focus leaves (a launcher).
  const [hasDraft, setHasDraft] = useState(false);
  const onContentChange = useCallback((has: boolean) => {
    setHasDraft(has);
    desktopMate()?.setQuickPinned?.(has);
  }, []);

  // The window follows the card's HEIGHT only (project-geny-app / Geny): a fixed width, the top edge fixed, the box
  // grows line by line up to its cap, then scrolls inside. (Reporting the width too fed back: a page that grew a
  // scrollbar measured a narrower card, the window shrank to it, and every new line made the card narrower.)
  useLayoutEffect(() => {
    const el = card.current;
    const m = desktopMate();
    if (!el || !m) return;
    let last = 0;
    const fit = () => {
      const h = Math.max(56, Math.min(640, Math.ceil(el.getBoundingClientRect().height) + 16)); // + the page's p-2
      if (h === last) return;
      last = h;
      m.setSize(window.innerWidth, h);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mate?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && desktopMate()?.closeQuick();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!mate) return loaded ? <div className="p-3 text-[12px] text-content-faint">{t("mate.noMate")}</div> : null;
  // the overlay shows the reply; without it (or in a browser), the card shows it itself
  const overlayOut = !!desk?.visible;
  const last = conv.turns[conv.turns.length - 1];
  const replying = !overlayOut && !!sentAt && last?.role === "assistant";
  const reply = replying ? parseEmotionText(last.text, { streaming: !last.complete }).text.trim() : "";

  return (
    <div className="p-2" data-testid="mate-quick" data-pinned={hasDraft ? "true" : "false"}>
      {/* The card is the window's drag handle (frameless window: -webkit-app-region, like Geny's quick bar); the
          composer, the reply and the ✕ are not. Where it is dropped is where it opens next time. */}
      <div
        ref={card}
        className="relative w-full rounded-2xl border border-border bg-glass-deep/95 p-2 shadow-float backdrop-blur-xl"
        style={DRAG}
        data-testid="mate-quick-card"
        {...dropProps}
      >
        {dragging && <DropOverlay compact hint={t("mate.dropFor", { name: mate.name })} />}
        {hasDraft && desktopMate() && (
          <button
            className="absolute -right-1.5 -top-1.5 z-10 grid h-5 w-5 place-items-center rounded-full border border-border bg-surface-3 text-content-dim shadow-float transition hover:bg-border-strong hover:text-content"
            style={NO_DRAG}
            onClick={() => void desktopMate()?.closeQuick()}
            title={t("mate.closeDraftStays")}
            aria-label={t("common.close")}
            data-testid="mate-quick-close"
          >
            <Icon name="x" size={11} />
          </button>
        )}
        <div className="flex items-end gap-2">
          {/* as tall as the one-line composer (42 px), so she sits level with the input row */}
          <div className="flex h-[42px] shrink-0 cursor-move items-center" title={t("mate.dragToMove")} data-testid="mate-quick-handle">
            <MateThumb mate={mate} className="h-8 w-8" />
          </div>
          <div className="min-w-0 flex-1" style={NO_DRAG}>
            <MateComposer
              growsWindow
              onContentChange={onContentChange}
              mate={mate}
              conv={conv}
              compact
              enterSends
              autoFocus
              focusKey={focusKey}
              showVoiceToggle={false}
              escapeStops={false}
              attachDirect
              placeholder={t("mate.askPlaceholder", { name: mate.name })}
              onSent={() => {
                setSentAt(Date.now());
                if (desktopMate() && overlayOut) void desktopMate()!.closeQuick();
              }}
            />
          </div>
        </div>
        {(reply || (sentAt > 0 && !overlayOut && conv.streaming)) && (
          <div className="mt-2 flex max-h-48 flex-col gap-1.5 overflow-y-auto overflow-x-hidden rounded-xl bg-surface-2/80 px-3 py-2 text-[13px] text-content" style={NO_DRAG} data-testid="mate-quick-reply">
            {reply ? (
              <MateReply text={last!.text} streaming={!last!.complete} compact bare />
            ) : (
              <span className="text-content-faint">{moodLabel(t, "thinking")}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── chat window ─────────────────────────────────────────────────────────

function ChatWindow() {
  const t = useT();
  const { mate, loaded } = useSurfaceMate();
  const desk = useDesktopMate();
  const conv = useMateConversation(mate);
  const { dragging, dropProps } = useFileDrop(conv.sessionId);
  // the Relationship panel, over the conversation (♥ in the title bar, or the indicator); Esc closes it
  const [relOpen, setRelOpen] = useState(false);
  useEffect(() => {
    if (!relOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== "Escape" || e.defaultPrevented || (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      setRelOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [relOpen]);
  const loadConfig = useConfigStore((s) => s.load);
  useEffect(() => {
    loadConfig().catch(() => {});
  }, [loadConfig]);
  // the desktop app without a system title bar: this header is the window's title bar (drag, min / max / close)
  const win = nativeWindow();
  const mac = win?.chrome === "mac";
  if (!mate) {
    return (
      <div className="relative flex h-full flex-col bg-bg">
        {win && <div className="h-[52px] shrink-0 border-b border-border/60 bg-surface/90" style={DRAG} />}
        <div className="grid flex-1 place-items-center" data-testid="surface-loading">
          {loaded ? (
            <span className="text-sm text-content-faint">{t("mate.noMate")}</span>
          ) : (
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent/25 border-t-accent" />
          )}
        </div>
        {win && <WindowControls w={win} height={51} className="absolute right-0 top-0" />}
      </div>
    );
  }
  const onTop = !!desk?.chatOnTop;
  const online = conv.connection === "open";
  const status = moodLabel(t, conv.mood) || (online ? t("mate.statusHere") : t("mate.statusConnecting"));
  const iconBtn = "grid h-8 w-8 place-items-center rounded-lg text-content-dim transition hover:bg-surface-3 hover:text-content";
  return (
    <div className="relative flex h-full flex-col bg-bg" data-testid="mate-chat-window" data-chrome={win ? win.chrome : "none"} {...dropProps}>
      {dragging && <DropOverlay compact hint={t("mate.dropHintShort", { name: mate.name })} />}
      <header
        className={`flex h-[52px] shrink-0 select-none items-center gap-2.5 border-b border-border/60 bg-surface/90 backdrop-blur-xl ${
          mac ? "pl-[78px]" : "pl-3"
        } ${win && !mac ? "pr-0" : "pr-2"}`}
        style={win ? DRAG : undefined}
        data-testid="mate-chat-header"
      >
        <div className="relative h-10 w-9 shrink-0 overflow-hidden rounded-xl bg-surface-2 ring-1 ring-border/80">
          <LiveMateAvatar key={mate.id} mate={mate} size="sm" mood={conv.mood} videoMood={conv.videoMood} react={conv.react} interactive={false} />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate text-[13.5px] font-semibold text-content">{mate.name}</span>
            <RelationBadge mate={mate} compact onClick={() => setRelOpen((v) => !v)} active={relOpen} />
            <StateBadge mate={mate} compact onClick={() => setRelOpen((v) => !v)} />
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-content-faint" data-testid="mate-chat-status">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${online ? (conv.mood === "idle" ? "bg-success" : "bg-accent animate-pulse-dot") : "bg-content-faint"}`}
            />
            <span className="truncate">{status}</span>
          </div>
        </div>
        <button
          className={`${iconBtn} shrink-0 ${relOpen ? "bg-surface-3 !text-content" : ""}`}
          style={win ? NO_DRAG : undefined}
          onClick={() => setRelOpen((v) => !v)}
          title={t("mate.relPanelOpenTitle", { name: mate.name })}
          aria-label={t("mate.relPanelOpen")}
          aria-pressed={relOpen}
          data-testid="mate-chat-relation"
        >
          <Icon name="heart" size={14} />
        </button>
        {desktopMate() && (
          <div className="-ml-2 flex shrink-0 items-center gap-0.5" style={win ? NO_DRAG : undefined}>
            <button
              className={`${iconBtn} ${onTop ? "bg-accent-soft !text-accent hover:!bg-accent/20" : ""}`}
              onClick={() => desktopMate()!.setChatOnTop(!onTop)}
              title={onTop ? t("mate.unpinTop") : t("mate.pinTop")}
              aria-pressed={onTop}
              data-testid="mate-chat-pin"
            >
              <Icon name="pin" size={14} />
            </button>
            {/* New mate: the console's Mate Create studio (a fresh draft) */}
            <button
              className={iconBtn}
              onClick={() => void desktopMate()!.openConsole(`${window.location.origin}/?view=mate&create=new`)}
              title={t("studio.newInConsole")}
              aria-label={t("mate.newMate")}
              data-testid="mate-chat-new"
            >
              <Icon name="plus" size={14} />
            </button>
            <button className={iconBtn} onClick={() => desktopMate()!.openConsole()} title={t("mate.openConsole")} data-testid="mate-chat-console">
              <Icon name="monitor" size={14} />
            </button>
            {/* (with our own title bar the window buttons below close it; on macOS the traffic lights) */}
            {!win && (
              <button className={iconBtn} onClick={() => desktopMate()!.closeChat()} title={t("common.close")} aria-label={t("common.close")}>
                <Icon name="x" size={15} />
              </button>
            )}
          </div>
        )}
        {win && !mac && (
          <>
            <span className="mx-1 h-5 w-px shrink-0 bg-border" />
            <WindowControls w={win} height={51} />
          </>
        )}
      </header>
      {conv.voiceError && <div className="px-3 pt-1 text-[11.5px] text-danger">{t("mate.voiceError", { error: conv.voiceError })}</div>}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MateMessages turns={conv.turns} compact emptyText={t("mate.sayHi", { name: mate.name })} />
        <div className="shrink-0 px-2.5 pb-2.5">
          <MateComposer mate={mate} conv={conv} compact autoFocus />
        </div>
        {relOpen && (
          <div className="absolute inset-0 z-20 bg-surface animate-fade-in" data-testid="mate-chat-relation-panel">
            <Suspense fallback={null}>
              <RelationPanel mate={mate} onClose={() => setRelOpen(false)} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
