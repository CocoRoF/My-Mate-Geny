/**
 * Clip players for the video body. Ported from ailism-mate `mate-core/player.ts` (StackedPlayer, unchanged in
 * behaviour) + a `PlainPlayer` for `packing: "plain"` rigs (ordinary videos, no alpha) with the same interface.
 *
 * StackedPlayer: each clip is one H.264 MP4 with the colour on top and the alpha below (Safari, Chrome, Firefox and
 * Electron all play H.264; Safari cannot play VP9 with alpha), joined by a small WebGL shader into premultiplied
 * alpha (a transparent page shows through). Two video elements take turns: the next clip loads in the spare one while
 * the current one plays, so a switch at the end of a clip (every clip starts and ends on the same home frame) shows no
 * seam; a switch in the middle crossfades.
 *
 * Differences from the ailism original (each one a double exposure seen in the browser): a show() asked for while a
 * crossfade runs waits for it to finish (it used to reload the slot that was still fading out, so the fade jumped
 * or restarted from a half-blended picture); a prepare() during a crossfade is queued, not dropped; and a slot whose
 * frame can't be read for a moment (seeking) keeps its last frame instead of snapping the fade to the end for one
 * frame and back.
 *
 * A player that stops moving says so (`onStall`; the video body makes a new one, as a remount would): its clip no longer
 * advances while it should play (a decoder that hung — seen on Windows with a second avatar on the page, the stage
 * standing still until it was remade —, a clip that never loads), its WebGL context is lost (a GPU reset), or a clip
 * fails to decode. Before that it is nudged once (played again; a clip still loading is asked for again).
 */

export interface ClipPlayer {
  onEnded: (() => void) | null;
  onFirstFrame: (() => void) | null;
  /** it stopped moving and a nudge didn't help: make a new player */
  onStall: (() => void) | null;
  /** a clip asked for by show() is on screen now (it may have loaded a while: this is when it really starts) */
  onStart: ((src: string) => void) | null;
  prepare(src: string): void;
  show(src: string, opts?: ShowOptions): void;
  setPaused(paused: boolean): void;
  dispose(): void;
}

// Her top row reads the alpha right under the seam of the two halves, where the colour half ends on her (bright)
// body: a low-precision GPU (mediump = 16 bits on Apple's) rounded that onto the seam and drew a dark line over her
// head. Each half is therefore read a few rows away from the seam (`e`, set per clip), in high precision when there is.
const VS = "attribute vec2 p;varying vec2 uv;void main(){uv=vec2((p.x+1.)*.5,(1.-p.y)*.5);gl_Position=vec4(p,0.,1.);}";
const FS =
  "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n" +
  "uniform sampler2D a;uniform sampler2D b;uniform float t;uniform float e;varying vec2 uv;" +
  "vec4 px(sampler2D s){float y=clamp(uv.y,e,1.-e);vec3 c=texture2D(s,vec2(uv.x,y*.5)).rgb;" +
  "float al=texture2D(s,vec2(uv.x,.5+y*.5)).r;al=clamp((al-.03)/.94,0.,1.);return vec4(c*al,al);}" +
  "void main(){gl_FragColor=mix(px(a),px(b),t);}";
/** how far from the seam each half is read, in rows of a half (past the codec's bleed across it) */
const SEAM_ROWS = 4;

export interface ShowOptions {
  loop?: boolean;
  /** crossfade from the clip on screen (ms); 0 = switch on the next frame */
  fadeMs?: number;
  /** another window started this clip at this moment (Date.now()): it starts as far into it as that window is now —
   *  reckoned again when it is loaded (mate/avatarSync.ts) */
  alignTo?: number;
}

/** no new frame for this long while a clip should play: nudged, then (twice as long) a stall */
export const STALL_MS = 3000;
/** …while a clip it was asked for is still loading (the network may be slow) */
export const STALL_LOADING_MS = 12000;

/** Watches a player's clock: the time of the clip on screen must move while it should play. */
export class StallWatch {
  private t = -1;
  private at = 0;
  private nudged = false;
  private nudge: () => void;
  private stall: () => void;
  constructor(nudge: () => void, stall: () => void) {
    this.nudge = nudge;
    this.stall = stall;
  }
  /** `active`: it should be moving now (alive, not paused, not resting at a clip's end with nothing asked for) */
  check(now: number, time: number, active: boolean, loading: boolean): void {
    if (!active || time !== this.t) {
      this.t = time;
      this.at = now;
      this.nudged = false;
      return;
    }
    const limit = loading ? STALL_LOADING_MS : STALL_MS;
    if (!this.nudged && now - this.at > limit) {
      this.nudged = true;
      this.nudge();
    } else if (now - this.at > limit * 2) {
      this.at = now;
      this.nudged = false;
      this.stall();
    }
  }
}

/** where a clip starts: its beginning, or as far into it as the window it follows is (s) */
const offsetOf = (alignTo: number | undefined) => (alignTo ? Math.max(0, (Date.now() - alignTo) / 1000) : 0);

/** a clip's start position, applied to a video before it plays */
function seekTo(video: HTMLVideoElement, alignTo: number | undefined): void {
  const at = offsetOf(alignTo);
  if (video.currentTime !== at) video.currentTime = at;
}

/** loaded at last: where the window it follows is now (its load took a while) — only forward, only when it matters */
function realign(video: HTMLVideoElement, alignTo: number | undefined): void {
  if (!alignTo) return;
  const at = offsetOf(alignTo);
  if (at - video.currentTime > 0.25 && (!video.duration || at < video.duration)) video.currentTime = at;
}

type Slot = { video: HTMLVideoElement; tex: WebGLTexture; src: string; ready: boolean };

/** what a clip waiting to go on screen listens for: loaded (a new src), can play, or seeked (back to its first frame) */
const WAIT = ["loadeddata", "canplay", "seeked"] as const;

export class StackedPlayer implements ClipPlayer {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private slots: [Slot, Slot];
  private cur = 0;
  private fade: { from: number; start: number; ms: number } | null = null;
  private raf = 0;
  private alive = true;
  private paused = false;
  private uT: WebGLUniformLocation | null;
  private uE: WebGLUniformLocation | null;
  /** the clip on screen reached its end (not for a looping clip) */
  onEnded: (() => void) | null = null;
  /** the first frame is drawn (the still under the canvas may go) */
  onFirstFrame: (() => void) | null = null;
  onStall: (() => void) | null = null;
  onStart: ((src: string) => void) | null = null;
  private watch = new StallWatch(
    () => {
      // (once: the clip on screen played again; a clip still loading asked for again)
      const now = this.slots[this.cur].video;
      if (!this.paused && now.paused && !now.ended) void now.play().catch(() => {});
      const spare = this.slots[1 - this.cur];
      if (this.pending && spare.src) spare.video.load();
    },
    () => this.alive && this.onStall?.(),
  );
  private drawn = false;
  /** the frame last drawn (a video gives ~24 new frames a second: the other animation frames draw nothing) */
  private last: { slot: Slot | null; t: number } = { slot: null, t: -1 };
  /** a clip asked for by show() is still loading in the spare slot (nothing may load over it meanwhile) */
  private pending = false;
  /** the show() waiting for its clip (a newer show() makes an older one's wait end with nothing) */
  private waiting = 0;
  /** what prepare() was asked to load while a show was pending: loaded right after the switch */
  private queued: string | null = null;
  /** a show() asked for during a crossfade: run when the crossfade ends (only the newest) */
  private deferred: { src: string; opts: ShowOptions } | null = null;

  static supported(): boolean {
    try {
      return !!document.createElement("canvas").getContext("webgl");
    } catch {
      return false;
    }
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) throw new Error("no webgl"); // i18n-ignore (a technical reason, shown inside a translated message)
    this.gl = gl;
    // (a GPU reset or a driver taking the context back: this player draws no more — a new one does)
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      if (this.alive) this.onStall?.();
    });
    const prog = gl.createProgram()!;
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VS],
      [gl.FRAGMENT_SHADER, FS],
    ] as const) {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(prog, "a"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "b"), 1);
    this.uT = gl.getUniformLocation(prog, "t");
    this.uE = gl.getUniformLocation(prog, "e");
    const slot = (): Slot => {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.preload = "auto";
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      for (const [k, v] of [
        [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
        [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
        [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
      ] as const)
        gl.texParameteri(gl.TEXTURE_2D, k, v);
      return { video, tex, src: "", ready: false };
    };
    this.slots = [slot(), slot()];
    for (const [i, s] of this.slots.entries()) {
      s.video.addEventListener("ended", () => {
        if (i === this.cur && !s.video.loop) this.onEnded?.();
      });
      s.video.addEventListener("loadeddata", () => {
        s.ready = true;
      });
      // (a clip that can't be decoded — on screen, or the one asked for)
      s.video.addEventListener("error", () => {
        if (this.alive && (i === this.cur || this.pending) && s.src) this.onStall?.();
      });
    }
    this.loop();
  }

  /** load a clip into the spare slot ahead of time (it plays when :meth:`show` asks for the same src) */
  prepare(src: string): void {
    // the spare slot is busy loading a clip for show(), or still fading out: load it after that
    if (this.pending || this.fade) {
      this.queued = src;
      return;
    }
    const spare = this.slots[1 - this.cur];
    if (spare.src === src) return;
    spare.src = src;
    spare.ready = false;
    spare.video.src = src;
    spare.video.load();
  }

  /** put a clip on screen: at once (the spare already has it, or the first clip) or with a crossfade */
  show(src: string, opts: ShowOptions = {}): void {
    // the spare slot is the one fading out: never load over it mid-fade (the old picture would jump or vanish)
    if (this.fade) {
      this.deferred = { src, opts };
      return;
    }
    this.deferred = null;
    const { loop = false, fadeMs = 0 } = opts;
    const now = this.slots[this.cur];
    if (now.src === src) {
      // the clip on screen after all: a switch still waiting for its clip is called off
      if (this.pending) {
        this.waiting++;
        this.pending = false;
      }
      now.video.loop = loop;
      now.video.defaultPlaybackRate = 1;
      now.video.playbackRate = 1;
      const again = now.video.ended;
      if (now.video.paused && !this.paused) void now.video.play().catch(() => {});
      if (again) this.onStart?.(src);
      return;
    }
    const next = 1 - this.cur;
    const spare = this.slots[next];
    if (spare.src !== src) {
      spare.src = src;
      spare.ready = false;
      spare.video.src = src;
    }
    spare.video.defaultPlaybackRate = 1;
    spare.video.playbackRate = 1;
    spare.video.loop = loop;
    // a clip played before (or a preloaded one) starts again from its first frame: that is a seek, which never fires
    // loadeddata again, so the wait below ends on whichever comes first of loaded, can play and seeked
    seekTo(spare.video, opts.alignTo);
    const token = ++this.waiting;
    const stop = () => {
      for (const ev of WAIT) spare.video.removeEventListener(ev, go);
    };
    const go = () => {
      if (token !== this.waiting || !this.alive || spare.src !== src) return stop();
      if (!spare.ready || spare.video.readyState < 2 || spare.video.seeking) return;
      stop();
      this.waiting++;
      this.pending = false;
      realign(spare.video, opts.alignTo);
      if (!this.paused) void spare.video.play().catch(() => {});
      if (fadeMs > 0 && this.drawn) {
        this.fade = { from: this.cur, start: performance.now(), ms: fadeMs };
      } else {
        this.slots[this.cur].video.pause();
      }
      this.cur = next;
      this.onStart?.(src);
      // the likely next clip, asked for while this one loaded, now goes into the new spare slot (after a crossfade,
      // when the slot fading out is free)
      if (this.queued && !this.fade) {
        const queued = this.queued;
        this.queued = null;
        this.prepare(queued);
      }
    };
    this.pending = true;
    for (const ev of WAIT) spare.video.addEventListener(ev, go);
    go();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    for (const s of this.slots) {
      s.video.defaultPlaybackRate = 1;
      s.video.playbackRate = 1;
      if (paused) s.video.pause();
    }
    if (!paused) void this.slots[this.cur].video.play().catch(() => {});
  }

  dispose(): void {
    this.alive = false;
    this.onStall = null;
    cancelAnimationFrame(this.raf);
    for (const s of this.slots) {
      s.video.pause();
      s.video.removeAttribute("src");
      s.video.load();
      this.gl.deleteTexture(s.tex);
    }
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  private upload(unit: number, s: Slot): boolean {
    const gl = this.gl;
    if (s.video.readyState < 2) return false;
    gl.activeTexture(unit === 0 ? gl.TEXTURE0 : gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, s.video);
    return true;
  }

  private loop = (): void => {
    if (!this.alive) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.paused) {
      this.watch.check(performance.now(), -1, false, false); // (paused on purpose: the watch starts again after)
      return;
    }
    const gl = this.gl;
    const now = this.slots[this.cur];
    const v = now.video;
    // (moving while it should: playing, or a clip it was asked for loading — not resting at a clip's end)
    this.watch.check(performance.now(), v.currentTime, !document.hidden && (this.pending || !v.ended), this.pending || !this.drawn);
    if (v.videoWidth && (this.canvas.width !== v.videoWidth || this.canvas.height !== v.videoHeight / 2)) {
      this.canvas.width = v.videoWidth;
      this.canvas.height = Math.round(v.videoHeight / 2);
      this.last.slot = null; // a resized canvas is blank: draw again
    }
    let t = 1;
    let from: Slot = now;
    if (this.fade) {
      t = Math.min(1, (performance.now() - this.fade.start) / this.fade.ms);
      from = this.slots[this.fade.from];
      if (t >= 1) {
        from.video.pause();
        this.fade = null;
        from = now;
        const deferred = this.deferred;
        this.deferred = null;
        if (deferred) {
          // a switch asked for during the fade: now (it loads into the slot that just faded out; what was queued for
          // that slot follows once it is on screen)
          this.show(deferred.src, deferred.opts);
        } else if (this.queued) {
          const queued = this.queued;
          this.queued = null;
          this.prepare(queued);
        }
      }
    }
    if (!this.fade && now === this.last.slot && v.currentTime === this.last.t) return;
    if (!this.upload(1, now)) return;
    if (from !== now && !this.upload(0, from)) {
      // the fading-out slot can't hand over a frame right now: its texture still holds the last one, keep blending
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, from.tex);
    }
    if (from === now) {
      // no crossfade: both samplers read the frame just uploaded (no second upload)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, now.tex);
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(this.uT, t);
    gl.uniform1f(this.uE, v.videoHeight ? SEAM_ROWS / (v.videoHeight / 2) : 0.005);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.last = { slot: now, t: v.currentTime };
    if (!this.drawn) {
      this.drawn = true;
      this.onFirstFrame?.();
    }
  };
}

/**
 * `packing: "plain"`: the clips are ordinary videos (no alpha). Two <video> elements in the box take turns exactly
 * like StackedPlayer's slots; the one on screen is on top, a mid-clip switch crossfades with CSS opacity.
 */
export class PlainPlayer implements ClipPlayer {
  onEnded: (() => void) | null = null;
  onFirstFrame: (() => void) | null = null;
  onStall: (() => void) | null = null;
  onStart: ((src: string) => void) | null = null;
  private watchTimer: ReturnType<typeof setInterval>;
  private watch = new StallWatch(
    () => {
      const now = this.slots[this.cur].video;
      if (!this.paused && now.paused && !now.ended) void now.play().catch(() => {});
      const spare = this.slots[1 - this.cur];
      if (this.pending && spare.src) spare.video.load();
    },
    () => this.alive && this.onStall?.(),
  );
  private slots: { video: HTMLVideoElement; src: string }[];
  private cur = 0;
  private paused = false;
  private alive = true;
  private drawn = false;
  private waiting = 0;
  private pending = false;
  private queued: string | null = null;

  constructor(box: HTMLElement, className = "mate-plain-video") {
    const make = () => {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("aria-hidden", "true");
      video.preload = "auto";
      video.className = className;
      video.style.opacity = "0";
      box.appendChild(video);
      return { video, src: "" };
    };
    this.slots = [make(), make()];
    this.slots.forEach((s, i) => {
      s.video.addEventListener("ended", () => {
        if (i === this.cur && !s.video.loop) this.onEnded?.();
      });
      s.video.addEventListener("error", () => {
        if (this.alive && (i === this.cur || this.pending) && s.src) this.onStall?.();
      });
    });
    this.watchTimer = setInterval(() => {
      if (!this.alive || this.paused) return this.watch.check(performance.now(), -1, false, false);
      const v = this.slots[this.cur].video;
      this.watch.check(performance.now(), v.currentTime, !document.hidden && (this.pending || !v.ended), this.pending || !this.drawn);
    }, 500);
  }

  /** the old clip is still visible under a fading-in one until then (its slot must not be reloaded) */
  private fadingUntil = 0;
  private deferTimer: ReturnType<typeof setTimeout> | null = null;

  prepare(src: string): void {
    if (this.pending || performance.now() < this.fadingUntil) {
      this.queued = src;
      return;
    }
    const spare = this.slots[1 - this.cur];
    if (spare.src === src) return;
    spare.src = src;
    spare.video.src = src;
    spare.video.load();
  }

  show(src: string, opts: ShowOptions = {}): void {
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = null;
    const wait = this.fadingUntil - performance.now();
    if (wait > 0) {
      // the slot it would load into is still showing under the fade: after it
      this.deferTimer = setTimeout(() => {
        this.deferTimer = null;
        if (this.alive) this.show(src, opts);
      }, wait + 16);
      return;
    }
    const { loop = false, fadeMs = 0 } = opts;
    const now = this.slots[this.cur];
    if (now.src === src && this.drawn) {
      if (this.pending) {
        this.waiting++;
        this.pending = false;
      }
      now.video.loop = loop;
      now.video.defaultPlaybackRate = 1;
      now.video.playbackRate = 1;
      const again = now.video.ended;
      if (now.video.paused && !this.paused) void now.video.play().catch(() => {});
      if (again) this.onStart?.(src);
      return;
    }
    const next = 1 - this.cur;
    const spare = this.slots[next];
    if (spare.src !== src) {
      spare.src = src;
      spare.video.src = src;
    }
    spare.video.loop = loop;
    spare.video.defaultPlaybackRate = 1;
    spare.video.playbackRate = 1;
    seekTo(spare.video, opts.alignTo);
    const token = ++this.waiting;
    const stop = () => {
      for (const ev of WAIT) spare.video.removeEventListener(ev, go);
    };
    const go = () => {
      if (token !== this.waiting || !this.alive || spare.src !== src) return stop();
      if (spare.video.readyState < 2 || spare.video.seeking) return;
      stop();
      this.waiting++;
      this.pending = false;
      realign(spare.video, opts.alignTo);
      if (!this.paused) void spare.video.play().catch(() => {});
      const old = this.slots[this.cur];
      const fade = fadeMs > 0 && this.drawn;
      spare.video.style.transition = fade ? `opacity ${fadeMs}ms linear` : "none";
      spare.video.style.zIndex = "1";
      old.video.style.zIndex = "0";
      spare.video.style.opacity = "1";
      const hideOld = () => {
        if (this.slots[this.cur] === old) return;
        old.video.pause();
        old.video.style.transition = "none";
        old.video.style.opacity = "0";
      };
      if (fade) {
        this.fadingUntil = performance.now() + fadeMs;
        setTimeout(hideOld, fadeMs);
      } else requestAnimationFrame(hideOld);
      this.cur = next;
      this.onStart?.(src);
      if (!this.drawn) {
        this.drawn = true;
        this.onFirstFrame?.();
      }
      if (this.queued) {
        const q = this.queued;
        this.queued = null;
        setTimeout(() => this.alive && this.prepare(q), fade ? fadeMs + 20 : 50);
      }
    };
    this.pending = true;
    for (const ev of WAIT) spare.video.addEventListener(ev, go);
    go();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    for (const s of this.slots) {
      s.video.defaultPlaybackRate = 1;
      s.video.playbackRate = 1;
    }
    if (paused) for (const s of this.slots) s.video.pause();
    else void this.slots[this.cur].video.play().catch(() => {});
  }

  dispose(): void {
    this.alive = false;
    this.onStall = null;
    clearInterval(this.watchTimer);
    if (this.deferTimer) clearTimeout(this.deferTimer);
    for (const s of this.slots) {
      s.video.pause();
      s.video.removeAttribute("src");
      s.video.load();
      s.video.remove();
    }
  }
}
