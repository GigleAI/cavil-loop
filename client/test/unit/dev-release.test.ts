// Publishing development builds (GitHub#215, scripts/dev-release.mjs) — the real script, run as
// the workflow runs it, against a fake `gh` on PATH that keeps the repository's releases in a JSON
// file (drafts, pre-releases, assets, tags) and can be told to fail a given call.
//
// What is checked: an installed app can only ever see a complete, published pre-release; an older
// run never publishes on top of a newer build; a half-done earlier run is finished, not duplicated;
// the old ones go by version (dev.9 < dev.10), only ones in the exact shape and marked pre-release;
// a list that cannot be read stops everything.

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';
import { FAKE_GH } from './fake-gh-releases';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'dev-release.mjs');
const DEFAULT_SHA = 'a'.repeat(40);
const SHA = DEFAULT_SHA;


interface Rel {
  id?: number;
  target_commitish?: string;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; state?: string; size?: number }[];
  body?: string;
}

// every file a development build carries: the script refuses to publish without one of them (GitHub#628)
const files = (v: string) => [`Cavil-Loop-${v}-arm64.app.tar.gz`, `Cavil-Loop-${v}-arm64.app.tar.gz.sig`, `Cavil-Loop-${v}-arm64.dmg`, `Cavil-Loop-${v}-windows-x64.exe`, `Cavil-Loop-${v}-windows-x64.exe.sig`, 'latest.json'];
const pub = (tag: string, o: Partial<Rel> = {}): Rel => ({ tag_name: tag, draft: false, prerelease: false, assets: [{ name: 'latest.json' }], ...o });
const asset = (name: string) => ({ name, state: 'uploaded', size: 10 });
const devRel = (v: string, o: Partial<Rel> = {}): Rel => pub(`client/v${v}`, { prerelease: true, assets: files(v).map(asset), ...o });

function world(input: Rel[], fail: string[] = [], extra: Record<string, unknown> = {}, at: { script?: string; sha?: string } = {}) {
  const script = at.script ?? SCRIPT;
  const SHA = at.sha ?? DEFAULT_SHA;
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
  // the script's own temp dir, so what it leaves behind can be listed (GitHub#469)
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  const build = (v: string) => {
    for (const f of files(v)) writeFileSync(join(out, f), `${f} bytes`);
  };
  const run = (v: string, extra: string[] = []) => {
    const r = spawnSync(process.execPath, [script, '--version', v, '--sha', SHA, '--dir', out, '--notes-file', join(dir, 'notes.md'), ...extra], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, TMPDIR: tmp },
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
  const runArgs = (args: string[]) => {
    const r = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, TMPDIR: tmp }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { build, run, runArgs, read, fail: fail2, stateFile: state, tmp };
}

const writes = (calls: string[][]) =>
  calls.filter((c) => c[0] === 'release' || (c[0] === 'api' && c[2] === 'DELETE')).map((c) => (c[0] === 'release' ? `${c[1]} ${c[2]}` : `DELETE ${c[3].replace(/^repos\/[^/]+\/[^/]+\//, '')}`));
const published = (s: { releases: Rel[] }, tag: string) => s.releases.find((r) => r.tag_name === tag && !r.draft);

describe('publishing a development build (GitHub#215)', () => {
  it('the release notes file is removed whether the create worked or failed (GitHub#469)', () => {
    const ok = world([pub('client/v0.5.0')]);
    ok.build('0.5.1-dev.387');
    const r = ok.run('0.5.1-dev.387');
    expect(r.code, r.out).toBe(0);
    // the notes did reach gh (the fake read them from the file), and the file's folder is gone
    expect(ok.read().releases.find((x) => x.tag_name === 'client/v0.5.1-dev.387')?.body).toContain('开发版');
    expect(readdirSync(ok.tmp)).toEqual([]);
    const bad = world([pub('client/v0.5.0')], ['create']);
    bad.build('0.5.1-dev.387');
    const f = bad.run('0.5.1-dev.387');
    expect(f.code).toBe(1);
    expect(bad.read().calls.some((c) => c[1] === 'create')).toBe(true);
    expect(readdirSync(bad.tmp)).toEqual([]);
  });

  it('a build missing any of its files (here the Windows installer) is refused before anything is read or written (GitHub#628)', () => {
    const w = world([pub('client/v0.5.0')]);
    w.build('0.5.1-dev.387');
    rmSync(join(w.stateFile, '..', 'dist-release', 'Cavil-Loop-0.5.1-dev.387-windows-x64.exe'));
    const r = w.run('0.5.1-dev.387');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Cavil-Loop-0.5.1-dev.387-windows-x64.exe');
    expect(w.read().calls).toEqual([]);
    // and the list the workflow checks with is the same one
    const p = spawnSync(process.execPath, [SCRIPT, '--files', '0.5.1-dev.387'], { encoding: 'utf8' });
    expect(p.stdout.trim().split('\n').sort()).toEqual(files('0.5.1-dev.387').sort());
  });

  // One batch of inputs for the three review rounds on asset completeness (GitHub#628 rounds 1–3): the
  // version being published is already a public pre-release, with one file in each shape.
  describe('the same version already public with one file in some state (review rounds 1–3)', () => {
    const v = '0.5.1-dev.387';
    const tag = `client/v${v}`;
    const exe = `Cavil-Loop-${v}-windows-x64.exe`;
    const withExe = (x: object | null) => devRel(v, { assets: [...files(v).filter((f) => f !== exe).map(asset), ...(x ? [{ name: exe, ...x }] : [])] });
    const writeArgs = (calls: string[][]) => calls.filter((c) => c[0] === 'release').map((c) => [c[1], ...c.filter((x) => x.startsWith('--draft'))].join(' '));
    const shapes: [string, object | null][] = [
      ['missing (round 1)', null],
      ['a failed-upload placeholder: state starter, size 0 (round 2)', { state: 'starter', size: 0 }],
      ['uploaded with size 0', { state: 'uploaded', size: 0 }],
    ];
    it.each(shapes)('%s → hidden first, every file of this build put in, published again', (_, x) => {
      const w = world([withExe(x), devRel('0.5.1-dev.380')]);
      w.build(v);
      const r = w.run(v);
      expect(r.code, r.out).toBe(0);
      const s = w.read();
      expect(writeArgs(s.calls)).toEqual(['edit --draft=true', 'upload', 'edit --draft=false']);
      // every one of the six files from this build, not only the broken one
      const up = s.calls.find((c) => c[0] === 'release' && c[1] === 'upload')!;
      expect(up).toEqual(expect.arrayContaining([...files(v).filter((f) => f !== 'latest.json'), '--clobber']));
      expect(published(s, tag)?.assets.map((a) => a.name).sort()).toEqual(files(v).sort());
      expect(published(s, tag)?.assets.every((a) => a.state === 'uploaded' && (a.size ?? 0) > 0)).toBe(true);
      expect(published(s, 'client/v0.5.1-dev.380')).toBeTruthy();
    });
    it.each([
      ['no state at all (round 3)', { size: 10 }],
      ['no size', { state: 'uploaded' }],
      ['an empty state', { state: '', size: 10 }],
      ['a state word GitHub never used (round 4)', { state: 'unrecognized', size: 10 }],
      ['a state word GitHub never used, size 0 (round 4)', { state: 'processing', size: 0 }],
      ['a failed-upload placeholder with no size (round 4)', { state: 'starter' }],
      ['a size that is not a whole number (round 4)', { state: 'uploaded', size: '10' }],
    ])('%s → read again; still unknown → nothing written, the public files left exactly as they are', (_, x) => {
      const w = world([withExe(x)]);
      w.build(v);
      const before = JSON.stringify(w.read().releases);
      const r = w.run(v);
      expect(r.code).toBe(1);
      expect(r.out).toContain('读不出是否已上传完成');
      const s = w.read();
      expect(writeArgs(s.calls)).toEqual([]);
      expect(s.calls.filter((c) => c[0] === 'api').length).toBeGreaterThanOrEqual(2); // it did read again
      expect(JSON.stringify(s.releases)).toBe(before);
    });
    it.each([
      ['assets: null', null],
      ['no assets field', undefined],
      ['assets: an object', {}],
    ])('%s (the file list itself unreadable, round 4) → read again; still unknown → nothing written', (_, assets) => {
      const rel: Record<string, unknown> = { ...devRel(v) };
      if (assets === undefined) delete rel.assets;
      else rel.assets = assets;
      const w = world([rel as unknown as Rel, devRel('0.5.1-dev.380')]);
      w.build(v);
      const before = JSON.stringify(w.read().releases);
      const r = w.run(v);
      expect(r.code).toBe(1);
      expect(r.out).toContain('读不出是否已上传完成');
      const s = w.read();
      expect(writeArgs(s.calls)).toEqual([]);
      expect(JSON.stringify(s.releases)).toBe(before);
    });
    // review round 5: what identifies a file, and whether a release is public, are read — never defaulted
    const edited = (rels: Rel[], f: (rs: any[]) => void) => {
      const w = world(rels);
      const st = JSON.parse(readFileSync(w.stateFile, 'utf8'));
      f(st.releases);
      writeFileSync(w.stateFile, JSON.stringify(st));
      return w;
    };
    it.each([
      ['one of the six files listed without a name', (rs: any[]) => { delete rs[0].assets[0].name; }],
      ['one of the six files listed with an empty name', (rs: any[]) => { rs[0].assets[0].name = ''; }],
      ['this version public but without a draft field', (rs: any[]) => { delete rs[0].draft; }],
      ['this version with draft: null', (rs: any[]) => { rs[0].draft = null; }],
      ['this version without a prerelease field', (rs: any[]) => { delete rs[0].prerelease; }],
      ['another development build without a draft field (it could be a newer public one)', (rs: any[]) => { delete rs[1].draft; }],
      ['a release with no tag name', (rs: any[]) => { delete rs[1].tag_name; }],
    ])('%s → read again; still unknown → nothing hidden, nothing uploaded, nothing published (round 5)', (_, f) => {
      // this version's Windows installer is a placeholder, so a wrong verdict would go on to fill it
      const w = edited([withExe({ state: 'starter', size: 0 }), devRel('0.5.1-dev.380')], f);
      w.build(v);
      const before = JSON.stringify(w.read().releases);
      const r = w.run(v);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/读不出/);
      expect(r.out).toContain('什么都不写');
      const s = w.read();
      expect(writeArgs(s.calls)).toEqual([]);
      expect(s.calls.filter((c) => c[0] === 'api').length).toBeGreaterThanOrEqual(2); // it did read again
      expect(JSON.stringify(s.releases)).toBe(before);
    });
    it('an explicit draft of this version with a placeholder → filled without hiding (it already is hidden), then published (round 5 positive case)', () => {
      const w = world([{ ...withExe({ state: 'starter', size: 0 }), draft: true }, devRel('0.5.1-dev.380')]);
      w.build(v);
      const r = w.run(v);
      expect(r.code, r.out).toBe(0);
      expect(writeArgs(w.read().calls)).toEqual(['upload', 'edit --draft=false']);
      expect(published(w.read(), tag)?.assets.map((a) => a.name).sort()).toEqual(files(v).sort());
    });
    it('--check: a release that does not say whether it is a draft → UNKNOWN, exit 2 (round 5)', () => {
      const w = edited([devRel(v)], (rs) => { delete rs[0].draft; });
      const r = w.runArgs(['--check', v]);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/^UNKNOWN/m);
    });
    it('unknown on the first read, uploaded on the second → already complete, nothing written', () => {
      const w = world([withExe({ size: 10 })], [], { afterList: { 2: { tag, assets: files(v).map(asset) } } });
      w.build(v);
      const r = w.run(v);
      expect(r.code, r.out).toBe(0);
      expect(writeArgs(w.read().calls)).toEqual([]);
    });
    it('complete → nothing written', () => {
      const w = world([devRel(v)]);
      w.build(v);
      expect(w.run(v).code).toBe(0);
      expect(writeArgs(w.read().calls)).toEqual([]);
    });
    it('the upload fails part-way after it was hidden → still hidden (apps keep the previous build), never public with a file missing; the next run finishes it', () => {
      const w = world([withExe({ state: 'starter', size: 0 }), devRel('0.5.1-dev.380')], ['upload-partial']);
      w.build(v);
      expect(w.run(v).code).toBe(1);
      const s = w.read();
      expect(s.releases.find((r) => r.tag_name === tag)?.draft).toBe(true);
      expect(published(s, tag)).toBeUndefined();
      expect(published(s, 'client/v0.5.1-dev.380')).toBeTruthy();
      const again = w.run(v);
      expect(again.code, again.out).toBe(0);
      expect(published(w.read(), tag)?.assets.map((a) => a.name).sort()).toEqual(files(v).sort());
    });
    it('hiding it did not take (GitHub answered ok, still public) → no file replaced', () => {
      const w = world([withExe({ state: 'starter', size: 0 })], ['edit-noop']);
      w.build(v);
      expect(w.run(v).code).toBe(1);
      expect(writeArgs(w.read().calls)).toEqual(['edit --draft=true']);
    });
  });

  it('a create that left a placeholder: the run fails, and the next one fills it in (it was never public)', () => {
    const v = '0.5.1-dev.387';
    const w = world([pub('client/v0.5.0')], ['create-starter']);
    w.build(v);
    expect(w.run(v).code).toBe(1);
    const again = w.run(v);
    expect(again.code, again.out).toBe(0);
    expect(writes(w.read().calls).slice(-2)).toEqual([`upload client/v${v}`, `edit client/v${v}`]);
  });

  it('--check: read-only, by the same rule (review round 2 #6)', () => {
    const v = '0.5.1-dev.387';
    const exe = `Cavil-Loop-${v}-windows-x64.exe`;
    const chk = (rels: Rel[], fail: string[] = []) => {
      const w = world(rels, fail);
      const p = w.runArgs(['--check', v]);
      return { ...p, writes: writes(w.read().calls) };
    };
    const ok = chk([devRel(v)]);
    expect(ok).toMatchObject({ code: 0, writes: [] });
    expect(ok.out).toContain('COMPLETE');
    const starter = chk([devRel(v, { assets: [...files(v).filter((f) => f !== exe).map(asset), { name: exe, state: 'starter', size: 0 }] })]);
    expect(starter).toMatchObject({ code: 1, writes: [] });
    expect(starter.out).toContain(`INCOMPLETE client/v${v}`);
    expect(starter.out).toContain(exe);
    expect(chk([pub('client/v0.5.0')]).code).toBe(1);
    expect(chk([devRel(v, { draft: true })]).out).toContain('还是草稿');
    const noState = chk([devRel(v, { assets: [...files(v).filter((f) => f !== exe).map(asset), { name: exe, size: 10 }] })]);
    expect(noState.code).toBe(2);
    expect(noState.out).toContain(`UNKNOWN client/v${v}`);
    const unreadable = chk([devRel(v)], ['list']);
    expect(unreadable.code).toBe(2);
    expect(unreadable.out).toContain('UNKNOWN');
  });

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
    expect(published(s, 'client/v0.5.1-dev.387')).toMatchObject({ prerelease: true, assets: files('0.5.1-dev.387').map(asset) });
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
    const w = world([pub('client/v0.5.1-dev.387', { assets: files('0.5.1-dev.387').map(asset) })]);
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
    // each in three steps, by id: turned into a draft, its tag, the draft
    const id = (t: string) => devIds.get(t);
    const steps = s.calls.filter((c) => c[0] === 'api' && (c[2] === 'DELETE' || c[2] === 'PATCH')).map((c) => `${c[2]} ${c[3].replace(/^repos\/[^/]+\/[^/]+\//, '')}`);
    expect(steps).toEqual([
      `PATCH releases/${id('client/v0.5.1-dev.2')}`, 'DELETE git/refs/tags/client/v0.5.1-dev.2', `DELETE releases/${id('client/v0.5.1-dev.2')}`,
      `PATCH releases/${id('client/v0.5.1-dev.1')}`, 'DELETE git/refs/tags/client/v0.5.1-dev.1', `DELETE releases/${id('client/v0.5.1-dev.1')}`,
    ]);
    expect(s.tagsDeleted.sort()).toEqual(['client/v0.5.1-dev.1', 'client/v0.5.1-dev.2']);
    expect(devsLeft(s)).toEqual(Array.from({ length: 10 }, (_, i) => `0.5.1-dev.${12 - i}`));
    for (const o of others) expect(s.releases.map((x) => x.tag_name)).toContain(o.tag_name);
  });

  it('also when nothing new was published (a higher one already out): the old ones still go', () => {
    const devs = Array.from({ length: 12 }, (_, i) => devRel(`0.5.1-dev.${100 + i}`));
    const w = world(devs);
    w.build('0.5.1-dev.50');
    expect(w.run('0.5.1-dev.50').code).toBe(0);
    expect(w.read().deleted.sort()).toEqual(['client/v0.5.1-dev.100', 'client/v0.5.1-dev.101']);
    expect(w.read().tagsDeleted.sort()).toEqual(['client/v0.5.1-dev.100', 'client/v0.5.1-dev.101']);
  });

  it('drafts an earlier, cancelled run left of a lower version go (it has no tag yet); a higher one is left alone', () => {
    const w = world([devRel('0.5.1-dev.380', { draft: true }), devRel('0.5.1-dev.390', { draft: true }), devRel('0.5.1-dev.370')]);
    w.build('0.5.1-dev.387');
    const r = w.run('0.5.1-dev.387');
    expect(r.code, r.out).toBe(0);
    const s = w.read();
    expect(s.deleted).toEqual(['client/v0.5.1-dev.380']);
    expect(s.tagsDeleted).toEqual([]);
    expect(s.releases.map((x) => x.tag_name).sort()).toEqual(['client/v0.5.1-dev.370', 'client/v0.5.1-dev.387', 'client/v0.5.1-dev.390']);
  });

  it('changed while the clean-up runs: a build un-marked as pre-release meanwhile is neither deleted nor loses its tag (re-read before each step)', () => {
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
    expect(s.releases.find((x) => x.tag_name === 'client/v0.5.1-dev.1')).toMatchObject({ prerelease: false, draft: false });
    expect(s.tags).toContain('client/v0.5.1-dev.1');
    expect(r.out).toContain('不删 client/v0.5.1-dev.1');
  });

  it('a release replaced under the same tag meanwhile (new id) is not touched', () => {
    const devs = Array.from({ length: 12 }, (_, i) => devRel(`0.5.1-dev.${i + 1}`));
    const replaced = { ...devRel('0.5.1-dev.1'), id: 9999, target_commitish: SHA };
    const w = world([...devs].reverse(), [], {
      afterDelete: { 'client/v0.5.1-dev.2': [{ tag: 'client/v0.5.1-dev.1', set: { tag_name: 'gone/x' } }, { add: replaced }] },
    });
    w.build('0.5.1-dev.12');
    const r = w.run('0.5.1-dev.12');
    expect(r.code, r.out).toBe(0);
    const s = w.read();
    expect(s.deleted).toEqual(['client/v0.5.1-dev.2']);
    expect(s.releases.find((x) => x.id === 9999)).toMatchObject({ draft: false });
    // the original release (now under another tag) is not touched either: no step at all on its id
    const orig = s.releases.find((x) => x.tag_name === 'gone/x')!;
    expect(orig).toMatchObject({ draft: false });
    expect(s.calls.filter((c) => c[0] === 'api' && c[3]?.endsWith(`/releases/${orig.id}`))).toEqual([]);
  });

  it('the fresh read before a step fails: the clean-up stops, nothing half-done is left behind, the next run finishes', () => {
    const devs = Array.from({ length: 12 }, (_, i) => devRel(`0.5.1-dev.${i + 1}`));
    // dev.12 is already published: list reads 1 to decide, 2 to select; dev.2 takes 3 (before the
    // draft step), 4 (before the tag), 5 (before the delete); 6 is the first read for dev.1
    const w = world([...devs].reverse(), ['list#6']);
    w.build('0.5.1-dev.12');
    const r = w.run('0.5.1-dev.12');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('重读发版列表失败');
    let s = w.read();
    expect(s.deleted).toEqual(['client/v0.5.1-dev.2']);
    expect(s.releases.find((x) => x.tag_name === 'client/v0.5.1-dev.1')).toMatchObject({ draft: false, prerelease: true });
    expect(w.run('0.5.1-dev.12').code).toBe(0);
    s = w.read();
    expect(s.deleted.sort()).toEqual(['client/v0.5.1-dev.1', 'client/v0.5.1-dev.2']);
    expect(s.tags).not.toContain('client/v0.5.1-dev.1');
  });

  // GitHub#215 code review round 2: a step that fails after the release is out of sight must not
  // lose the rest — the half-done build stays a draft (its tag name and commit are recorded on it),
  // and a later, fresh process finishes it. Each case: three separate processes on one GitHub.
  for (const [what, fail] of [
    ['reading its tag fails once', 'tagread:client/v0.5.1-dev.1'],
    ['deleting its tag fails once', 'tagdel:client/v0.5.1-dev.1'],
    ['deleting the draft fails once (the tag is already gone)', 'delete:client/v0.5.1-dev.1'],
    ['turning it into a draft fails once', 'patch:client/v0.5.1-dev.1'],
    ['turning it into a draft answers "ok" but does not take', 'patch-noop:client/v0.5.1-dev.1'],
  ] as const) {
    it(`a step of the clean-up that fails is finished by a later run, release and tag both: ${what}`, () => {
      const devs = Array.from({ length: 11 }, (_, i) => devRel(`0.5.1-dev.${i + 1}`));
      const w = world([...devs].reverse(), [fail]);
      w.build('0.5.1-dev.11');
      const first = w.run('0.5.1-dev.11');
      expect(first.code, first.out).toBe(0);
      expect(first.out).toContain('留到下次');
      let s = w.read();
      // not finished, and nothing an app could install: either still a published pre-release, or a draft
      const half = s.releases.find((x) => x.tag_name === 'client/v0.5.1-dev.1');
      expect(half, 'the release is kept until its tag is settled, or the tag is already gone').toBeTruthy();
      // a fresh process, the fault gone: finishes it
      const second = w.run('0.5.1-dev.11');
      expect(second.code, second.out).toBe(0);
      s = w.read();
      expect(s.releases.some((x) => x.tag_name === 'client/v0.5.1-dev.1')).toBe(false);
      expect(s.tags).not.toContain('client/v0.5.1-dev.1');
      // and the next build's clean-up works as usual (dev.2 out of the latest 10)
      w.build('0.5.1-dev.12');
      expect(w.run('0.5.1-dev.12').code).toBe(0);
      s = w.read();
      expect(s.deleted.filter((t) => t === 'client/v0.5.1-dev.1')).toHaveLength(1);
      expect(s.deleted).toContain('client/v0.5.1-dev.2');
      expect(s.tags).not.toContain('client/v0.5.1-dev.2');
      expect(s.tags).toContain('client/v0.5.1-dev.3');
    });
  }

  it('a tag that is definitely not the release\'s (points at another commit) is kept, the release goes, and later runs leave that tag alone', () => {
    const devs = Array.from({ length: 10 }, (_, i) => devRel(`0.5.1-dev.${i + 1}`));
    const w = world([...devs].reverse(), [], { tagSha: { 'client/v0.5.1-dev.1': 'b'.repeat(40) } });
    w.build('0.5.1-dev.11');
    const r = w.run('0.5.1-dev.11');
    expect(r.code, r.out).toBe(0);
    let s = w.read();
    expect(s.deleted).toEqual(['client/v0.5.1-dev.1']);
    expect(s.tagsDeleted).toEqual([]);
    expect(s.tags).toContain('client/v0.5.1-dev.1');
    expect(r.out).toContain('标签 client/v0.5.1-dev.1 不删');
    w.build('0.5.1-dev.12');
    expect(w.run('0.5.1-dev.12').code).toBe(0);
    s = w.read();
    expect(s.tags).toContain('client/v0.5.1-dev.1');
    expect(s.tagsDeleted).toEqual(['client/v0.5.1-dev.2']);
  });
});

function devsLeft(s: { releases: Rel[] }) {
  return s.releases
    .filter((r) => !r.draft && r.prerelease && /^client\/v\d+\.\d+\.\d+-dev\.[1-9]\d*$/.test(r.tag_name))
    .map((r) => r.tag_name.slice('client/v'.length))
    .sort((a, b) => Number(b.split('.').pop()) - Number(a.split('.').pop()));
}

// ---- GitHub#348: the release page says what the build changed -----------------------------
// The real script, copied into a real git repository (it reads RELEASE_NOTES.md's history next to
// itself), publishing against the fake gh; the page it created is what the fake gh was handed.

describe('the release page carries what the build changed (GitHub#348)', () => {
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();

  /** a repository whose client/ holds the real scripts and a RELEASE_NOTES.md that gains a line per commit */
  function repo() {
    const top = tempDir();
    const scripts = join(top, 'client', 'scripts');
    mkdirSync(scripts, { recursive: true });
    for (const f of ['dev-release.mjs', 'update-manifest.mjs']) copyFileSync(join(root, 'scripts', f), join(scripts, f));
    git(top, 'init', '-q', '-b', 'main');
    const lines: string[] = [];
    const commit = (line: string | null) => {
      if (line) lines.unshift(line);
      writeFileSync(join(top, 'client', 'RELEASE_NOTES.md'), `### 这一版（0.5）\n\n${lines.join('\n')}\n`);
      writeFileSync(join(top, 'client', 'n.txt'), String(Math.random()));
      git(top, 'add', '-A');
      git(top, 'commit', '-q', '-m', 'c');
      return git(top, 'rev-parse', 'HEAD');
    };
    return { script: join(scripts, 'dev-release.mjs'), commit };
  }
  const page = (w: ReturnType<typeof world>, v: string) => published(w.read(), `client/v${v}`)!.body;

  it('the lines RELEASE_NOTES.md gained since the previous published build go under the heading, after the text it was given', () => {
    const r = repo();
    const a = r.commit('- **甲**（GitHub#1）：一');
    r.commit('- **乙**（GitHub#2）：二');
    const c = r.commit('- **丙**（GitHub#3）：三');
    const w = world([devRel('0.5.1-dev.380', { target_commitish: a }), devRel('0.5.1-dev.370', { target_commitish: 'e'.repeat(40) }), pub('client/v0.5.0')], [], {}, { script: r.script, sha: c });
    w.build('0.5.1-dev.387');
    const run = w.run('0.5.1-dev.387');
    expect(run.code, run.out).toBe(0);
    expect(page(w, '0.5.1-dev.387')).toBe('开发版\n\n### 更新内容\n\n- **丙**（GitHub#3）：三\n- **乙**（GitHub#2）：二\n');
    expect(run.out).toContain('发版页带上 2 条更新说明');
  });

  it('nothing gained, no previous build, or a previous build whose commit is not in this clone: the page is the text it was given, and the build is published all the same', () => {
    const r = repo();
    const a = r.commit('- **甲**：一');
    const b = r.commit(null);
    for (const [before, why] of [
      [[devRel('0.5.1-dev.380', { target_commitish: a })], '发版说明没有新增条目'],
      [[pub('client/v0.5.0')], '找不到上一个开发版的提交'],
      [[devRel('0.5.1-dev.380', { target_commitish: 'e'.repeat(40) })], '比不出发版说明的变化'],
      [[devRel('0.5.1-dev.380', { target_commitish: 'main' })], '找不到上一个开发版的提交'],
    ] as [Rel[], string][]) {
      const w = world(before, [], {}, { script: r.script, sha: b });
      w.build('0.5.1-dev.387');
      const run = w.run('0.5.1-dev.387');
      expect(run.code, run.out).toBe(0);
      expect(page(w, '0.5.1-dev.387'), why).toBe('开发版\n');
      expect(run.out).toContain(`发版页不带更新说明：${why}`);
      expect(published(w.read(), 'client/v0.5.1-dev.387')).toMatchObject({ prerelease: true });
    }
  });
});

// ---- GitHub#427: commits whose own build never got published ---------------------------
// A merge whose build failed or was cancelled has no page; when it wrote no note line either, the
// next published build's page is the only place it can appear. Real script, real repository whose
// commits touch the app, its tests, its test back end, the packaging scripts and the repository's CI.

describe('the release page also lists app changes that wrote no note line (GitHub#427)', () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env }).trim();

  function repo() {
    const top = tempDir();
    const client = join(top, 'client');
    const scripts = join(client, 'scripts');
    mkdirSync(scripts, { recursive: true });
    for (const f of ['dev-release.mjs', 'update-manifest.mjs']) copyFileSync(join(root, 'scripts', f), join(scripts, f));
    git(top, 'init', '-q', '-b', 'main');
    const notes: string[] = [];
    /** one commit: `files` (paths under the repository top) get new content; `note` is prepended to RELEASE_NOTES.md */
    const commit = (msg: string, files: string[], note?: string) => {
      if (note) notes.unshift(note);
      writeFileSync(join(client, 'RELEASE_NOTES.md'), `### 这一版（0.5）\n\n${notes.join('\n')}\n`);
      for (const f of files) {
        mkdirSync(dirname(join(top, f)), { recursive: true });
        writeFileSync(join(top, f), String(Math.random()));
      }
      git(top, 'add', '-A');
      git(top, 'commit', '-q', '-m', msg);
      return git(top, 'rev-parse', 'HEAD');
    };
    return { top, client, script: join(scripts, 'dev-release.mjs'), commit };
  }
  const page = (w: ReturnType<typeof world>, v: string) => published(w.read(), `client/v${v}`)!.body;

  /** the history of 0.5.2-dev.497 → 0.5.3-dev.508, in miniature: one published build, then six merges with no build of their own */
  function history() {
    const r = repo();
    const base = r.commit('feat(client): the previous build (#1)', ['client/src/a.ts']);
    r.commit('fix(client): two UI tests, bump the version (#412)', ['client/package.json', 'client/test/e2e/x.spec.ts']);
    r.commit('feat(client): pick a Project from GitHub (#414)', ['client/src/b.tsx', 'client/src-tauri/crates/core/src/c.rs']);
    r.commit('test(client): scroll before a real-app click (#421)', ['client/test/tauri/y.ts']);
    r.commit('test(client): the test back end only (#9)', ['client/src-tauri/crates/harness/src/main.rs']);
    r.commit('feat(ci): nightly negative controls (#422)', ['.github/workflows/client.yml', 'client/README.md']);
    r.commit('feat(client): shortcuts in the detail panel (#419)', ['client/src/d.tsx'], '- **详情里的快捷键**（GitHub#413）：X / ⇧A / ⇧P');
    const head = r.commit('fix(client): the Mac update check (#424)', ['client/scripts/mac-update-check.sh']);
    return { ...r, base, head };
  }

  it('the note lines first, then the title of every app change that wrote none, newest first; tests, the test back end, CI, docs and packaging scripts stay out', () => {
    const h = history();
    const w = world([devRel('0.5.2-dev.497', { target_commitish: h.base })], [], {}, { script: h.script, sha: h.head });
    w.build('0.5.3-dev.508');
    const run = w.run('0.5.3-dev.508');
    expect(run.code, run.out).toBe(0);
    expect(page(w, '0.5.3-dev.508')).toBe(
      '开发版\n\n### 更新内容\n\n- **详情里的快捷键**（GitHub#413）：X / ⇧A / ⇧P\n- feat(client): pick a Project from GitHub (#414)\n- fix(client): two UI tests, bump the version (#412)\n',
    );
    expect(run.out).toContain('发版页带上 1 条更新说明、补上 2 个没写更新说明的提交标题');
  });

  it('the build’s own commit counts too, and a range with only untold app changes still gets its section', () => {
    const r = repo();
    const base = r.commit('feat(client): base (#1)', ['client/src/a.ts']);
    r.commit('feat(client): unpublished (#2)', ['client/build/icon.png']);
    const head = r.commit('feat(client): this build (#3)', ['client/src/b.ts']);
    const w = world([devRel('0.5.1-dev.380', { target_commitish: base })], [], {}, { script: r.script, sha: head });
    w.build('0.5.1-dev.387');
    const run = w.run('0.5.1-dev.387');
    expect(run.code, run.out).toBe(0);
    expect(page(w, '0.5.1-dev.387')).toBe('开发版\n\n### 更新内容\n\n- feat(client): this build (#3)\n- feat(client): unpublished (#2)\n');
    expect(run.out).toContain('发版页带上 0 条更新说明、补上 2 个没写更新说明的提交标题');
  });

  it('only non-app changes since the previous build: no section, the same as before', () => {
    const r = repo();
    const base = r.commit('feat(client): base (#1)', ['client/src/a.ts']);
    r.commit('test(client): tests (#2)', ['client/test/unit/z.test.ts']);
    const head = r.commit('docs(client): readme (#3)', ['client/README.md']);
    const w = world([devRel('0.5.1-dev.380', { target_commitish: base })], [], {}, { script: r.script, sha: head });
    w.build('0.5.1-dev.387');
    const run = w.run('0.5.1-dev.387');
    expect(run.code, run.out).toBe(0);
    expect(page(w, '0.5.1-dev.387')).toBe('开发版\n');
    expect(run.out).toContain('发版页不带更新说明：发版说明没有新增条目，也没有没写说明的 App 改动');
  });
});
