// PNG pictures off the main thread (src/png.js, used by src/capture.js): the encoder's output read back pixel for
// pixel, the worker (the main thread stays free while a 4K screen is encoded — the timings are printed), and the
// fallback to NativeImage.toPNG().
// Run: node --test test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { encodePng, createEncoder, imagePng } = require("../src/png");

/** a PNG back to RGBA rows (8-bit RGB / RGBA, any of the five filters) + its chunks' CRCs checked */
function decode(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let ihdr = null;
  const idat = [];
  for (;;) {
    const len = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    assert.equal(png.readUInt32BE(at + 8 + len), zlib.crc32(png.subarray(at + 4, at + 8 + len)) >>> 0, `${type} CRC`);
    if (type === "IHDR") ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
    if (type === "IDAT") idat.push(data);
    at += 12 + len;
    if (type === "IEND") break;
  }
  assert.equal(at, png.length);
  const bpp = ihdr.color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const line = ihdr.w * bpp;
  const out = Buffer.alloc(ihdr.w * ihdr.h * 4);
  let prev = Buffer.alloc(line);
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[y * (line + 1)];
    const cur = Buffer.from(raw.subarray(y * (line + 1) + 1, (y + 1) * (line + 1)));
    for (let x = 0; x < line; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const add = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      cur[x] = (cur[x] + add) & 255;
    }
    for (let x = 0; x < ihdr.w; x++) {
      for (let k = 0; k < 3; k++) out[(y * ihdr.w + x) * 4 + k] = cur[x * bpp + k];
      out[(y * ihdr.w + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = cur;
  }
  return { ...ihdr, rgba: out };
}

/** BGRA, premultiplied (Skia's N32, what toBitmap() gives), `pad` bytes at the end of each row */
function bitmap(w, h, px, pad = 0) {
  const stride = w * 4 + pad;
  const buf = Buffer.alloc(stride * (h - 1) + w * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      const o = y * stride + x * 4;
      buf[o] = Math.round((b * a) / 255);
      buf[o + 1] = Math.round((g * a) / 255);
      buf[o + 2] = Math.round((r * a) / 255);
      buf[o + 3] = a;
    }
  }
  return buf;
}

/** something like a desktop: a gradient, flat panels, lines of "text" */
const desktopLike = (x, y) => {
  if (y % 40 > 30 && x % 9 < 6 && ((x * 7 + y * 3) >> 4) % 5) return [20, 22, 28, 255];
  if (x > 600 && x < 1800 && y > 200 && y < 1400) return [246, 247, 250, 255];
  return [Math.floor((x * 255) / 3840), 90, Math.floor((y * 255) / 2160), 255];
};

test("encodePng: an opaque screen → RGB, every pixel back as it was (padded rows too)", () => {
  const px = (x, y) => [(x * 37 + y) & 255, (y * 11) & 255, (x ^ y) & 255, 255];
  for (const pad of [0, 12]) {
    const png = encodePng(bitmap(23, 7, px, pad), 23, 7, 4);
    const d = decode(png);
    assert.deepEqual([d.w, d.h, d.depth, d.color], [23, 7, 8, 2]);
    for (let y = 0; y < 7; y++) for (let x = 0; x < 23; x++) assert.deepEqual([...d.rgba.subarray((y * 23 + x) * 4, (y * 23 + x) * 4 + 4)], px(x, y));
  }
});

test("encodePng: see-through pixels → RGBA, un-premultiplied", () => {
  const px = (x, y) => (x === 0 ? [0, 0, 0, 0] : x === 1 ? [200, 100, 50, 128] : [10 * x, 20 * y, 30, 255]);
  const d = decode(encodePng(bitmap(5, 3, px), 5, 3, 6));
  assert.equal(d.color, 6);
  const at = (x, y) => [...d.rgba.subarray((y * 5 + x) * 4, (y * 5 + x) * 4 + 4)];
  assert.deepEqual(at(0, 1), [0, 0, 0, 0]);
  const half = at(1, 2);
  assert.equal(half[3], 128);
  [200, 100, 50].forEach((v, k) => assert.ok(Math.abs(half[k] - v) <= 2, `${half} ≈ 200,100,50`)); // (8-bit premultiplied)
  assert.deepEqual(at(4, 2), [40, 40, 30, 255]);
  assert.throws(() => encodePng(Buffer.alloc(10), 5, 3, 4), /not a 5×3 bitmap/);
});

test("the worker: the same PNG as here, the pixels handed over (not copied), and it stops when idle", async () => {
  const enc = createEncoder({ idleMs: 50 });
  const pixels = bitmap(64, 32, desktopLike);
  const expected = encodePng(pixels, 64, 32, 4);
  const own = new Uint8Array(new ArrayBuffer(pixels.length));
  own.set(pixels);
  const png = await enc.encode(own, 64, 32);
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.equals(expected));
  assert.equal(own.byteLength, 0, "transferred to the worker");
  // a bad bitmap: rejected, the worker keeps serving
  await assert.rejects(enc.encode(Buffer.alloc(8), 64, 32), /not a 64×32 bitmap/);
  assert.ok((await enc.encode(Buffer.from(pixels), 64, 32)).equals(expected));
  // strips, top to bottom (what imagePng hands over)
  const rows = (a, b) => Buffer.from(pixels.subarray(a * 64 * 4, b * 64 * 4));
  assert.ok((await enc.encode([rows(0, 5), rows(5, 30), rows(30, 32)], 64, 32)).equals(expected));
  enc.close();
  assert.ok((await enc.encode(Buffer.from(pixels), 64, 32)).equals(expected), "started again after close");
  enc.close();
});

test("imagePng: the pixels in strips (a turn between them) → the worker; no bitmap or a failing worker → toPNG()", async () => {
  const W = 8, H = 10;
  const pixels = bitmap(W, H, desktopLike);
  const turns = [];
  const img = (over = {}) => ({
    getSize: () => ({ width: W, height: H }),
    toBitmap: () => Buffer.from(pixels),
    // (NativeImage.crop: a part of the picture, its own toBitmap())
    crop: ({ x, y, width, height }) => (turns.push(["crop", x, y, width, height]), { toBitmap: () => Buffer.from(pixels.subarray(y * W * 4, (y + height) * W * 4)) }),
    toPNG: () => Buffer.from("toPNG"),
    ...over,
  });
  const got = [];
  const encoder = { encode: async (parts, w, h) => (got.push(parts.map((p) => p.length)), encodePng(Buffer.concat(parts), w, h, 4)) };
  // 3 rows a strip (96 bytes): 4 strips, the last one 1 row
  const out = await imagePng(img(), { encoder, stripBytes: W * 4 * 3 });
  assert.ok(out.equals(encodePng(pixels, W, H, 4)));
  assert.deepEqual(got, [[96, 96, 96, 32]]);
  assert.deepEqual(turns.map((c) => c[2]), [0, 3, 6, 9]);
  // small enough for one strip: toBitmap() of the whole
  got.length = 0;
  await imagePng(img(), { encoder });
  assert.deepEqual(got, [[W * H * 4]]);
  // not a plain bitmap / no worker: toPNG() on this thread, as before
  assert.equal(String(await imagePng(img({ toBitmap: undefined }), { encoder })), "toPNG");
  assert.equal(String(await imagePng(img({ toBitmap: () => Buffer.alloc(3) }), { encoder })), "toPNG");
  assert.equal(String(await imagePng(img({ crop: () => ({ toBitmap: () => Buffer.alloc(5) }) }), { encoder, stripBytes: 96 })), "toPNG");
  assert.equal(String(await imagePng(img(), { encoder: { encode: async () => { throw new Error("no worker"); } } })), "toPNG");
});

test("a 3840×2160 screen: encoded in the worker, the main thread keeps turning (timings printed)", async (t) => {
  const W = 3840, H = 2160;
  const pixels = bitmap(W, H, desktopLike);
  // on this thread (what toPNG() did: the main thread held for all of it)
  let t0 = performance.now();
  const here = encodePng(pixels, W, H, 4);
  const syncMs = performance.now() - t0;
  t0 = performance.now();
  zlib.deflateSync(pixels, { level: 6 });
  const deflate6Ms = performance.now() - t0;
  // in the worker: how long the main thread is held at a stretch meanwhile (a 1 ms timer's worst lateness)
  const enc = createEncoder();
  await enc.encode(Buffer.from(pixels.subarray(0, 64 * 4 * 2)), 64, 2); // (started)
  let worst = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 1);
    last = now;
  }, 1);
  // (a NativeImage's toBitmap() / crop(): copies of its pixels, as imagePng takes them — a strip a turn)
  const img = {
    getSize: () => ({ width: W, height: H }),
    toBitmap: () => Buffer.from(pixels),
    crop: ({ y, height }) => ({ toBitmap: () => Buffer.from(pixels.subarray(y * W * 4, (y + height) * W * 4)) }),
  };
  t0 = performance.now();
  const png = await imagePng(img, { encoder: enc });
  const workerMs = performance.now() - t0;
  clearInterval(probe);
  enc.close();
  assert.ok(png.equals(here));
  t.diagnostic(`3840x2160: on the main thread ${syncMs.toFixed(0)} ms (raw zlib level 6 alone: ${deflate6Ms.toFixed(0)} ms); ` +
    `strips + worker ${workerMs.toFixed(0)} ms in all, longest main-thread stall meanwhile ${worst.toFixed(1)} ms; ` +
    `PNG ${(png.length / 1e6).toFixed(2)} MB`);
  assert.ok(worst < Math.max(60, syncMs / 3), `the main thread stalled ${worst.toFixed(1)} ms (encoding takes ${syncMs.toFixed(0)} ms)`);
});
