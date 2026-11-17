/**
 * The picture editor — a picture about to be sent (the composer's tray: tapped once it is up) or one already sent (the
 * lightbox's 편집: the result goes into the message box). Full screen, by finger or mouse:
 *
 * - 자르기: drag the corners, the edges or the inside; a ratio (자유, 원본, 1:1, 4:3, 3:4, 16:9, 9:16); 돌리기 turns it a
 *   quarter clockwise; 처음대로 takes the whole picture again.
 * - 펜, 형광펜, 모자이크 (the picture in big squares where the finger goes), 네모, 화살표, 글자 (tap where; drag words
 *   to move them), 지우개 (what it goes over is gone) — in a colour and a size.
 * - Undo / redo (and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y); 완료 draws the result at full size (lib/imageEdit.ts exportEdit);
 *   unchanged, nothing is uploaded again. Esc, the back button or ✕ close it — asking first when something was done.
 * - On a phone: the tools are a strip — the ones used most first, the rest a swipe away; the picture keeps clear of the
 *   screen's sides (Android's back swipe starts there) and a finger grabs the crop's corners from further off.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  addPoint, cropToRatio, dragCrop, drawEdit, edited, erase, exportEdit, handleAt, initialEdit, isLight, isShape, isStroke,
  mosaicBlock, squared, textAt, textFont, turnClockwise, turnedSize, type EditState, type Handle, type Mark, type Pt, type Rect,
} from "../../lib/imageEdit";
import { useBackHandler } from "../../lib/back";
import { useT } from "../../i18n";
import Icon, { type IconName } from "../ui/Icon";

type Tool = "crop" | "pen" | "highlighter" | "mosaic" | "rect" | "arrow" | "text" | "eraser";
type Loaded = { el: HTMLImageElement; w: number; h: number };

const COLORS = ["#ffffff", "#111111", "#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#af52de"];
/** the sizes on screen (CSS px): what a mark is drawn at whatever the picture's resolution */
const SIZES: Record<Exclude<Tool, "crop">, number[]> = {
  pen: [3, 6, 12],
  highlighter: [14, 24, 38],
  mosaic: [22, 40, 64],
  rect: [3, 5, 9],
  arrow: [3, 5, 9],
  text: [18, 28, 42],
  eraser: [16, 30, 52],
};
const RATIOS: { key: string; value: number | "orig" | null }[] = [
  { key: "free", value: null },
  { key: "orig", value: "orig" },
  { key: "1:1", value: 1 },
  { key: "4:3", value: 4 / 3 },
  { key: "3:4", value: 3 / 4 },
  { key: "16:9", value: 16 / 9 },
  { key: "9:16", value: 9 / 16 },
];
/** the tools, the ones used most first (on a phone the rest are a swipe away) */
const TOOLS: { tool: Tool; icon: IconName; label: string }[] = [
  { tool: "crop", icon: "crop", label: "files.editCrop" },
  { tool: "pen", icon: "pencil", label: "files.editPen" },
  { tool: "text", icon: "text", label: "files.editText" },
  { tool: "mosaic", icon: "mosaic", label: "files.editMosaic" },
  { tool: "highlighter", icon: "highlighter", label: "files.editHighlighter" },
  { tool: "arrow", icon: "shape-arrow", label: "files.editArrow" },
  { tool: "rect", icon: "shape-rect", label: "files.editRect" },
  { tool: "eraser", icon: "eraser", label: "files.editEraser" },
];
/** a finger, not a mouse (lib/device's sense: the primary pointer is coarse) */
const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
/** the room left around the picture (CSS px): the crop's corners stay reachable — on a phone clear of the screen's
 *  sides, where Android's back swipe starts */
const padOf = () => (coarse() ? { x: 38, y: 26 } : { x: 22, y: 22 });
/** how far off a crop corner or edge is still grabbed (CSS px) */
const GRAB = { touch: 34, other: 20 };

type Gesture =
  | { kind: "crop"; id: number; handle: Handle; start: Rect; p0: Pt; cur: Rect }
  | { kind: "mark"; id: number; mark: Mark }
  | { kind: "erase"; id: number; path: Pt[] }
  | { kind: "move-text"; id: number; index: number; p0: Pt; at0: Pt; cur: Pt };

export default function ImageEditor({
  src,
  name,
  mime,
  onDone,
  onClose,
  startTool = "crop",
}: {
  /** the picture (an object URL or the attachment's own URL: same origin, so the canvas may be read) — or a few ways
   *  to it, tried in turn (a phone's picked file can refuse a second read: the uploaded copy then) */
  src: string | string[];
  name: string;
  mime: string;
  /** the edited picture as a file — null when nothing was changed */
  onDone: (file: File | null) => Promise<unknown> | void;
  onClose: () => void;
  startTool?: Tool;
}) {
  const t = useT();
  const [img, setImg] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [hist, setHist] = useState<{ list: EditState[]; at: number }>({ list: [], at: 0 });
  const [tool, setTool] = useState<Tool>(startTool);
  const [color, setColor] = useState(COLORS[2]);
  const [sizeIdx, setSizeIdx] = useState(1);
  const [ratio, setRatio] = useState<string>("free");
  // (the gesture lives in a ref: a finger sends moves faster than renders, and each must build on the last)
  const gestureRef = useRef<Gesture | null>(null);
  const [, setFrame] = useState(0);
  const frame = useRef(0);
  const setGesture = (g: Gesture | null) => {
    gestureRef.current = g;
    if (!g) return setFrame((n) => n + 1);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setFrame((n) => n + 1);
    });
  };
  const gesture = gestureRef.current;
  const [typing, setTyping] = useState<{ at: Pt; value: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textInput = useRef<HTMLInputElement>(null);

  const state = hist.list[hist.at] ?? null;

  // ── the picture ──
  const srcs = (Array.isArray(src) ? src : [src]).filter(Boolean);
  const srcKey = srcs.join("\n");
  useEffect(() => {
    let alive = true;
    setFailed(false);
    if (!srcs.length) return; // (still going up: the spinner until it is there)
    const load = (i: number) => {
      if (i >= srcs.length) return alive && setFailed(true);
      const el = new Image();
      el.decoding = "async";
      el.onload = () => {
        if (!alive) return;
        if (!el.naturalWidth || !el.naturalHeight) return load(i + 1);
        setImg({ el, w: el.naturalWidth, h: el.naturalHeight });
        setHist({ list: [initialEdit(el.naturalWidth, el.naturalHeight)], at: 0 });
      };
      el.onerror = () => alive && load(i + 1);
      el.src = srcs[i];
    };
    load(0);
    return () => {
      alive = false;
    };
  }, [srcKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback((next: EditState) => {
    setHist((h) => ({ list: [...h.list.slice(0, h.at + 1), next].slice(-80), at: Math.min(h.at + 1, 79) }));
  }, []);
  const undo = useCallback(() => setHist((h) => ({ ...h, at: Math.max(0, h.at - 1) })), []);
  const redo = useCallback(() => setHist((h) => ({ ...h, at: Math.min(h.list.length - 1, h.at + 1) })), []);
  const changed = !!(img && state && edited(state, img.w, img.h));

  // ── the view: the whole turned picture while cutting, the crop while drawing ──
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const view = useMemo(() => {
    if (!img || !state || !box.w || !box.h) return null;
    const [W, H] = turnedSize(img.w, img.h, state.turn);
    const area: Rect = tool === "crop" ? { x: 0, y: 0, w: W, h: H } : state.crop;
    const pad = padOf();
    const scale = Math.min((box.w - pad.x * 2) / area.w, (box.h - pad.y * 2) / area.h);
    return { W, H, area, scale, ox: (box.w - area.w * scale) / 2 - area.x * scale, oy: (box.h - area.h * scale) / 2 - area.y * scale };
  }, [img, state, box, tool]);

  const toPicture = useCallback(
    (e: { clientX: number; clientY: number }): Pt => {
      const r = canvas.current!.getBoundingClientRect();
      return [(e.clientX - r.left - view!.ox) / view!.scale, (e.clientY - r.top - view!.oy) / view!.scale];
    },
    [view],
  );

  // the mosaic's squares (once per turn, when a mosaic is there or about to be)
  const wantsPixels = tool === "mosaic" || !!state?.marks.some((m) => m.kind === "mosaic");
  const pixels = useMemo(() => {
    if (!img || !state || !wantsPixels) return null;
    const [W, H] = turnedSize(img.w, img.h, state.turn);
    return squared(img.el, img.w, img.h, state.turn, mosaicBlock(W, H));
  }, [img, state?.turn, wantsPixels]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── drawing it ──
  const shown = useMemo<EditState | null>(() => {
    if (!state || !img) return null;
    if (gesture?.kind === "crop") return { ...state, crop: gesture.cur };
    if (gesture?.kind === "mark") return { ...state, marks: [...state.marks, gesture.mark] };
    if (gesture?.kind === "erase") return { ...state, marks: erase(state.marks, gesture.path, (SIZES.eraser[sizeIdx] / 2) / (view?.scale || 1)) };
    if (gesture?.kind === "move-text") return { ...state, marks: state.marks.map((m, i) => (i === gesture.index && m.kind === "text" ? { ...m, at: moved(gesture) } : m)) };
    return state;
  }, [state, img, gesture, sizeIdx, view?.scale]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img || !shown || !view) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(box.w * dpr);
    const ch = Math.round(box.h * dpr);
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
    const crop = shown.crop;
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    if (tool !== "crop") {
      ctx.beginPath();
      ctx.rect(crop.x, crop.y, crop.w, crop.h);
      ctx.clip();
    }
    ctx.imageSmoothingQuality = "high";
    drawEdit(ctx, img.el, img.w, img.h, shown, pixels, view.area, view.scale * dpr);
    ctx.restore();
    if (tool === "crop") drawCropFrame(ctx, crop, view, !!gesture);
  }, [img, shown, view, box, pixels, tool, gesture]);

  // ── fingers and the mouse ──
  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!state || !view || gestureRef.current || busy) return;
    if (e.button !== undefined && e.button > 0) return;
    // (no focus moving to the page, no text selected: the words' box keeps the focus it is given)
    e.preventDefault();
    if (typing) return finishText();
    const p = toPicture(e);
    const size = SIZES[tool === "crop" ? "pen" : tool][sizeIdx] / view.scale;
    let g: Gesture | null = null;
    if (tool === "crop") {
      const handle = handleAt(state.crop, p, (e.pointerType === "touch" ? GRAB.touch : GRAB.other) / view.scale);
      if (handle) g = { kind: "crop", id: e.pointerId, handle, start: state.crop, p0: p, cur: state.crop };
    } else if (!inside(p, state.crop)) {
      return;
    } else if (tool === "pen" || tool === "highlighter" || tool === "mosaic") {
      g = { kind: "mark", id: e.pointerId, mark: { kind: tool, color, size, points: [p] } };
    } else if (tool === "rect" || tool === "arrow") {
      g = { kind: "mark", id: e.pointerId, mark: { kind: tool, color, size, from: p, to: p } };
    } else if (tool === "eraser") {
      g = { kind: "erase", id: e.pointerId, path: [p] };
    } else if (tool === "text") {
      const i = textAt(state.marks, p, 8 / view.scale);
      const m = state.marks[i];
      if (m && m.kind === "text") g = { kind: "move-text", id: e.pointerId, index: i, p0: p, at0: m.at, cur: p };
      else {
        startTyping({ at: p, value: "" });
        return;
      }
    }
    if (!g) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setGesture(g);
  };

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || e.pointerId !== gesture.id || !view || !state) return;
    const p = toPicture(e);
    if (gesture.kind === "crop") {
      const r = ratioValue(ratio, view.W, view.H);
      setGesture({ ...gesture, cur: dragCrop(gesture.start, gesture.handle, p[0] - gesture.p0[0], p[1] - gesture.p0[1], view.W, view.H, r) });
    } else if (gesture.kind === "mark") {
      const m = gesture.mark;
      if (isShape(m)) setGesture({ ...gesture, mark: { ...m, to: p } });
      else if (isStroke(m)) {
        const pts = addPoint(m.points, p, 1.5 / view.scale);
        if (pts !== m.points) setGesture({ ...gesture, mark: { ...m, points: pts } });
      }
    } else if (gesture.kind === "erase") {
      setGesture({ ...gesture, path: addPoint(gesture.path, p, 2 / view.scale) });
    } else if (gesture.kind === "move-text") {
      setGesture({ ...gesture, cur: p });
    }
  };

  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.id || !state || !view) return;
    setGesture(null);
    if (g.kind === "crop") {
      const c = g.cur;
      if (c.x !== state.crop.x || c.y !== state.crop.y || c.w !== state.crop.w || c.h !== state.crop.h) commit({ ...state, crop: c });
    } else if (g.kind === "mark") {
      const m = g.mark;
      if (isShape(m) && Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]) < 4 / view.scale) return;
      commit({ ...state, marks: [...state.marks, m] });
    } else if (g.kind === "erase") {
      const left = erase(state.marks, g.path, (SIZES.eraser[sizeIdx] / 2) / view.scale);
      if (left.length !== state.marks.length) commit({ ...state, marks: left });
    } else if (g.kind === "move-text") {
      const at = moved(g);
      if (at[0] !== g.at0[0] || at[1] !== g.at0[1]) commit({ ...state, marks: state.marks.map((m, i) => (i === g.index && m.kind === "text" ? { ...m, at } : m)) });
    }
  };

  // ── words (the one being typed is in a ref too: a blur and a tap that both end it add it once) ──
  const typingRef = useRef<{ at: Pt; value: string } | null>(null);
  const startTyping = (ty: { at: Pt; value: string } | null) => {
    typingRef.current = ty;
    setTyping(ty);
  };
  const finishText = useCallback(() => {
    const ty = typingRef.current;
    typingRef.current = null;
    setTyping(null);
    if (ty && ty.value.trim() && state && view) commit(withText(state, ty, color, SIZES.text[sizeIdx] / view.scale));
  }, [state, view, sizeIdx, color, commit]);

  // ── the buttons ──
  const pickRatio = (key: string) => {
    setRatio(key);
    if (!state || !view) return;
    const r = ratioValue(key, view.W, view.H);
    if (r === null) return;
    commit({ ...state, crop: cropToRatio(state.crop, r, view.W, view.H) });
  };
  const turn = () => state && img && commit(turnClockwise(state, img.w, img.h));
  const reset = () => state && img && commit({ ...state, crop: { x: 0, y: 0, w: turnedSize(img.w, img.h, state.turn)[0], h: turnedSize(img.w, img.h, state.turn)[1] } });

  const close = useCallback(() => {
    if (busy) return;
    if (typing) return startTyping(null);
    if (changed && !asking) return setAsking(true);
    onClose();
  }, [busy, typing, changed, asking, onClose]);
  useBackHandler(true, close);

  const done = async () => {
    if (!img || !state || busy) return;
    setSaveError("");
    // (words still being typed count: drawn from what is there now, the history's next state comes too late)
    const ty = typingRef.current;
    finishText();
    setBusy(true);
    try {
      const s = ty?.value.trim() && view ? withText(state, ty, color, SIZES.text[sizeIdx] / view.scale) : state;
      await onDone(edited(s, img.w, img.h) ? await exportEdit(img.el, img.w, img.h, s, name, mime) : null);
    } catch (e) {
      setSaveError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (asking) setAsking(false);
        else close();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
    };
  }, [typing, asking, close, undo, redo]);

  const drawing = tool !== "crop";
  const sizes = drawing ? SIZES[tool] : null;
  const typingAt = typing && view ? { left: typing.at[0] * view.scale + view.ox, top: typing.at[1] * view.scale + view.oy } : null;
  const textPx = SIZES.text[sizeIdx];

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t("files.editTitle")} data-testid="image-editor" className="fixed inset-0 top-[var(--window-chrome-height,0px)] z-[110] flex flex-col bg-black text-white pt-safe pb-safe select-none animate-fade-in">
      <div className="flex h-14 shrink-0 items-center gap-1 px-2">
        <button onClick={close} disabled={busy} className="grid h-10 w-10 place-items-center rounded-full text-white/85 hover:bg-white/10 hover:text-white" title={t("files.editCancel")} aria-label={t("files.editCancel")} data-testid="image-editor-cancel">
          <Icon name="x" size={20} />
        </button>
        <span className="flex-1" />
        <button onClick={undo} disabled={hist.at <= 0 || busy} className="btn-ghost !text-white/85 hover:!text-white disabled:opacity-30" title={t("files.editUndo")} aria-label={t("files.editUndo")} data-testid="image-editor-undo">
          <Icon name="undo" size={18} />
        </button>
        <button onClick={redo} disabled={hist.at >= hist.list.length - 1 || busy} className="btn-ghost !text-white/85 hover:!text-white disabled:opacity-30" title={t("files.editRedo")} aria-label={t("files.editRedo")}>
          <Icon name="redo" size={18} />
        </button>
        <button onClick={done} disabled={!img || busy} className="ml-1 inline-flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50" data-testid="image-editor-done">
          {busy ? <Icon name="spinner" size={15} spin /> : <Icon name="check" size={15} />}
          {busy ? t("files.editSaving") : t("files.editDone")}
        </button>
      </div>

      <div ref={wrap} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas
          ref={canvas}
          className="absolute inset-0 h-full w-full touch-none"
          style={{ cursor: drawing ? (tool === "text" ? "text" : "crosshair") : "default" }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          data-testid="image-editor-canvas"
        />
        {!img && !failed && (
          <span className="absolute inset-0 grid place-items-center text-white/70">
            <Icon name="spinner" size={22} spin />
          </span>
        )}
        {failed && (
          <div className="absolute inset-0 grid place-items-center px-8" data-testid="image-editor-failed">
            <div className="flex flex-col items-center gap-3 text-center text-sm text-white/80">
              <Icon name="image" size={26} />
              {t("files.editFailed")}
              <button onClick={onClose} className="h-9 rounded-full bg-white/15 px-5 text-sm text-white">{t("common.close")}</button>
            </div>
          </div>
        )}
        {saveError && (
          <div className="absolute inset-x-3 bottom-3 rounded-xl bg-danger/90 px-3 py-2 text-center text-xs text-white" role="alert">
            {t("files.editSaveFailed", { error: saveError })}
          </div>
        )}
        {typing && typingAt && (
          <input
            ref={textInput}
            autoFocus
            value={typing.value}
            onChange={(e) => startTyping({ ...typing, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), finishText());
              else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), startTyping(null));
            }}
            onBlur={finishText}
            placeholder={t("files.editTextPlaceholder")}
            enterKeyHint="done"
            className="absolute min-w-[8ch] rounded-md border border-white/40 bg-black/40 px-1.5 py-0.5 outline-none"
            style={{ left: typingAt.left, top: typingAt.top - textPx * 0.75, font: textFont(textPx), color, maxWidth: `calc(100% - ${typingAt.left}px - 8px)` }}
            data-testid="image-editor-text"
          />
        )}
        {asking && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-black/60 px-6" data-testid="image-editor-discard">
            <div className="w-full max-w-xs rounded-2xl border border-white/15 bg-neutral-900 p-4 text-center">
              <p className="mb-4 text-sm">{t("files.editDiscard")}</p>
              <div className="flex gap-2">
                <button onClick={() => setAsking(false)} className="h-10 flex-1 rounded-xl bg-white/10 text-sm">{t("files.editKeep")}</button>
                <button onClick={onClose} className="h-10 flex-1 rounded-xl bg-danger text-sm font-semibold text-white">{t("files.editDiscardYes")}</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* what the tool takes: a ratio and a turn while cutting; a colour and a size while drawing */}
      <div className="mx-auto flex h-12 w-full max-w-2xl shrink-0 items-center gap-2 overflow-x-auto px-3 [scrollbar-width:none]">
        {!drawing ? (
          <>
            <button onClick={turn} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-white/10 px-3 text-xs" data-testid="image-editor-rotate">
              <Icon name="rotate-cw" size={14} /> {t("files.editRotate")}
            </button>
            <span className="mx-0.5 h-5 w-px shrink-0 bg-white/20" />
            {RATIOS.map((r) => (
              <button
                key={r.key}
                onClick={() => pickRatio(r.key)}
                className={`h-8 shrink-0 rounded-full px-3 text-xs ${ratio === r.key ? "bg-white text-black" : "bg-white/10 text-white/85"}`}
                data-testid={`image-editor-ratio-${r.key}`}
              >
                {r.key === "free" ? t("files.editFree") : r.key === "orig" ? t("files.editOriginal") : r.key}
              </button>
            ))}
            <span className="mx-0.5 h-5 w-px shrink-0 bg-white/20" />
            <button onClick={reset} className="h-8 shrink-0 rounded-full bg-white/10 px-3 text-xs text-white/85">{t("files.editReset")}</button>
          </>
        ) : (
          <>
            {tool !== "eraser" && tool !== "mosaic" &&
              COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  aria-label={`${t("files.editColor")} ${c}`}
                  className={`h-7 w-7 shrink-0 rounded-full border-2 ${color === c ? "border-white scale-110" : isLight(c) ? "border-white/40" : "border-white/20"}`}
                  style={{ background: c }}
                />
              ))}
            {tool !== "eraser" && tool !== "mosaic" && <span className="mx-1 h-5 w-px shrink-0 bg-white/20" />}
            {sizes?.map((_px, i) => (
              <button
                key={i}
                onClick={() => setSizeIdx(i)}
                aria-label={t("files.editSize", { n: i + 1 })}
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${sizeIdx === i ? "bg-white/25" : "bg-white/5"}`}
              >
                <span className="rounded-full bg-white" style={{ width: Math.min(22, 4 + i * 6), height: Math.min(22, 4 + i * 6) }} />
              </button>
            ))}
          </>
        )}
      </div>

      <ToolStrip tool={tool} onPick={(x) => (typing && finishText(), setTool(x))} label={(k) => t(k as "files.editCrop")} />
    </div>,
    document.body,
  );
}

/** the tools as a strip: on a phone the ones used most show, the rest a swipe away (a fade says there is more) */
function ToolStrip({ tool, onPick, label }: { tool: Tool; onPick: (t: Tool) => void; label: (key: string) => string }) {
  const row = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const look = useCallback(() => {
    const el = row.current;
    if (!el) return;
    setMore({ left: el.scrollLeft > 10, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 10 });
  }, []);
  useLayoutEffect(() => {
    look();
    const el = row.current;
    if (!el) return;
    const ro = new ResizeObserver(look);
    ro.observe(el);
    return () => ro.disconnect();
  }, [look]);
  return (
    <div className="relative shrink-0 border-t border-white/10">
      <div ref={row} onScroll={look} className="mx-auto flex max-w-2xl snap-x scroll-px-1.5 overflow-x-auto px-1.5 pb-1 pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-testid="image-editor-tools">
        {TOOLS.map((x) => (
          <button
            key={x.tool}
            onClick={() => onPick(x.tool)}
            className={`flex w-[74px] shrink-0 snap-start flex-col items-center gap-0.5 rounded-xl py-1.5 text-[11px] sm:w-auto sm:min-w-0 sm:flex-1 ${tool === x.tool ? "bg-white/15 text-white" : "text-white/65 hover:text-white"}`}
            aria-pressed={tool === x.tool}
            data-testid={`image-editor-tool-${x.tool}`}
          >
            <Icon name={x.icon} size={21} />
            <span className="max-w-full truncate px-0.5">{label(x.label)}</span>
          </button>
        ))}
      </div>
      {more.left && <span className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-black to-transparent" />}
      {more.right && <span className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-black to-transparent" />}
    </div>
  );
}

function inside([x, y]: Pt, c: Rect): boolean {
  return x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h;
}

function ratioValue(key: string, W: number, H: number): number | null {
  if (key === "free") return null;
  if (key === "orig") return W / H;
  const [a, b] = key.split(":").map(Number);
  return a && b ? a / b : null;
}

/** where a text mark being dragged is now */
function moved(g: Extract<Gesture, { kind: "move-text" }>): Pt {
  return [g.at0[0] + g.cur[0] - g.p0[0], g.at0[1] + g.cur[1] - g.p0[1]];
}

function withText(s: EditState, ty: { at: Pt; value: string }, color: string, size: number): EditState {
  return { ...s, marks: [...s.marks, { kind: "text", color, size, at: [ty.at[0], ty.at[1] + size * 0.35], text: ty.value.trim() }] };
}

/** the crop on screen: outside it dimmed, its frame, corners and edges to drag, thirds while dragging */
function drawCropFrame(ctx: CanvasRenderingContext2D, c: Rect, v: { ox: number; oy: number; scale: number; W: number; H: number }, dragging: boolean): void {
  const x = v.ox + c.x * v.scale;
  const y = v.oy + c.y * v.scale;
  const w = c.w * v.scale;
  const h = c.h * v.scale;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,.58)";
  ctx.beginPath();
  ctx.rect(v.ox, v.oy, v.W * v.scale, v.H * v.scale);
  ctx.rect(x, y, w, h);
  ctx.fill("evenodd");
  ctx.strokeStyle = "rgba(255,255,255,.95)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, w, h);
  if (dragging) {
    ctx.strokeStyle = "rgba(255,255,255,.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of [1 / 3, 2 / 3]) {
      ctx.moveTo(x + w * f, y);
      ctx.lineTo(x + w * f, y + h);
      ctx.moveTo(x, y + h * f);
      ctx.lineTo(x + w, y + h * f);
    }
    ctx.stroke();
  }
  // corners (L) and the edges' middles
  const L = Math.min(22, w / 3, h / 3);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]] as const) {
    ctx.moveTo(cx, cy + sy * L);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + sx * L, cy);
  }
  const m = Math.min(14, w / 5, h / 5);
  ctx.moveTo(x + w / 2 - m, y);
  ctx.lineTo(x + w / 2 + m, y);
  ctx.moveTo(x + w / 2 - m, y + h);
  ctx.lineTo(x + w / 2 + m, y + h);
  ctx.moveTo(x, y + h / 2 - m);
  ctx.lineTo(x, y + h / 2 + m);
  ctx.moveTo(x + w, y + h / 2 - m);
  ctx.lineTo(x + w, y + h / 2 + m);
  ctx.stroke();
  ctx.restore();
}

