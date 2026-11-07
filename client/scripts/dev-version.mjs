#!/usr/bin/env node
// The version of a development build (GitHub#215): what the push-to-main build stamps into the app
// before packaging it, so the installed apps on the development channel can tell it is newer.
//
//   X.Y.(Z+1)-dev.N   X.Y.Z = the client's version (package.json, tauri.conf.json and Cargo.toml,
//                     which must agree), N = the number of commits on HEAD
//
// Why Z+1: by semver precedence `0.5.0-dev.N` is *older* than 0.5.0 — the updater would never take
// it; `0.5.1-dev.N` is newer than 0.5.0 and older than the 0.5.1 / 0.6.0 release that follows, so
// development installs move onto that release when it comes out, then on to its development builds.
// Why the commit count: main only moves forward (squash merges), so N never goes back, and the same
// commit always gets the same N (a rerun of the same build publishes the same version).
// A shallow clone cannot count its commits: refused (the build checks out the whole history).
//
//   node scripts/dev-version.mjs            print the version (nothing changes)
//   node scripts/dev-version.mjs --write    also write it into the three files (in CI's work tree only;
//                                           never committed)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** X.Y.Z + commit count → X.Y.(Z+1)-dev.N; throws on anything else. */
export function devVersion(release, count) {
  const m = RELEASE.exec(String(release ?? ''));
  if (!m) throw new Error(`客户端版本号不是 X.Y.Z：${release}`);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`提交数不对：${count}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}-dev.${count}`;
}

/** The `version` line of Cargo.toml's [package] table: { value, index, length } of the quoted value, or null. */
function cargoVersion(text) {
  const pkg = /^\[package\][^\n]*\n/m.exec(text);
  if (!pkg) return null;
  const start = pkg.index + pkg[0].length;
  const next = /^\[/m.exec(text.slice(start));
  const table = text.slice(start, next ? start + next.index : text.length);
  const v = /^version\s*=\s*"([^"\n]*)"/m.exec(table);
  if (!v) return null;
  const index = start + v.index + v[0].indexOf('"') + 1;
  return { value: v[1], index, length: v[1].length };
}

/** The three places the client's version lives, read. */
export function readVersions(root) {
  const files = { pkg: join(root, 'package.json'), conf: join(root, 'src-tauri', 'tauri.conf.json'), cargo: join(root, 'src-tauri', 'Cargo.toml') };
  const text = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f, 'utf8')]));
  return {
    files,
    text,
    pkg: JSON.parse(text.pkg).version,
    conf: JSON.parse(text.conf).version,
    cargo: cargoVersion(text.cargo)?.value ?? null,
  };
}

/** Commits on HEAD in `root`'s repository; throws in a shallow clone (the count would be wrong). */
export function commitCount(root) {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
  if (git('rev-parse', '--is-shallow-repository') !== 'false') throw new Error('这是浅克隆，数不出提交数（打包要取完整历史：fetch-depth: 0）');
  const n = Number(git('rev-list', '--count', 'HEAD'));
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`数不出提交数：${n}`);
  return n;
}

/** → the development version for `root` (and, with write, puts it in the three files). */
export function stamp(root, { write = false, count = commitCount(root) } = {}) {
  const v = readVersions(root);
  if (!(v.pkg === v.conf && v.conf === v.cargo)) throw new Error(`三处版本号不一致：package.json ${v.pkg}，tauri.conf.json ${v.conf}，Cargo.toml ${v.cargo}`);
  const dev = devVersion(v.pkg, count);
  if (write) {
    const pkg = JSON.parse(v.text.pkg);
    pkg.version = dev;
    writeFileSync(v.files.pkg, `${JSON.stringify(pkg, null, 2)}\n`);
    const conf = JSON.parse(v.text.conf);
    conf.version = dev;
    writeFileSync(v.files.conf, `${JSON.stringify(conf, null, 2)}\n`);
    const c = cargoVersion(v.text.cargo);
    writeFileSync(v.files.cargo, v.text.cargo.slice(0, c.index) + dev + v.text.cargo.slice(c.index + c.length));
    const after = readVersions(root);
    if (!(after.pkg === dev && after.conf === dev && after.cargo === dev)) throw new Error('写完再读，三处版本号不是新版本号');
  }
  return dev;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    console.log(stamp(root, { write: process.argv.includes('--write') }));
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}
