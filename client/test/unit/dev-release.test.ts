// Publishing development builds (GitHub#215, scripts/dev-release.mjs) — the real script, run as
// the workflow runs it, against a fake `gh` on PATH that keeps the repository's releases in a JSON
// file (drafts, pre-releases, assets, tags) and can be told to fail a given call.
//
// What is checked: an installed app can only ever see a complete, published pre-release; an older
// run never publishes on top of a newer build; a half-done earlier run is finished, not duplicated;
// the old ones go by version (dev.9 < dev.10), only ones in the exact shape and marked pre-release;
// a list that cannot be read stops everything.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'dev-release.mjs');
const SHA = 'a'.repeat(40);

// The fake gh: just the calls the script makes, with GitHub's behaviour where it matters (a draft is
// a release whose tag does not exist yet; lists are pages of 100; releases have ids; deleting a
// release leaves its tag, which is a ref of its own). `afterDelete` changes the state right after a
// given release is deleted — someone editing the list while the clean-up runs.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const f = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(f, 'utf8'));
const a = process.argv.slice(2);
st.calls.push(a.map((x) => (x.includes('/') && fs.existsSync(x) ? path.basename(x) : x)));
const save = () => fs.writeFileSync(f, JSON.stringify(st));
const fail = (what) => {
  const i = st.fail.indexOf(what);
  if (i < 0) return false;
  st.fail.splice(i, 1);
  return true;
};
const die = (m) => { save(); process.stderr.write(m + '\n'); process.exit(1); };
// the files: what follows the tag up to the first option
const files = (list) => { const i = list.findIndex((x) => x.startsWith('--')); return (i < 0 ? list : list.slice(0, i)).filter((x) => fs.existsSync(x)).map((x) => path.basename(x)); };
const find = (tag) => st.releases.find((r) => r.tag_name === tag);
const relPath = (p) => /^repos\/[^/]+\/[^/]+\/(.*)$/.exec(p)?.[1] ?? '';
if (a[0] === 'api' && a[1] === '-X' && a[2] === 'DELETE') {
  const p = relPath(a[3]);
  let m;
  if ((m = /^releases\/(\d+)$/.exec(p))) {
    const r = st.releases.find((x) => x.id === Number(m[1]));
    if (!r) die('HTTP 404: Not Found');
    if (fail('delete:' + r.tag_name)) die('HTTP 500');
    st.releases = st.releases.filter((x) => x !== r);
    st.deleted.push(r.tag_name);
    for (const h of st.afterDelete?.[r.tag_name] ?? []) {
      if (h.add) st.releases.push(h.add);
      else Object.assign(st.releases.find((x) => x.tag_name === h.tag), h.set);
    }
    save();
    process.exit(0);
  }
  if ((m = /^git\/refs\/tags\/(.+)$/.exec(p))) {
    if (!st.tags.includes(m[1])) die('HTTP 422: Reference does not exist');
    st.tags = st.tags.filter((t) => t !== m[1]);
    st.tagsDeleted.push(m[1]);
    save();
    process.exit(0);
  }
  die('fake gh: unknown delete ' + p);
}
if (a[0] === 'api' && /^repos\/[^/]+\/[^/]+\/git\/ref\/tags\//.test(a[1])) {
  const t = relPath(a[1]).slice('git/ref/tags/'.length);
  if (!st.tags.includes(t)) die('HTTP 404: Not Found');
  save();
  process.stdout.write(JSON.stringify({ ref: 'refs/tags/' + t, object: { type: 'commit', sha: st.tagSha?.[t] ?? st.sha } }));
  process.exit(0);
}
if (a[0] === 'api') {
  st.lists = (st.lists ?? 0) + 1;
  if (fail('list') || fail('list#' + st.lists)) die('HTTP 502: Bad Gateway');
  const pages = [];
  for (let i = 0; i < st.releases.length; i += 100) pages.push(st.releases.slice(i, i + 100));
  if (!pages.length) pages.push([]);
  save();
  process.stdout.write(JSON.stringify(pages));
  process.exit(0);
}
const tag = a[2];
if (a[1] === 'create') {
  if (find(tag)) die('a release with this tag already exists');
  const names = files(a.slice(3));
  if (fail('create')) die('HTTP 500');
  const r = { id: st.nextId++, tag_name: tag, draft: a.includes('--draft'), prerelease: a.includes('--prerelease'), target_commitish: a[a.indexOf('--target') + 1], assets: [] };
  st.releases.unshift(r);
  if (fail('create-partial')) { r.assets = names.slice(0, 1).map((name) => ({ name })); die('upload failed: connection reset'); }
  r.assets = names.map((name) => ({ name }));
  save();
  process.exit(0);
}
if (a[1] === 'upload') {
  const r = find(tag);
  if (!r) die('release not found');
  if (fail('upload')) die('HTTP 500');
  const have = new Set(r.assets.map((x) => x.name));
  for (const n of files(a.slice(3))) if (!have.has(n)) r.assets.push({ name: n });
  save();
  process.exit(0);
}
if (a[1] === 'edit') {
  const r = find(tag);
  if (!r) die('release not found');
  if (fail('edit')) die('HTTP 500');
  // GitHub answering "ok" to an edit that did not take
  if (fail('edit-noop')) { save(); process.exit(0); }
  if (a.includes('--draft=false')) { r.draft = false; st.tags.push(tag); }
  if (a.includes('--prerelease')) r.prerelease = true;
  save();
  process.exit(0);
}
die('fake gh: unknown call ' + a.join(' '));
`;

interface Rel {
  id?: number;
  target_commitish?: string;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string }[];
}

const files = (v: string) => [`Cavil-Loop-${v}-arm64.app.tar.gz`, `Cavil-Loop-${v}-arm64.app.tar.gz.sig`, `Cavil-Loop-${v}-arm64.dmg`, 'latest.json'];
const pub = (tag: string, o: Partial<Rel> = {}): Rel => ({ tag_name: tag, draft: false, prerelease: false, assets: [{ name: 'latest.json' }], ...o });
const devRel = (v: string, o: Partial<Rel> = {}): Rel => pub(`client/v${v}`, { prerelease: true, assets: files(v).map((name) => ({ name })), ...o });

function world(input: Rel[], fail: string[] = [], extra: Record<string, unknown> = {}) {
  const releases = input.map((r, i) => ({ id: 1000 + i, target_commitish: SHA, ...r }));
  const dir = tempDir();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  const state = join(dir, 'state.json');
  const tags = releases.filter((r) => !r.draft).map((r) => r.tag_name);
  writeFileSync(state, JSON.stringify({ releases, tags, fail, calls: [], deleted: [], tagsDeleted: [], nextId: 5000, sha: SHA, ...extra }));
  const out = join(dir, 'dist-release');
  mkdirSync(out);
  writeFileSync(join(dir, 'notes.md'), '开发版\n');
  const build = (v: string) => {
    for (const f of files(v)) writeFileSync(join(out, f), `${f} bytes`);
  };
  const run = (v: string, extra: string[] = []) => {
    const r = spawnSync(process.execPath, [script, '--version', v, '--sha', SHA, '--dir', out, '--notes-file', join(dir, 'notes.md'), ...extra], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state },
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const read = () => JSON.parse(readFileSync(state, 'utf8')) as { releases: Rel[]; tags: string[]; calls: string[][]; deleted: string[]; tagsDeleted: string[]; fail: string[] };
  const fail2 = (...f: string[]) => {
    const s = read();
    s.fail.push(...f);
    writeFileSync(state, JSON.stringify(s));
  };
  return { build, run, read, fail: fail2, stateFile: state };
}

const writes = (calls: string[][]) =>
  calls.filter((c) => c[0] === 'release' || (c[0] === 'api' && c[2] === 'DELETE')).map((c) => (c[0] === 'release' ? `${c[1]} ${c[2]}` : `DELETE ${c[3].replace(/^repos\/[^/]+\/[^/]+\//, '')}`));
const published = (s: { releases: Rel[] }, tag: string) => s.releases.find((r) => r.tag_name === tag && !r.draft);

describe('publishing a development build (GitHub#215)', () => {
  it('a new one: created as a draft with every file, then published as a pre-release (never Latest), and read back', () => {
    const w = world([pub('release/v2026.11.01.1'), pub('client/v0.5.0'), devRel('0.5.1-dev.380')]);
    w.build('0.5.1-dev.387');
    const r = w.run('0.5.1-dev.387');
    expect(r.code, r.out).toBe(0);
    const s = w.read();
    expect(writes(s.calls)).toEqual(['create client/v0.5.1-dev.387', 'edit client/v0.5.1-dev.387']);
    const create = s.calls.find((c) => c[1] === 'create')!;
    expect(create).toEqual(expect.arrayContaining(['--draft', '--prerelease', '--latest=false', '--target', SHA, ...files('0.5.1-dev.387')]));
    expect(s.calls.find((c) => c[1] === 'edit')).toEqual(expect.arrayContaining(['--draft=false', '--prerelease', '--latest=false']));
    expect(published(s, 'client/v0.5.1-dev.387')).toMatchObject({ prerelease: true, assets: files('0.5.1-dev.387').map((name) => ({ name })) });
    expect(s.tags).toContain('client/v0.5.1-dev.387');
    // the list was read before writing, after publishing (check) and before pruning (nothing to prune here)
    expect(s.calls.filter((c) => c[0] === 'api' && c[1] === '--paginate').length).toBe(3);
  });

  it('a higher development build is already out: nothing is published (an older run that finished late)', () => {
    const w = world([devRel('0.5.1-dev.400'), pub('client/v0.5.0')]);
    w.build('0.5.1-dev.387');
    const r = w.run('0.5.1-dev.387');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('已经有更新的开发版 0.5.1-dev.400');
    expect(writes(w.read().calls)).toEqual([]);
    // "higher" is by version: dev.10 is higher than dev.9; a release (0.5.1) does not count as a development build
    const w2 = world([devRel('0.5.1-dev.9'), pub('client/v0.5.1')]);
    w2.build('0.5.1-dev.10');
    expect(w2.run('0.5.1-dev.10').code).toBe(0);
    expect(writes(w2.read().calls)).toEqual(['create client/v0.5.1-dev.10', 'edit client/v0.5.1-dev.10']);
  });

  it('a rerun of a build already published with every file publishes nothing', () => {
    const w = world([devRel('0.5.1-dev.387')]);
    w.build('0.5.1-dev.387');
    const r = w.run('0.5.1-dev.387');
    expect(r.code, r.out).toBe(0);
    expect(writes(w.read().calls)).toEqual([]);
  });

  it('an upload that broke off: the run fails, the half-done release stays a draft (no app sees it); the rerun finishes it, no second release', () => {
    const w = world([pub('client/v0.5.0')], ['create-partial']);
    w.build('0.5.1-dev.387');
    const first = w.run('0.5.1-dev.387');
    expect(first.code).toBe(1);
    let s = w.read();
    expect(s.releases.filter((r) => r.tag_name === 'client/v0.5.1-dev.387')).toEqual([expect.objectContaining({ draft: true })]);
    expect(s.tags).not.toContain('client/v0.5.1-dev.387');
    const again = w.run('0.5.1-dev.387');
    expect(again.code, again.out).toBe(0);
    s = w.read();
    expect(s.releases.filter((r) => r.tag_name === 'client/v0.5.1-dev.387')).toHaveLength(1);
    expect(published(s, 'client/v0.5.1-dev.387')?.assets.map((x) => x.name).sort()).toEqual(files('0.5.1-dev.387').sort());
    expect(writes(s.calls).slice(-2)).toEqual(['upload client/v0.5.1-dev.387', 'edit client/v0.5.1-dev.387']);
  });

  it('publishing fails (the draft is not turned into a release): the run fails, nothing an app can see', () => {
    const w = world([], ['edit']);
    w.build('0.5.1-dev.387');
    expect(w.run('0.5.1-dev.387').code).toBe(1);
    expect(published(w.read(), 'client/v0.5.1-dev.387')).toBeUndefined();
  });

  it('publishing answered "ok" but the release is still a draft: the read-back catches it, the run fails', () => {
    const w = world([], ['edit-noop']);
    w.build('0.5.1-dev.387');
    const r = w.run('0.5.1-dev.387');
    expect(r.code).toBe(1);
    expect(r.out).toContain('发完再读');
    expect(published(w.read(), 'client/v0.5.1-dev.387')).toBeUndefined();
  });

  it('the release list cannot be read: nothing is written at all', () => {
    const w = world([devRel('0.5.1-dev.380')], ['list']);
    w.build('0.5.1-dev.387');
    const r = w.run('0.5.1-dev.387');
    expect(r.code).toBe(1);
    expect(r.out).toContain('HTTP 502');
    expect(writes(w.read().calls)).toEqual([]);
  });

  it('a release of the same tag published but not as a pre-release is left alone and fails the run', () => {
    const w = world([pub('client/v0.5.1-dev.387', { assets: files('0.5.1-dev.387').map((name) => ({ name })) })]);
    w.build('0.5.1-dev.387');
    const r = w.run('0.5.1-dev.387');
    expect(r.code).toBe(1);
    expect(writes(w.read().calls)).toEqual([]);
  });
});

describe('keeping the latest 10 development builds (GitHub#215)', () => {
  const others = [
    pub('release/v2026.11.01.1'),
    pub('client/v0.5.0'),
    pub('client/v0.4.0'),
    devRel('0.9.0-rc.1'), // not the development shape
    devRel('9.0.0-dev.1', { draft: true }), // a draft of a higher version (a newer run may be publishing it)
    pub('client/v0.1.0-dev.2', { assets: [] }), // the development shape, not marked pre-release
    devRel('0.1.0-dev.03'), // a leading zero
  ];

  it('after publishing, all but the 10 highest published development builds are deleted with their tags — by version, nothing else touched', () => {
    // dev.1 … dev.11 of 0.5.1 plus the new dev.12: twelve; dev.9 / dev.10 / dev.11 sort by number;
    // the list is not in version order (dev.1 comes first), so "the 10 highest" is by version, not by position
    const devs = Array.from({ length: 11 }, (_, i) => devRel(`0.5.1-dev.${i + 1}`));
    const order = [devs[0], ...devs.slice(1).reverse(), ...others];
    const devIds = new Map(order.map((r, i) => [r.tag_name, 1000 + i]));
    const w = world(order);
    w.build('0.5.1-dev.12');
    const r = w.run('0.5.1-dev.12');
    expect(r.code, r.out).toBe(0);
    const s = w.read();
    expect(s.deleted.sort()).toEqual(['client/v0.5.1-dev.1', 'client/v0.5.1-dev.2']);
    // by id, then the tag
    const idOf = (t: string) => devIds.get(t);
    expect(writes(s.calls).filter((x) => x.startsWith('DELETE'))).toEqual([`DELETE releases/${idOf('client/v0.5.1-dev.2')}`, 'DELETE git/refs/tags/client/v0.5.1-dev.2', `DELETE releases/${idOf('client/v0.5.1-dev.1')}`, 'DELETE git/refs/tags/client/v0.5.1-dev.1']);
    expect(s.tagsDeleted.sort()).toEqual(['client/v0.5.1-dev.1', 'client/v0.5.1-dev.2']);
    const left = devsLeft(s);
    expect(left).toEqual(Array.from({ length: 10 }, (_, i) => `0.5.1-dev.${12 - i}`));
    for (const o of others) expect(s.releases.map((x) => x.tag_name)).toContain(o.tag_name);
  });

  it('also when nothing new was published (a higher one already out): the old ones still go', () => {
    const devs = Array.from({ length: 12 }, (_, i) => devRel(`0.5.1-dev.${100 + i}`));
    const w = world(devs);
    w.build('0.5.1-dev.50');
    expect(w.run('0.5.1-dev.50').code).toBe(0);
    expect(w.read().deleted.sort()).toEqual(['client/v0.5.1-dev.100', 'client/v0.5.1-dev.101']);
  });

  it('drafts an earlier, cancelled run left of a lower version go (draft only, there is no tag); a higher one is left alone', () => {
    const w = world([devRel('0.5.1-dev.380', { draft: true }), devRel('0.5.1-dev.390', { draft: true }), devRel('0.5.1-dev.370')]);
    w.build('0.5.1-dev.387');
    const r = w.run('0.5.1-dev.387');
    expect(r.code, r.out).toBe(0);
    const s = w.read();
    expect(s.deleted).toEqual(['client/v0.5.1-dev.380']);
    expect(s.tagsDeleted).toEqual([]);
    expect(s.releases.map((x) => x.tag_name).sort()).toEqual(['client/v0.5.1-dev.370', 'client/v0.5.1-dev.387', 'client/v0.5.1-dev.390']);
  });

  it('changed while the clean-up runs: a build un-marked as pre-release meanwhile is neither deleted nor loses its tag (re-read before each deletion)', () => {
    const devs = Array.from({ length: 12 }, (_, i) => devRel(`0.5.1-dev.${i + 1}`));
    // dev.2 goes first (higher of the two); while it is being deleted, dev.1 stops being a pre-release
    const w = world([...devs].reverse(), [], { afterDelete: { 'client/v0.5.1-dev.2': [{ tag: 'client/v0.5.1-dev.1', set: { prerelease: false } }] } });
    w.build('0.5.1-dev.12');
    const r = w.run('0.5.1-dev.12');
    expect(r.code, r.out).toBe(0);
    const s = w.read();
    // reachability: the clean-up did run and delete dev.2
    expect(s.deleted).toEqual(['client/v0.5.1-dev.2']);
    expect(s.tagsDeleted).toEqual(['client/v0.5.1-dev.2']);
    expect(s.releases.find((x) => x.tag_name === 'client/v0.5.1-dev.1')).toMatchObject({ prerelease: false });
    expect(s.tags).toContain('client/v0.5.1-dev.1');
    expect(r.out).toContain('不删 client/v0.5.1-dev.1');
  });

  it('a release replaced under the same tag meanwhile (new id) is not deleted; a newer build published meanwhile moves nothing out of the latest 10', () => {
    const devs = Array.from({ length: 12 }, (_, i) => devRel(`0.5.1-dev.${i + 1}`));
    const replaced = { ...devRel('0.5.1-dev.1'), id: 9999, target_commitish: SHA };
    const w = world([...devs].reverse(), [], {
      afterDelete: { 'client/v0.5.1-dev.2': [{ add: replaced }] },
    });
    // the replacement only appears once dev.2 is gone: drop the original dev.1 at the same moment
    const st = w.read() as any;
    st.afterDelete['client/v0.5.1-dev.2'].unshift({ tag: 'client/v0.5.1-dev.1', set: { tag_name: 'gone/x' } });
    writeFileSync((w as any).stateFile, JSON.stringify(st));
    w.build('0.5.1-dev.12');
    const r = w.run('0.5.1-dev.12');
    expect(r.code, r.out).toBe(0);
    const s = w.read();
    expect(s.deleted).toEqual(['client/v0.5.1-dev.2']);
    expect(s.releases.some((x) => x.id === 9999)).toBe(true);
  });

  it('the fresh read before a deletion fails: that one and the rest are left for the next push', () => {
    const devs = Array.from({ length: 12 }, (_, i) => devRel(`0.5.1-dev.${i + 1}`));
    // dev.12 is already published: list reads 1 to decide, 2 to select, 3 before the first delete,
    // 4 for its tag, 5 before the second delete
    const w = world([...devs].reverse(), ['list#5']);
    w.build('0.5.1-dev.12');
    const r = w.run('0.5.1-dev.12');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('重读发版列表失败');
    expect(w.read().deleted).toEqual(['client/v0.5.1-dev.2']);
  });

  it('a tag that no longer points at the release\'s commit is kept (the release still goes)', () => {
    const devs = Array.from({ length: 10 }, (_, i) => devRel(`0.5.1-dev.${i + 1}`));
    const w = world([...devs].reverse(), [], { tagSha: { 'client/v0.5.1-dev.1': 'b'.repeat(40) } });
    w.build('0.5.1-dev.11');
    const r = w.run('0.5.1-dev.11');
    expect(r.code, r.out).toBe(0);
    const s = w.read();
    expect(s.deleted).toEqual(['client/v0.5.1-dev.1']);
    expect(s.tagsDeleted).toEqual([]);
    expect(s.tags).toContain('client/v0.5.1-dev.1');
    expect(r.out).toContain('标签 client/v0.5.1-dev.1 没删');
  });

  it('a deletion that fails is a warning on the run; the others still go, and the next run retries it', () => {
    const devs = Array.from({ length: 12 }, (_, i) => devRel(`0.5.1-dev.${i + 1}`));
    const w = world(devs, ['delete:client/v0.5.1-dev.1']);
    w.build('0.5.1-dev.12');
    const r = w.run('0.5.1-dev.12');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('::warning::删旧开发版 client/v0.5.1-dev.1 失败');
    expect(w.read().deleted).toEqual(['client/v0.5.1-dev.2']);
    w.build('0.5.1-dev.13');
    expect(w.run('0.5.1-dev.13').code).toBe(0);
    expect(w.read().deleted.sort()).toEqual(['client/v0.5.1-dev.1', 'client/v0.5.1-dev.2', 'client/v0.5.1-dev.3']);
  });
});

function devsLeft(s: { releases: Rel[] }) {
  return s.releases
    .filter((r) => !r.draft && r.prerelease && /^client\/v\d+\.\d+\.\d+-dev\.[1-9]\d*$/.test(r.tag_name))
    .map((r) => r.tag_name.slice('client/v'.length))
    .sort((a, b) => Number(b.split('.').pop()) - Number(a.split('.').pop()));
}
