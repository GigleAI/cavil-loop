// The app icon (GitHub#144): build/icon.png must be exactly what the generator
// makes from the maintainer's artwork, sit on Apple's icon grid, and the
// packaged-app check used on the macOS CI runner must tell our icon from any
// other (Electron's default included) and refuse when it cannot read things.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ICON_PNG, SOURCE_PNG, SRC_RECT, CANVAS, BODY, SAME_ICON_MAX_DISTANCE,
  decodePng, encodePng, renderIcon, bodyBox, checkApp, imageDistance, type Image,
} from '../../scripts/icon.mjs';

const source = decodePng(readFileSync(SOURCE_PNG));
const icon = decodePng(readFileSync(ICON_PNG));
const px = (img: Image, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * img.channels, (y * img.width + x + 1) * img.channels));
const bright = (img: Image, x: number, y: number) => Math.max(...px(img, x, y).slice(0, 3));

describe('icon source', () => {
  it('decodes the real PNGs like an independent decoder does', () => {
    // reference values read with Pillow from the same files
    expect([source.width, source.height, source.channels]).toEqual([1024, 1024, 3]);
    expect(px(source, 512, 512)).toEqual([254, 254, 254]);
    expect(px(source, 10, 10)).toEqual([5, 5, 5]);
    expect(px(source, 900, 150)).toEqual([219, 113, 3]);
    expect([icon.width, icon.height, icon.channels]).toEqual([1024, 1024, 4]);
    expect(px(icon, 300, 700)).toEqual([245, 150, 4, 255]);
    expect(px(icon, 512, 923)).toEqual([173, 83, 8, 255]);
  });

  it('the measured rounded square still matches the artwork (dark outside, orange rim inside)', () => {
    const midX = 512, midY = 512;
    expect(bright(source, SRC_RECT.left - 4, midY)).toBeLessThan(40);
    expect(bright(source, SRC_RECT.left + 1, midY)).toBeGreaterThan(150);
    expect(bright(source, SRC_RECT.right + 3, midY)).toBeLessThan(40);
    expect(bright(source, SRC_RECT.right - 2, midY)).toBeGreaterThan(150);
    expect(bright(source, midX, SRC_RECT.top - 4)).toBeLessThan(40);
    expect(bright(source, midX, SRC_RECT.top + 1)).toBeGreaterThan(150);
    expect(bright(source, midX, SRC_RECT.bottom + 3)).toBeLessThan(40);
    expect(bright(source, midX, SRC_RECT.bottom - 2)).toBeGreaterThan(150);
    // a corner of the square is rounded: the bounding-box corner is still margin
    expect(bright(source, SRC_RECT.left + 20, SRC_RECT.top + 20)).toBeLessThan(40);
  });
});

describe('build/icon.png', () => {
  it('is exactly what the generator makes from build/icon-source.png (regenerated and compared pixel by pixel)', () => {
    const fresh = renderIcon(source);
    expect(fresh.data.length).toBe(icon.data.length);
    let diff = 0;
    for (let i = 0; i < fresh.data.length; i++) if (fresh.data[i] !== icon.data[i]) diff++;
    expect(diff).toBe(0);
  });

  it("sits on Apple's icon grid: transparent margin, an 824 px tall body, opaque inside", () => {
    const box = bodyBox();
    expect(box.h).toBe(BODY);
    let opaqueOutside = 0;
    for (let y = 0; y < CANVAS; y++) for (let x = 0; x < CANVAS; x++) {
      const inBox = x >= Math.floor(box.x) && x < Math.ceil(box.x + box.w) && y >= Math.floor(box.y) && y < Math.ceil(box.y + box.h);
      if (!inBox && icon.data[(y * CANVAS + x) * 4 + 3] !== 0) opaqueOutside++;
    }
    expect(opaqueOutside).toBe(0);
    // the body uses the full grid height: top and bottom rows have opaque pixels, the rows beyond none
    const rowMaxAlpha = (y: number) => { let m = 0; for (let x = 0; x < CANVAS; x++) m = Math.max(m, icon.data[(y * CANVAS + x) * 4 + 3]); return m; };
    expect(rowMaxAlpha((CANVAS - BODY) / 2)).toBe(255);
    expect(rowMaxAlpha((CANVAS + BODY) / 2 - 1)).toBe(255);
    expect(rowMaxAlpha((CANVAS - BODY) / 2 - 1)).toBe(0);
    expect(rowMaxAlpha((CANVAS + BODY) / 2)).toBe(0);
    // rounded corners: the box corner is transparent, the centre fully opaque
    expect(px(icon, Math.ceil(box.x) + 3, Math.ceil(box.y) + 3)[3]).toBe(0);
    expect(px(icon, 512, 512)[3]).toBe(255);
    // no black margin carried over: along the body edge every opaque pixel is the orange rim, not near-black
    for (const [x, y] of [[Math.ceil(box.x), 512], [Math.floor(box.x + box.w) - 1, 512], [512, Math.ceil(box.y)], [512, Math.floor(box.y + box.h) - 1]]) {
      const p = px(icon, x, y);
      if (p[3] > 0) expect(Math.max(p[0], p[1], p[2])).toBeGreaterThan(120);
    }
  });
});

// A fake .app with the same layout electron-builder writes on macOS.
function fakeApp(opts: { plistIcon?: string | null; icnsName?: string; icns?: Buffer | null }) {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-icon-'));
  const app = join(dir, 'Cavil Loop.app');
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  const key = opts.plistIcon === null ? '' : `<key>CFBundleIconFile</key>\n    <string>${opts.plistIcon ?? 'icon.icns'}</string>\n    `;
  writeFileSync(join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n  <dict>\n    <key>CFBundleName</key>\n    <string>Cavil Loop</string>\n    ${key}</dict>\n</plist>\n`);
  if (opts.icns !== null) writeFileSync(join(app, 'Contents', 'Resources', opts.icnsName ?? 'icon.icns'), opts.icns ?? Buffer.alloc(0));
  return { app, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function icns(entries: [string, Buffer][]) {
  const parts = entries.map(([t, d]) => { const h = Buffer.alloc(8); h.write(t, 0, 'latin1'); h.writeUInt32BE(d.length + 8, 4); return Buffer.concat([h, d]); });
  const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.write('icns', 0, 'latin1'); h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}
const solid = (n: number, rgba: number[]) => { const d = new Uint8Array(n * n * 4); for (let i = 0; i < d.length; i += 4) d.set(rgba, i); return encodePng({ width: n, height: n, data: d }); };
const shrink = (img: Image, n: number) => { // nearest-neighbour copy, like a smaller icns slot
  const d = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) d.set(img.data.subarray(((Math.floor(y * img.height / n)) * img.width + Math.floor(x * img.width / n)) * 4, ((Math.floor(y * img.height / n)) * img.width + Math.floor(x * img.width / n)) * 4 + 4), (y * n + x) * 4);
  return encodePng({ width: n, height: n, data: d });
};
const iconBytes = readFileSync(ICON_PNG);

describe('packaged-app icon check (runs on the macOS CI runner)', () => {
  it('passes when the largest image in the named .icns is build/icon.png', () => {
    const { app, cleanup } = fakeApp({ icns: icns([['ic07', shrink(icon, 128)], ['ic10', iconBytes], ['ic09', shrink(icon, 512)]]) });
    try {
      const r = checkApp(app, ICON_PNG);
      expect(r).toMatchObject({ icon: 'icon.icns', entry: 'ic10', size: '1024x1024', ok: true });
      expect(r.distance).toBe(0);
    } finally { cleanup(); }
  });

  it('fails on a different picture, even when the smaller slots are ours', () => {
    const { app, cleanup } = fakeApp({ plistIcon: 'electron.icns', icnsName: 'electron.icns', icns: icns([['ic09', shrink(icon, 512)], ['ic10', solid(1024, [70, 140, 220, 255])]]) });
    try {
      const r = checkApp(app, ICON_PNG);
      expect(r.ok).toBe(false);
      expect(r.distance).toBeGreaterThan(SAME_ICON_MAX_DISTANCE * 5);
    } finally { cleanup(); }
  });

  it('fails on the source artwork itself (black margin, no Apple grid)', () => {
    expect(imageDistance(source, icon)).toBeGreaterThan(SAME_ICON_MAX_DISTANCE);
  });

  it('allows for the packager re-scaling: our icon at 512 px still passes', () => {
    const { app, cleanup } = fakeApp({ icns: icns([['ic09', shrink(icon, 512)]]) });
    try { expect(checkApp(app, ICON_PNG).ok).toBe(true); } finally { cleanup(); }
  });

  it('cannot read → refuses, never passes', () => {
    const cases: [string, Parameters<typeof fakeApp>[0], RegExp][] = [
      ['Info.plist names no icon', { plistIcon: null, icns: icns([['ic10', iconBytes]]) }, /CFBundleIconFile/],
      ['named .icns is missing', { icnsName: 'other.icns', icns: icns([['ic10', iconBytes]]) }, /does not exist/],
      ['.icns is empty', { icns: Buffer.alloc(0) }, /not an \.icns/],
      ['.icns is cut short', { icns: icns([['ic10', iconBytes]]).subarray(0, 5000) }, /past the end/],
      ['.icns holds no PNG', { icns: icns([['is32', Buffer.alloc(300)]]) }, /no PNG/],
    ];
    for (const [what, opts, msg] of cases) {
      const { app, cleanup } = fakeApp(opts);
      try { expect(() => checkApp(app, ICON_PNG), what).toThrow(msg); } finally { cleanup(); }
    }
  });

  it('the command-line entry the CI script calls exits 0 only on a match', () => {
    const script = join(__dirname, '..', '..', 'scripts', 'icon.mjs');
    const good = fakeApp({ icns: icns([['ic10', iconBytes]]) });
    const bad = fakeApp({ icns: icns([['ic10', solid(1024, [0, 0, 0, 255])]]) });
    const broken = fakeApp({ icns: null });
    try {
      const run = (app: string) => spawnSync(process.execPath, [script, 'check-app', app, ICON_PNG], { encoding: 'utf8' });
      const g = run(good.app), b = run(bad.app), x = run(broken.app);
      expect(g.status, g.stderr).toBe(0);
      expect(g.stdout).toContain('distance to');
      expect(b.status).toBe(1);
      expect(b.stderr).toContain('not build/icon.png');
      expect(x.status).toBe(1);
      expect(x.stderr).toContain('does not exist');
    } finally { good.cleanup(); bad.cleanup(); broken.cleanup(); }
  });
});
