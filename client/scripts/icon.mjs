#!/usr/bin/env node
// The app icon (GitHub#144). One source, one generator, one checker:
//
//   build/icon-source.png  the maintainer's original artwork, unmodified pixels
//                          (decoded once from the 1024x1024 JPEG attached to
//                          GitHub#144, sha256 0fb66bd3…f22f0). Black margin,
//                          orange rounded square in the middle.
//   build/icon.png         what electron-builder turns into the app's .icns
//                          (it reads build/icon.png by convention; the packaging
//                          config names no icon). Generated from the source by
//                          `node scripts/icon.mjs build` — never edit by hand.
//
// What the generator does: cut the rounded square out of the source (the black
// margin becomes transparent), scale it to Apple's icon grid (an 824 px tall
// body centred on a 1024 px transparent canvas; macOS no longer pads or masks
// app icons itself, so a full-bleed square looks a size too big in the Dock).
// The artwork is not otherwise touched: no recolouring, no re-drawing.
//
//   node scripts/icon.mjs build                      write build/icon.png
//   node scripts/icon.mjs check-app <App.app> <png>  (macOS CI) the packaged app
//        really carries <png> as its icon — exit 1 otherwise, including when
//        anything cannot be read: "can't tell" never counts as a pass.
//
// No dependencies: PNG decode / encode and .icns reading are below, so the same
// code runs in the unit tests (Linux), by hand, and on the macOS CI runner.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
export const SOURCE_PNG = join(BUILD_DIR, 'icon-source.png');
export const ICON_PNG = join(BUILD_DIR, 'icon.png');

// The rounded square in the source, measured on the original (edges found by
// scanning for the orange rim; corner radius fitted on all four corners:
// 200–204 px). Edges are exclusive and pulled in by 1 px so no black margin
// bleeds into the anti-aliased rim.
export const SRC_RECT = { left: 51, top: 44, right: 972, bottom: 981, radius: 201 };
export const CANVAS = 1024;
export const BODY = 824; // Apple macOS icon grid: body height inside the 1024 canvas
const SUB = 4; // 4x4 supersampling per output pixel (coverage + colour)

// ---------- PNG ----------

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decode an 8-bit, non-interlaced RGB / RGBA PNG. Anything else throws. */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, ctype = -1, depth = 0, interlace = 0;
  const idat = [];
  let sawEnd = false;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > buf.length) throw new Error(`PNG chunk ${type} runs past the end`);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { sawEnd = true; break; }
    off += 12 + len;
  }
  if (!sawEnd) throw new Error('PNG has no IEND');
  if (depth !== 8 || (ctype !== 2 && ctype !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${ctype}, interlace ${interlace})`);
  }
  const channels = ctype === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error('PNG data has the wrong length');
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y > 0 ? out[row - stride + x] : 0;
      const c = x >= channels && y > 0 ? out[row - stride + x - channels] : 0;
      let v;
      switch (f) {
        case 0: v = src[x]; break;
        case 1: v = src[x] + a; break;
        case 2: v = src[x] + b; break;
        case 3: v = src[x] + ((a + b) >> 1); break;
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = src[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error(`bad PNG filter ${f}`);
      }
      out[row + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode RGBA pixels as an 8-bit PNG (per-row filter picked by min-sum). */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const cur = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = null, bestSum = Infinity;
    for (let f = 0; f <= 4; f++) {
      const line = Buffer.alloc(stride + 1); line[0] = f; let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? cur[x - 4] : 0, b = prev ? prev[x] : 0, c = prev && x >= 4 ? prev[x - 4] : 0;
        let p;
        if (f === 0) p = 0; else if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
        else { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const v = (cur[x] - p) & 255; line[x + 1] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = line; }
    }
    rows.push(best);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- generator ----------

/** Is source point (x, y) inside the rounded square? */
export function insideSource(x, y, r = SRC_RECT) {
  if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) return false;
  const cx = x < r.left + r.radius ? r.left + r.radius : x > r.right - r.radius ? r.right - r.radius : x;
  const cy = y < r.top + r.radius ? r.top + r.radius : y > r.bottom - r.radius ? r.bottom - r.radius : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r.radius * r.radius;
}

/** Where the body lands on the canvas (uniform scale, centred). */
export function bodyBox(r = SRC_RECT) {
  const scale = BODY / (r.bottom - r.top);
  const w = (r.right - r.left) * scale, h = BODY;
  return { scale, x: (CANVAS - w) / 2, y: (CANVAS - h) / 2, w, h };
}

/** source RGB(A) image → 1024x1024 RGBA icon pixels. Pure and deterministic. */
export function renderIcon(src) {
  const { width: sw, height: sh, channels: ch, data: sd } = src;
  const box = bodyBox();
  const out = new Uint8Array(CANVAS * CANVAS * 4);
  const sample = (x, y, k) => { // bilinear, pixel centres at +0.5
    const fx = Math.min(Math.max(x - 0.5, 0), sw - 1), fy = Math.min(Math.max(y - 0.5, 0), sh - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
    const tx = fx - x0, ty = fy - y0;
    const p = (xx, yy) => sd[(yy * sw + xx) * ch + k];
    return (p(x0, y0) * (1 - tx) + p(x1, y0) * tx) * (1 - ty) + (p(x0, y1) * (1 - tx) + p(x1, y1) * tx) * ty;
  };
  const y0 = Math.floor(box.y), y1 = Math.ceil(box.y + box.h), x0 = Math.floor(box.x), x1 = Math.ceil(box.x + box.w);
  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      let n = 0, rs = 0, gs = 0, bs = 0;
      for (let j = 0; j < SUB; j++) {
        for (let i = 0; i < SUB; i++) {
          const sx = SRC_RECT.left + (tx + (i + 0.5) / SUB - box.x) / box.scale;
          const sy = SRC_RECT.top + (ty + (j + 0.5) / SUB - box.y) / box.scale;
          if (!insideSource(sx, sy)) continue;
          n++; rs += sample(sx, sy, 0); gs += sample(sx, sy, 1); bs += sample(sx, sy, 2);
        }
      }
      if (!n) continue;
      const o = (ty * CANVAS + tx) * 4;
      out[o] = Math.round(rs / n); out[o + 1] = Math.round(gs / n); out[o + 2] = Math.round(bs / n);
      out[o + 3] = Math.round((255 * n) / (SUB * SUB));
    }
  }
  return { width: CANVAS, height: CANVAS, channels: 4, data: out };
}

// ---------- comparing / reading the packaged icon ----------

function toRgba(img) {
  if (img.channels === 4) return img.data;
  const out = new Uint8Array(img.width * img.height * 4);
  for (let i = 0, j = 0; i < img.data.length; i += 3, j += 4) { out[j] = img.data[i]; out[j + 1] = img.data[i + 1]; out[j + 2] = img.data[i + 2]; out[j + 3] = 255; }
  return out;
}

/** Box-average to n×n, alpha-premultiplied (the colour of fully transparent pixels does not matter). */
export function thumbnail(img, n = 64) {
  const d = toRgba(img), out = new Float64Array(n * n * 4);
  for (let y = 0; y < img.height; y++) {
    const ty = Math.floor((y * n) / img.height);
    for (let x = 0; x < img.width; x++) {
      const tx = Math.floor((x * n) / img.width), o = (y * img.width + x) * 4, t = (ty * n + tx) * 4, a = d[o + 3] / 255;
      out[t] += d[o] * a; out[t + 1] += d[o + 1] * a; out[t + 2] += d[o + 2] * a; out[t + 3] += d[o + 3];
    }
  }
  const per = (img.width / n) * (img.height / n);
  for (let i = 0; i < out.length; i++) out[i] /= per;
  return out;
}

/** Mean absolute difference (0–255) between two images at 64×64, premultiplied. */
export function imageDistance(a, b) {
  const ta = thumbnail(a), tb = thumbnail(b);
  let s = 0; for (let i = 0; i < ta.length; i++) s += Math.abs(ta[i] - tb[i]);
  return s / ta.length;
}
/** Same picture, allowing for re-encoding / resampling by the packager. */
export const SAME_ICON_MAX_DISTANCE = 4;

/** All entries of an .icns file: [{ type, data }]. Throws on a malformed file. */
export function readIcns(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'icns') throw new Error('not an .icns file');
  const total = buf.readUInt32BE(4);
  if (total > buf.length) throw new Error('.icns header length runs past the end');
  const entries = [];
  for (let off = 8; off < total;) {
    if (off + 8 > total) throw new Error('.icns entry header runs past the end');
    const type = buf.toString('latin1', off, off + 4), len = buf.readUInt32BE(off + 4);
    if (len < 8 || off + len > total) throw new Error(`.icns entry ${type} has a bad length`);
    entries.push({ type, data: buf.subarray(off + 8, off + len) });
    off += len;
  }
  return entries;
}

/** The largest PNG image stored in an .icns (modern icns keep PNGs for 128 px and up). */
export function largestIcnsPng(buf) {
  let best = null;
  for (const e of readIcns(buf)) {
    if (!e.data.subarray(0, 8).equals(PNG_SIG)) continue;
    const img = decodePng(Buffer.from(e.data));
    if (!best || img.width > best.img.width) best = { type: e.type, img };
  }
  if (!best) throw new Error('.icns holds no PNG image');
  return best;
}

/** Which icon file Info.plist names (XML plist as written by electron-builder). */
export function plistIconFile(xml) {
  const m = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
  if (!m) throw new Error('Info.plist names no CFBundleIconFile');
  return /\.icns$/.test(m[1]) ? m[1] : `${m[1]}.icns`;
}

/** Check a packaged .app against the expected icon PNG. Returns a report; `ok` only when every step read fine and matched. */
export function checkApp(appPath, expectedPng) {
  const plist = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8');
  const name = plistIconFile(plist);
  const icnsPath = join(appPath, 'Contents', 'Resources', name);
  if (!existsSync(icnsPath)) throw new Error(`Info.plist names ${name}, but Contents/Resources/${name} does not exist`);
  const { type, img } = largestIcnsPng(readFileSync(icnsPath));
  const expected = decodePng(readFileSync(expectedPng));
  const distance = imageDistance(img, expected);
  return { icon: name, entry: type, size: `${img.width}x${img.height}`, distance, ok: distance <= SAME_ICON_MAX_DISTANCE, img };
}

// ---------- CLI ----------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'build') {
      writeFileSync(ICON_PNG, encodePng(renderIcon(decodePng(readFileSync(SOURCE_PNG)))));
      console.log(`wrote ${ICON_PNG}`);
    } else if (cmd === 'check-app' && args.length >= 2) {
      const r = checkApp(args[0], args[1]);
      console.log(`app icon: ${r.icon}, largest image ${r.entry} ${r.size}, distance to ${args[1]} = ${r.distance.toFixed(2)} (pass ≤ ${SAME_ICON_MAX_DISTANCE})`);
      if (args[2]) writeFileSync(args[2], encodePng({ width: r.img.width, height: r.img.height, data: toRgba(r.img) }));
      if (!r.ok) { console.error('❌ the packaged app icon is not build/icon.png'); process.exit(1); }
      console.log('✅ the packaged app icon is build/icon.png');
    } else {
      console.error('usage: icon.mjs build | icon.mjs check-app <App.app> <expected.png> [extracted-out.png]');
      process.exit(2);
    }
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
