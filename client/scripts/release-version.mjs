#!/usr/bin/env node
// The version of a client release (GitHub#576): one set of rules for the release a person tags by
// hand (`client/vX.Y.Z` pushed) and the one the weekly Release workflow cuts by itself.
//
// The version is no longer committed before a release: it comes from the tag and is written into
// the three version files (package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml) on the
// build machine only, the way a development build is stamped (scripts/dev-version.mjs). What is
// committed in package.json is the floor: no release below it, and a higher one there (a person
// bumping the minor version) is the next release.
//
//   next release      the highest client/vX.Y.Z tag with its patch number + 1, or package.json's
//                     version when that is higher (or no such tag exists yet)
//   a release tag     client/vX.Y.Z, X.Y.Z three plain numbers, not below package.json, and above
//                     every other client/vX.Y.Z tag (an older release is never cut after a newer one)
//   development base  the higher of package.json and the highest client/vX.Y.Z tag: a development
//                     build after release R is R.(patch+1)-dev.N, newer than R (dev-version.mjs)
//
// Only tags shaped exactly client/vX.Y.Z count; client/vX.Y.Z-dev.N and anything else are ignored.
// "Has the client changed" is measured from the highest such tag that has a Release page: a tag
// whose release failed (client/v0.5.1) never shipped, so its changes still count as unreleased.
//
//   node scripts/release-version.mjs plan --at <sha> --released <file>
//        the weekly run: key=value lines on stdout — tag= (empty: no release), version=, since=,
//        reason=. <file> = every tag that has a Release page, one per line. Reads the remote's
//        tags (git ls-remote origin); any read that fails is exit 1, never "no tags" / "no change".
//   node scripts/release-version.mjs check <tag> --at <sha>
//        a release build: the tag is a valid next release for the client at <sha> → prints X.Y.Z;
//        anything else exit 1
//   node scripts/release-version.mjs write <X.Y.Z>
//        write that version into the three files (CI's work tree only; never committed)
//   [--root <dir>]   another client directory (default: the one this script is in)
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The three version files are read and written in one place, dev-version.mjs, which imports this
// file's rules in turn. The cycle is safe: neither module calls the other while it is being loaded.
import { writeVersion } from './dev-version.mjs';

const SHAPE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const TAG_PREFIX = 'client/v';

/** X.Y.Z → [x, y, z], anything else → null */
export function parse(v) {
  const m = SHAPE.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** compare two X.Y.Z: < 0, 0, > 0 (throws on anything else) */
export function cmp(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`版本号不是 X.Y.Z：${pa ? b : a}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** tag names → the X.Y.Z of the ones shaped exactly client/vX.Y.Z */
export function releaseVersions(tags) {
  return tags.filter((t) => t.startsWith(TAG_PREFIX) && parse(t.slice(TAG_PREFIX.length))).map((t) => t.slice(TAG_PREFIX.length));
}

/** the highest X.Y.Z in a list, or null */
export function highest(versions) {
  return versions.reduce((h, v) => (h === null || cmp(v, h) > 0 ? v : h), null);
}

/** the version the next release gets: highest tag's patch + 1, or package.json's when higher */
export function nextRelease(pkg, versions) {
  if (!parse(pkg)) throw new Error(`客户端版本号不是 X.Y.Z：${pkg}`);
  const top = highest(versions);
  if (top === null || cmp(pkg, top) > 0) return pkg;
  const [x, y, z] = parse(top);
  return `${x}.${y}.${z + 1}`;
}

/** what a development build counts from: the higher of package.json and the highest release tag */
export function devBase(pkg, versions) {
  if (!parse(pkg)) throw new Error(`客户端版本号不是 X.Y.Z：${pkg}`);
  const top = highest(versions);
  return top !== null && cmp(top, pkg) > 0 ? top : pkg;
}

/** the problems with releasing `tag` for package.json version `pkg`, given every tag that exists */
export function tagProblems(tag, pkg, tags) {
  if (!String(tag).startsWith(TAG_PREFIX) || !parse(String(tag).slice(TAG_PREFIX.length))) {
    return [`标签不是 ${TAG_PREFIX}X.Y.Z：${tag}`];
  }
  const v = tag.slice(TAG_PREFIX.length);
  const out = [];
  if (!parse(pkg)) out.push(`客户端版本号不是 X.Y.Z：${pkg}`);
  else if (cmp(v, pkg) < 0) out.push(`${tag} 低于 package.json 的版本 ${pkg}`);
  const others = releaseVersions(tags.filter((t) => t !== tag));
  const top = highest(others);
  if (top !== null && cmp(v, top) <= 0) out.push(`已有 ${TAG_PREFIX}${top}，${tag} 不比它高`);
  return out;
}

const git = (root, args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};

/** the remote's client/v* tags: Map name → commit (annotated tags peeled); throws when unreadable */
export function remoteTags(root) {
  const r = git(root, ['ls-remote', '--tags', 'origin', `refs/tags/${TAG_PREFIX}*`]);
  if (r.status !== 0) throw new Error(`读不到远端的客户端标签（git ls-remote 退出码 ${r.status}）：${r.err}`);
  const plain = new Map();
  const peeled = new Map();
  for (const line of r.out.split('\n').filter(Boolean)) {
    const m = /^([0-9a-f]{40,64})\trefs\/tags\/(.+)$/.exec(line);
    if (!m) throw new Error(`看不懂 git ls-remote 的一行：${line}`);
    if (m[2].endsWith('^{}')) peeled.set(m[2].slice(0, -3), m[1]);
    else plain.set(m[2], m[1]);
  }
  return new Map([...plain].map(([n, c]) => [n, peeled.get(n) ?? c]));
}

/** package.json's version at commit `at` */
export function versionAt(root, at) {
  const r = git(root, ['show', `${at}:./package.json`]);
  if (r.status !== 0) throw new Error(`读不到 ${at} 上的 package.json：${r.err}`);
  return JSON.parse(r.out).version;
}

/** the weekly run's decision for the client at commit `at`; released = tags that have a Release page */
export function plan(root, at, released) {
  const tags = remoteTags(root);
  const pkg = versionAt(root, at);
  const versions = releaseVersions([...tags.keys()]);
  const next = nextRelease(pkg, versions);
  const tag = `${TAG_PREFIX}${next}`;
  const since = highest(versions.filter((v) => released.includes(`${TAG_PREFIX}${v}`)));
  if (since === null) {
    return { tag, version: next, since: '', reason: `还没有发出过客户端正式版，出第一个：${tag}` };
  }
  const base = tags.get(`${TAG_PREFIX}${since}`);
  if (git(root, ['cat-file', '-e', `${base}^{commit}`]).status !== 0) throw new Error(`${TAG_PREFIX}${since} 指向的提交 ${base} 这里没有`);
  const d = git(root, ['diff', '--quiet', base, at, '--', '.']);
  if (d.status === 0) return { tag: '', version: '', since: `${TAG_PREFIX}${since}`, reason: `${TAG_PREFIX}${since} 以来客户端没有改动，不出客户端正式版` };
  if (d.status !== 1) throw new Error(`比不出 ${TAG_PREFIX}${since} 以来客户端有没有改动（git diff 退出码 ${d.status}）：${d.err}`);
  return { tag, version: next, since: `${TAG_PREFIX}${since}`, reason: `${TAG_PREFIX}${since} 以来客户端有改动，出 ${tag}` };
}

/** a release build's check: → X.Y.Z, or throws with every problem */
export function check(root, tag, at) {
  const problems = tagProblems(tag, versionAt(root, at), [...remoteTags(root).keys()]);
  if (problems.length) throw new Error(problems.join('；'));
  return tag.slice(TAG_PREFIX.length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const root = opt('root') ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const [cmd, arg] = args;
    if (cmd === 'plan') {
      const at = opt('at');
      const file = opt('released');
      if (!at || !file) throw new Error('用法：plan --at <sha> --released <file>');
      const released = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      const p = plan(root, at, released);
      console.error(p.reason);
      process.stdout.write(`tag=${p.tag}\nversion=${p.version}\nsince=${p.since}\nreason=${p.reason}\n`);
    } else if (cmd === 'check') {
      const at = opt('at');
      if (!arg || !at) throw new Error('用法：check <tag> --at <sha>');
      console.log(check(root, arg, at));
    } else if (cmd === 'write') {
      if (!parse(arg)) throw new Error(`版本号不是 X.Y.Z：${arg}`);
      console.log(writeVersion(root, arg));
    } else {
      throw new Error('用法：plan --at <sha> --released <file> | check <tag> --at <sha> | write <X.Y.Z>');
    }
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}
