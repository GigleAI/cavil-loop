#!/usr/bin/env node
// Build the window (Vite) into dist/renderer — what the Tauri app ships
// (src-tauri/tauri.conf.json → frontendDist). The Rust side is built by cargo.
//
//   node scripts/build.mjs                 the app's window
//   node scripts/build.mjs --test-bridge   dist/renderer-test: the same window reaching the
//                                          back end through a loopback bridge (UI tests only;
//                                          that code is never in the app's build)
import { build as vite } from 'vite';
import react from '@vitejs/plugin-react';
import { rmSync, mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testBridge = process.argv.includes('--test-bridge');
const outDir = join(root, 'dist', testBridge ? 'renderer-test' : 'renderer');
rmSync(outDir, { recursive: true, force: true });

await vite({
  root: join(root, 'src/renderer'),
  base: './',
  plugins: [react()],
  logLevel: 'warn',
  define: { CAVIL_TEST_BRIDGE: JSON.stringify(testBridge) },
  // macOS 11's WebKit (Safari 14) is the oldest engine the app runs on
  build: { outDir, emptyOutDir: true, sourcemap: testBridge, target: ['safari14', 'chrome110'] },
});
console.log(`built ${outDir.slice(root.length + 1)}/`);

// The app's icon set (src-tauri/icons, not committed): generated from build/icon.png — the one
// icon source (GitHub#144) — by Tauri's own generator, so the .icns has every slot macOS asks for.
if (!testBridge) {
  const tmp = mkdtempSync(join(tmpdir(), 'cavil-icons-'));
  execFileSync(join(root, 'node_modules', '.bin', 'tauri'), ['icon', join(root, 'build', 'icon.png'), '-o', tmp], { stdio: 'ignore' });
  const icons = join(root, 'src-tauri', 'icons');
  mkdirSync(icons, { recursive: true });
  for (const f of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.icns']) copyFileSync(join(tmp, f), join(icons, f));
  rmSync(tmp, { recursive: true, force: true });
  console.log('built src-tauri/icons/ from build/icon.png');
}
