// PNG pictures of the screen without holding up the main process (capture.js). NativeImage.toPNG() and resize() run
// synchronously on Electron's main thread — for a 4K screen a few hundred ms, per screen when all screens are shared —
// and on Windows the mouse waits for that thread meanwhile: the click-through avatar and its bar forward the mouse
// with a low-level mouse hook (setIgnoreMouseEvents(…, { forward: true })) that lives there, so every pointer move of
// the whole desktop stuttered while a picture was encoded. Here the main thread only copies the raw pixels, a strip
// at a time with a turn of its event loop in between (toBitmap() of crop()s: a few ms each), and a worker thread
// filters and deflates them; the picture is still a PNG.
"use strict";

/** zlib level: on 4K screenshots 4 costs ~10 % less time than 6 for ~3 % more bytes (1–3: 10–40 % more bytes) */
const LEVEL = 4;
/** the pixels copied per turn of the main thread (~2 ms) */
const STRIP_BYTES = 2 << 20;

/**
 * PNG of raw Skia pixels: BGRA, premultiplied (what NativeImage.toBitmap() gives; rows may be padded). RGB when every
 * pixel is opaque (a screen), else RGBA (a window with see-through corners). Self-contained: it also runs, as source
 * text, in the worker.
 */
function encodePng(pixels, width, height, level) {
  const zlib = require("zlib");
  const src = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const W = width | 0;
  const H = height | 0;
  const stride = H > 1 ? (src.length - W * 4) / (H - 1) : W * 4;
  if (!(W > 0 && H > 0) || !Number.isInteger(stride) || stride < W * 4 || src.length < stride * (H - 1) + W * 4) {
    throw new Error(`not a ${W}×${H} bitmap (${src.length} bytes)`);
  }
  let opaque = true;
  for (let y = 0; y < H && opaque; y++) {
    for (let i = y * stride + 3, end = y * stride + W * 4; i < end; i += 4) {
      if (src[i] !== 255) {
        opaque = false;
        break;
      }
    }
  }
  const bpp = opaque ? 3 : 4;
  const line = W * bpp;
  // each row as RGB(A), then filtered "Sub" (the difference to the pixel on its left): flat UI, text and gradients
  // shrink well, in one pass
  const raw = Buffer.allocUnsafe((line + 1) * H);
  const row = Buffer.allocUnsafe(line);
  for (let y = 0; y < H; y++) {
    let s = y * stride;
    if (opaque) {
      for (let x = 0; x < line; x += 3, s += 4) {
        row[x] = src[s + 2];
        row[x + 1] = src[s + 1];
        row[x + 2] = src[s];
      }
    } else {
      for (let x = 0; x < line; x += 4, s += 4) {
        const a = src[s + 3];
        if (a === 255) {
          row[x] = src[s + 2];
          row[x + 1] = src[s + 1];
          row[x + 2] = src[s];
        } else if (a === 0) {
          row[x] = row[x + 1] = row[x + 2] = 0;
        } else {
          // (premultiplied → straight alpha)
          row[x] = Math.min(255, Math.round((src[s + 2] * 255) / a));
          row[x + 1] = Math.min(255, Math.round((src[s + 1] * 255) / a));
          row[x + 2] = Math.min(255, Math.round((src[s] * 255) / a));
        }
        row[x + 3] = a;
      }
    }
    const o = y * (line + 1);
    raw[o] = 1; // Sub
    for (let x = 0; x < bpp; x++) raw[o + 1 + x] = row[x];
    for (let x = bpp; x < line; x++) raw[o + 1 + x] = (row[x] - row[x - bpp]) & 255;
  }
  const idat = zlib.deflateSync(raw, { level: Number.isInteger(level) ? level : 4 });
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buf, start, end) => {
    if (zlib.crc32) return zlib.crc32(buf.subarray(start, end)) >>> 0;
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = table[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = opaque ? 2 : 6; // RGB | RGBA
  const chunks = [["IHDR", ihdr], ["IDAT", idat], ["IEND", Buffer.alloc(0)]];
  // (not from Buffer's shared pool: the worker hands this memory over instead of copying it)
  const out = Buffer.allocUnsafeSlow(8 + chunks.reduce((n, [, data]) => n + 12 + data.length, 0));
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    out.writeUInt32BE(data.length, at);
    out.write(type, at + 4, "latin1");
    data.copy(out, at + 8);
    out.writeUInt32BE(crc32(out, at + 4, at + 8 + data.length), at + 8 + data.length);
    at += 12 + data.length;
  }
  return out;
}

// (source text, not a file: a worker started from a path would have to be read out of the packed app.asar)
const WORKER_SOURCE = `"use strict";
const { parentPort } = require("worker_threads");
const encodePng = ${encodePng.toString()};
parentPort.on("message", ({ id, parts, width, height, level }) => {
  try {
    const pixels = parts.length === 1 ? parts[0] : Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
    const png = encodePng(pixels, width, height, level);
    parentPort.postMessage({ id, png }, [png.buffer]);
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) });
  }
});`;

/**
 * One worker thread for the pictures, started when the first one comes and stopped after `idleMs` without any.
 * encode(pixels, width, height) → Promise<Buffer> (pixels: a Buffer / Uint8Array of BGRA, or such strips top to
 * bottom; each is handed over to the worker, not copied, when it owns its memory — not to be used afterwards).
 */
function createEncoder({ Worker = require("worker_threads").Worker, idleMs = 20_000, level = LEVEL } = {}) {
  let worker = null;
  let idle = null;
  let seq = 0;
  const waiting = new Map();

  function stopped(w, err) {
    if (worker !== w) return;
    worker = null;
    for (const job of waiting.values()) job.reject(err);
    waiting.clear();
  }
  function start() {
    const w = new Worker(WORKER_SOURCE, { eval: true });
    w.unref?.();
    w.on("message", ({ id, png, error }) => {
      const job = waiting.get(id);
      if (!job) return;
      waiting.delete(id);
      if (error) job.reject(new Error(error));
      else job.resolve(Buffer.from(png.buffer, png.byteOffset, png.byteLength));
      if (!waiting.size) rest();
    });
    w.on("error", (e) => stopped(w, e));
    w.on("exit", (code) => stopped(w, new Error(`PNG worker stopped (${code})`)));
    return w;
  }
  function rest() {
    clearTimeout(idle);
    idle = setTimeout(close, idleMs);
    idle.unref?.();
  }
  function close() {
    clearTimeout(idle);
    const w = worker;
    worker = null;
    if (w) {
      stopped(w, new Error("PNG worker closed"));
      w.terminate();
    }
  }
  function encode(pixels, width, height) {
    clearTimeout(idle);
    if (!worker) worker = start();
    const w = worker;
    const id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      const parts = (Array.isArray(pixels) ? pixels : [pixels]).map((p) => new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
      const own = parts.filter((v) => v.byteOffset === 0 && v.byteLength === v.buffer.byteLength).map((v) => v.buffer);
      try {
        w.postMessage({ id, parts, width, height, level }, [...new Set(own)]);
      } catch (e) {
        waiting.delete(id);
        reject(e);
      }
    });
  }
  return { encode, close, busy: () => waiting.size > 0 };
}

/** the raw pixels of a NativeImage, in strips of `stripBytes` (crop() shares the pixels; toBitmap() copies one strip)
 *  with a turn of the event loop between them → [Buffer] top to bottom, or null (not a plain bitmap: toPNG()) */
async function bitmapStrips(img, width, height, { stripBytes = STRIP_BYTES, breathe = () => new Promise((r) => setImmediate(r)) } = {}) {
  const rows = Math.max(1, Math.floor(stripBytes / (width * 4)));
  if (rows >= height || typeof img.crop !== "function") {
    const all = img.toBitmap();
    return all && all.length >= width * height * 4 ? [all] : null;
  }
  const strips = [];
  for (let y = 0; y < height; y += rows) {
    if (y) await breathe();
    const h = Math.min(rows, height - y);
    const part = img.crop({ x: 0, y, width, height: h }).toBitmap();
    if (!part || part.length !== width * h * 4) return null;
    strips.push(part);
  }
  return strips;
}

let shared = null;
/**
 * A NativeImage as a PNG, encoded off the main thread. Without a worker (or a bitmap) it is NativeImage.toPNG() here,
 * as before.
 */
async function imagePng(img, { encoder, stripBytes } = {}) {
  if (typeof img.toBitmap !== "function") return img.toPNG();
  const { width, height } = img.getSize();
  let strips;
  try {
    strips = await bitmapStrips(img, width, height, { stripBytes });
  } catch {
    strips = null;
  }
  if (!strips) return img.toPNG();
  try {
    return await (encoder || (shared ??= createEncoder())).encode(strips, width, height);
  } catch {
    return img.toPNG();
  }
}

module.exports = { LEVEL, STRIP_BYTES, encodePng, createEncoder, bitmapStrips, imagePng, WORKER_SOURCE };
