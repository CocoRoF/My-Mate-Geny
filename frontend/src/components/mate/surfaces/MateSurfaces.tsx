/**
 * Full-page Mate surfaces for the desktop app's windows (docs/mate.md §6–7), no console chrome:
 *   ?surface=mate-overlay&mate=<id>  the avatar + caption bubble on a transparent page; plays the voice; move mode
 *   ?surface=mate-quick&mate=<id>    a one-line card: Enter sends, then it closes (the reply shows by the avatar)
 *   ?surface=mate-chat&mate=<id>     a compact conversation window
 * They all attach to the same mate session (useMateConversation), so every window stays in sync.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Mate } from "../../../api/mates";
import { useConfigStore } from "../../../stores/configStore";
import { useDraftStore } from "../../../stores/draftStore";
import { useMateStore } from "../../../stores/mateStore";
import { desktopMate, useDesktopMate, type DesktopCommand } from "../../../mate/desktop";
import { useMateConversation } from "../../../mate/useMateConversation";
import { parseEmotionText } from "../../../mate/emotion";
import { MateAvatar } from "../../../mate/avatar/MateAvatar";
import Icon from "../../ui/Icon";
import { DropOverlay, useFileDrop } from "../../composer/useFileDrop";
import MateComposer from "../MateComposer";
import MateMessages from "../MateMessages";
import { MateThumb, MOOD_LABEL, useFadingCaption } from "../MateStage";

type Kind = "mate-overlay" | "mate-quick" | "mate-chat";

/** the mate this window shows: ?mate=, then the desktop's choice, then the default */
function useSurfaceMate(onCommand?: (cmd: DesktopCommand) => void): { mate: Mate | null; loaded: boolean } {
  const mates = useMateStore((s) => s.mates);
  const loaded = useMateStore((s) => s.loaded);
  const [wanted] = useState(() => new URLSearchParams(window.location.search).get("mate"));
  const desk = useDesktopMate(onCommand);
  useEffect(() => {
    useMateStore.getState().load();
  }, []);
  const id = desk?.mateId || wanted;
  const mate = mates.find((m) => m.id === id) ?? mates.find((m) => m.is_default) ?? mates[0] ?? null;
  return { mate, loaded };
}

export default function MateSurface({ kind }: { kind: Kind }) {
  if (kind === "mate-overlay") return <Overlay />;
  if (kind === "mate-quick") return <Quick />;
  return <ChatWindow />;
}

// ── overlay ─────────────────────────────────────────────────────────────

function Overlay() {
  const [moveMode, setMoveMode] = useState(false);
  const onCommand = useCallback((cmd: DesktopCommand) => {
    if (cmd.type === "move-mode") setMoveMode(!!cmd.on);
    if (cmd.type === "state" && typeof cmd.moveMode === "boolean") setMoveMode(cmd.moveMode);
  }, []);
  const { mate } = useSurfaceMate(onCommand);
  const conv = useMateConversation(mate);
  const caption = useFadingCaption(conv.caption, 7000);
  const live = useLiveLine(conv);
  const line = caption || live;

  // the window's size follows the avatar's shape (bottom-right corner stays put)
  const aspect = mate ? aspectOf(mate) : 0.75;
  useEffect(() => {
    if (!mate) return;
    const h = 400;
    const w = Math.max(220, Math.min(420, Math.round((h - 40) * aspect)));
    desktopMate()?.setAvatarSize(w, h);
  }, [mate?.id, aspect]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mate) return null; // signed out / not loaded: nothing on the screen
  return (
    <div className="relative h-full w-full select-none overflow-hidden" data-testid="mate-overlay" data-mood={conv.mood}>
      {line && (
        <div className="absolute inset-x-2 top-2 z-10 flex justify-center">
          <div
            key={line}
            className="max-h-[38%] max-w-full overflow-hidden rounded-2xl border border-white/10 bg-[#161a22]/90 px-3 py-1.5 text-center text-[13px] leading-snug text-content shadow-float animate-fade-in"
            data-testid="mate-caption"
          >
            {line}
          </div>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 top-10">
        <MateAvatar key={mate.id} avatar={mate.avatar} name={mate.name} mood={conv.mood} react={conv.react} onTap={() => conv.poke("greet")} />
      </div>
      {moveMode && (
        <div className="absolute inset-x-0 bottom-2 z-20 flex justify-center">
          <div className="flex items-center gap-2 rounded-full border border-accent/40 bg-[#161a22]/95 px-3 py-1.5 text-[12px] text-content shadow-float" data-no-drag>
            <Icon name="move" size={13} className="text-accent" /> Drag to move
            <button className="rounded-full bg-accent px-2.5 py-0.5 font-medium text-white" onClick={() => desktopMate()?.setMoveMode(false)} data-testid="mate-move-done">
              Done
            </button>
          </div>
        </div>
      )}
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

function Quick() {
  const [focusKey, setFocusKey] = useState(1);
  const sidRef = useRef<string | null>(null);
  const onCommand = useCallback((cmd: DesktopCommand) => {
    if (cmd.type === "quick-open") {
      // a fresh line each time (files the user attached stay until sent or removed)
      if (sidRef.current) useDraftStore.getState().setText(sidRef.current, "");
      setFocusKey((k) => k + 1);
    } else if (cmd.type === "quick-close") {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  }, []);
  const { mate, loaded } = useSurfaceMate(onCommand);
  const desk = useDesktopMate();
  const conv = useMateConversation(mate, { voice: false });
  sidRef.current = conv.sessionId;
  const { dragging, dropProps } = useFileDrop(conv.sessionId);
  const card = useRef<HTMLDivElement>(null);
  const [sentAt, setSentAt] = useState(0);

  // the window hugs the card (top edge fixed)
  useLayoutEffect(() => {
    const el = card.current;
    const m = desktopMate();
    if (!el || !m) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      m.setSize(Math.max(320, Math.min(960, Math.ceil(r.width) + 16)), Math.max(64, Math.min(640, Math.ceil(r.height) + 16)));
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
    <div className="flex justify-center p-2" data-testid="mate-quick">
      <div ref={card} className="relative w-[624px] max-w-full rounded-2xl border border-border bg-[#11141b]/95 p-2 shadow-float backdrop-blur-xl" {...dropProps}>
        {dragging && <DropOverlay compact hint={`for ${mate.name}`} />}
        <div className="flex items-center gap-2">
          <MateThumb mate={mate} className="h-8 w-8" />
          <div className="min-w-0 flex-1">
            <MateComposer
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
          <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl bg-surface-2/80 px-3 py-2 text-[13px] text-content" data-testid="mate-quick-reply">
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
          <MateAvatar key={mate.id} avatar={mate.avatar} name={mate.name} size="sm" mood={conv.mood} react={conv.react} interactive={false} />
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
