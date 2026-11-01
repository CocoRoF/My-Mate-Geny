/**
 * Full-page Mate surfaces for the desktop app's windows (docs/mate.md §6–7), no console chrome:
 *   ?surface=mate-overlay&mate=<id>  the avatar + caption bubble on a transparent page; plays the voice; pan / zoom
 *                                    the avatar when it takes the mouse; move mode: move bar + resize frame
 *   ?surface=mate-quick&mate=<id>    a one-line card (draggable, fixed width, grows downwards): Enter sends, then it
 *                                    closes (the reply shows by the avatar); a draft keeps it open (✕ closes)
 *   ?surface=mate-chat&mate=<id>     a compact conversation window
 * They all attach to the same mate session (useMateConversation), so every window stays in sync.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Mate } from "../../../api/mates";
import { useSessionSync } from "../../../hooks/useSessionSync";
import { useConfigStore } from "../../../stores/configStore";
import { useMateStore } from "../../../stores/mateStore";
import { desktopMate, useDesktopMate, type DesktopCommand, type DesktopMateState } from "../../../mate/desktop";
import { useMateConversation } from "../../../mate/useMateConversation";
import { parseEmotionText } from "../../../mate/emotion";
import { LiveMateAvatar } from "../../../mate/avatar/MateAvatar";
import { isHome, useAvatarView } from "../../../mate/avatar/view";
import Icon from "../../ui/Icon";
import { DropOverlay, useFileDrop } from "../../composer/useFileDrop";
import MateComposer from "../MateComposer";
import MateMessages from "../MateMessages";
import { MateThumb, MOOD_LABEL, useFadingCaption } from "../MateStage";

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
  const [moveMode, setMoveMode] = useState(false);
  const [sizeKey, setSizeKey] = useState(0);
  const resetRef = useRef<() => void>(() => {});
  const onCommand = useCallback((cmd: DesktopCommand) => {
    if (cmd.type === "move-mode") setMoveMode(!!cmd.on);
    if (cmd.type === "state" && typeof cmd.moveMode === "boolean") setMoveMode(cmd.moveMode);
    if (cmd.type === "reset-view") resetRef.current(); // tray → Reset Mate position & size
  }, []);
  const { mate, desk } = useSurfaceMate(onCommand);
  const conv = useMateConversation(mate);
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
            className="max-h-[38%] max-w-full overflow-hidden rounded-2xl border border-white/10 bg-[#161a22]/90 px-3 py-1.5 text-center text-[13px] leading-snug text-content shadow-float animate-fade-in"
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
        <LiveMateAvatar key={mate.id} mate={mate} mood={conv.mood} react={conv.react} onTap={() => conv.poke("greet")} view={view} />
      </div>
      {interactive && !moveMode && !isHome(view) && (
        <button
          className="absolute right-1.5 top-1.5 z-20 grid h-6 w-6 place-items-center rounded-full border border-white/10 bg-[#161a22]/85 text-content-dim opacity-0 shadow-float transition hover:text-content group-hover:opacity-100"
          onClick={reset}
          title="Reset the view (pan / zoom)"
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
        className="pointer-events-auto flex max-w-full cursor-move items-center gap-1.5 rounded-full border border-accent/40 bg-[#161a22]/95 py-1 pl-2.5 pr-1 text-[12px] text-content shadow-float"
        onPointerDown={onDown}
        data-no-drag
        data-no-pan
        title="Drag to move the window · drag the avatar to pan, wheel to zoom · drag the edges to resize"
        data-testid="mate-move-bar"
      >
        <Icon name="move" size={13} className="shrink-0 text-accent" />
        <span className="truncate">Move</span>
        <button
          className="rounded-full px-2 py-0.5 text-content-dim hover:bg-surface-3 hover:text-content disabled:opacity-40"
          onClick={onReset}
          disabled={!canReset}
          title="Back to the fitted view"
          data-testid="mate-view-reset-move"
        >
          Reset view
        </button>
        <button className="rounded-full bg-accent px-2.5 py-0.5 font-medium text-white" onClick={() => desktopMate()?.setMoveMode(false)} data-testid="mate-move-done">
          Done
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

function aspectOf(mate: Mate): number {
  const a = mate.avatar;
  if ((a.kind === "video" || a.kind === "photo") && a.rig.aspect?.[0] > 0 && a.rig.aspect?.[1] > 0) return a.rig.aspect[0] / a.rig.aspect[1];
  return 0.75;
}

/** while she writes and nothing is spoken yet: the sentence being written (tags hidden), short */
function useLiveLine(conv: ReturnType<typeof useMateConversation>): string | null {
  if (conv.speaks || !conv.streaming) return null;
  const last = conv.turns[conv.turns.length - 1];
  if (!last || last.role !== "assistant" || last.complete) return null;
  const text = parseEmotionText(last.text, { streaming: true }).text.trim();
  const lines = text.split("\n").filter((l) => l.trim());
  const l = lines[lines.length - 1] || "";
  return l ? (l.length > 140 ? "…" + l.slice(-139) : l) : null;
}

// ── quick card ──────────────────────────────────────────────────────────

const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
const DRAG = { WebkitAppRegion: "drag" } as React.CSSProperties;

function Quick() {
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

  if (!mate) return loaded ? <div className="p-3 text-[12px] text-content-faint">No mate.</div> : null;
  // the overlay shows the reply; without it (or in a browser), the card shows it itself
  const overlayOut = !!desk?.visible;
  const last = conv.turns[conv.turns.length - 1];
  const reply =
    !overlayOut && sentAt && last?.role === "assistant"
      ? parseEmotionText(last.text, { streaming: !last.complete }).text.trim()
      : "";

  return (
    <div className="p-2" data-testid="mate-quick" data-pinned={hasDraft ? "true" : "false"}>
      {/* The card is the window's drag handle (frameless window: -webkit-app-region, like Geny's quick bar); the
          composer, the reply and the ✕ are not. Where it is dropped is where it opens next time. */}
      <div
        ref={card}
        className="relative w-full rounded-2xl border border-border bg-[#11141b]/95 p-2 shadow-float backdrop-blur-xl"
        style={DRAG}
        data-testid="mate-quick-card"
        {...dropProps}
      >
        {dragging && <DropOverlay compact hint={`for ${mate.name}`} />}
        {hasDraft && desktopMate() && (
          <button
            className="absolute -right-1.5 -top-1.5 z-10 grid h-5 w-5 place-items-center rounded-full border border-border bg-surface-3 text-content-dim shadow-float transition hover:bg-border-strong hover:text-content"
            style={NO_DRAG}
            onClick={() => void desktopMate()?.closeQuick()}
            title="Close (the draft stays)"
            aria-label="Close"
            data-testid="mate-quick-close"
          >
            <Icon name="x" size={11} />
          </button>
        )}
        <div className="flex items-end gap-2">
          {/* as tall as the one-line composer (42 px), so she sits level with the input row */}
          <div className="flex h-[42px] shrink-0 cursor-move items-center" title="Drag to move" data-testid="mate-quick-handle">
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
              placeholder={`Ask ${mate.name}…`}
              onSent={() => {
                setSentAt(Date.now());
                if (desktopMate() && overlayOut) void desktopMate()!.closeQuick();
              }}
            />
          </div>
        </div>
        {(reply || (sentAt > 0 && !overlayOut && conv.streaming)) && (
          <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl bg-surface-2/80 px-3 py-2 text-[13px] text-content" style={NO_DRAG} data-testid="mate-quick-reply">
            {reply || <span className="text-content-faint">{MOOD_LABEL.thinking}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── chat window ─────────────────────────────────────────────────────────

function ChatWindow() {
  const { mate, loaded } = useSurfaceMate();
  const desk = useDesktopMate();
  const conv = useMateConversation(mate);
  const { dragging, dropProps } = useFileDrop(conv.sessionId);
  const loadConfig = useConfigStore((s) => s.load);
  useEffect(() => {
    loadConfig().catch(() => {});
  }, [loadConfig]);
  if (!mate) return <div className="grid h-full place-items-center text-sm text-content-faint">{loaded ? "No mate." : "Loading…"}</div>;
  const onTop = !!desk?.chatOnTop;
  return (
    <div className="relative flex h-full flex-col bg-bg" data-testid="mate-chat-window" {...dropProps}>
      {dragging && <DropOverlay compact hint={`${mate.name} sees images and reads documents`} />}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-surface/80 px-3 py-2">
        <div className="relative h-10 w-8 shrink-0">
          <LiveMateAvatar key={mate.id} mate={mate} size="sm" mood={conv.mood} react={conv.react} interactive={false} />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13.5px] font-semibold">{mate.name}</div>
          <div className="text-[11px] text-content-faint">{MOOD_LABEL[conv.mood] || (conv.connection === "open" ? "here" : "connecting…")}</div>
        </div>
        {desktopMate() && (
          <>
            <button className="btn-ghost !px-2" onClick={() => desktopMate()!.setChatOnTop(!onTop)} title={onTop ? "Stop keeping on top" : "Keep on top"}>
              <Icon name={onTop ? "pin-off" : "pin"} size={14} />
            </button>
            <button className="btn-ghost !px-2" onClick={() => desktopMate()!.openConsole()} title="Open the console">
              <Icon name="monitor" size={14} />
            </button>
            <button className="btn-ghost !px-2" onClick={() => desktopMate()!.closeChat()} title="Close">
              <Icon name="x" size={15} />
            </button>
          </>
        )}
      </div>
      {conv.voiceError && <div className="px-3 pt-1 text-[11.5px] text-danger">Voice: {conv.voiceError}</div>}
      <MateMessages turns={conv.turns} compact emptyText={`Say hi to ${mate.name}.`} />
      <div className="shrink-0 px-2 pb-2">
        <MateComposer mate={mate} conv={conv} compact autoFocus />
      </div>
    </div>
  );
}
