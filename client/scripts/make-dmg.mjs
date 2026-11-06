#!/usr/bin/env node
// macOS installer: the .app Tauri built (`tauri build --bundles app`) into
// release/Cavil-Loop-<version>-<arch>.dmg, laid out by dmgbuild
// (scripts/dmg-settings.py, layout from scripts/dmg-layout.mjs). Tauri's own dmg
// step cannot add the first-open files (copy page, instructions), which is why this exists.
//
//   node scripts/make-dmg.mjs [--arch arm64|x64] [--app <path to .app>]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DMG_ICONS, DMG_ICON_SIZE, DMG_WINDOW } from './dmg-layout.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const arch = arg('--arch') ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function findApp() {
  const given = arg('--app');
  if (given) return given;
  // target/<triple>/release/bundle/macos (cross build) or target/release/bundle/macos
  const target = join(root, 'src-tauri', 'target');
  const dirs = [join(target, 'release', 'bundle', 'macos')];
  if (existsSync(target)) for (const t of readdirSync(target)) dirs.push(join(target, t, 'release', 'bundle', 'macos'));
  const found = dirs.filter((d) => existsSync(join(d, 'Cavil Loop.app'))).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!found.length) throw new Error('no "Cavil Loop.app" under src-tauri/target/**/bundle/macos: run `tauri build --bundles app` first');
  return join(found[0], 'Cavil Loop.app');
}

const app = findApp();
mkdirSync(join(root, 'release'), { recursive: true });
const out = join(root, 'release', `Cavil-Loop-${version}-${arch}.dmg`);
const layout = JSON.stringify({ window: DMG_WINDOW, iconSize: DMG_ICON_SIZE, icons: DMG_ICONS });
execFileSync('dmgbuild', ['-s', join(root, 'scripts', 'dmg-settings.py'), '-D', `app=${app}`, '-D', `build=${join(root, 'build')}`, '-D', `layout=${layout}`, 'Cavil Loop', out], { stdio: 'inherit' });
console.log(`${out} ${statSync(out).size} bytes`);
