// "Anything new to publish tonight?" (GitHub#628, scripts/dev-plan.mjs) — the real script, run the
// way the workflow's mode job runs it, in a real git repository (client/ plus files outside it),
// against a fake `gh` that answers the release list from a JSON file or fails.
//
// The maintainer's choice on #628 (Q1 = A): a development build only when the client changed since
// the last published one. Unknown is never "nothing changed": it builds.

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';
import { plan } from '../../scripts/dev-plan.mjs';
import { devFiles } from '../../scripts/dev-release.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_GH_FAIL) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }
process.stdout.write(JSON.stringify([JSON.parse(fs.readFileSync(process.env.FAKE_GH_LIST, 'utf8'))]));
`;

function repo() {
  const dir = tempDir();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  mkdirSync(join(dir, 'client', 'scripts'), { recursive: true });
  for (const f of ['dev-plan.mjs', 'dev-release.mjs', 'update-manifest.mjs']) copyFileSync(join(root, 'scripts', f), join(dir, 'client', 'scripts', f));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(dir, '.github', 'actions', 'client-setup'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'client.yml'), 'v1\n');
  writeFileSync(join(dir, '.github', 'workflows', 'tests.yml'), 'v1\n');
  writeFileSync(join(dir, '.github', 'actions', 'client-setup', 'action.yml'), 'v1\n');
  writeFileSync(join(dir, 'client', 'app.txt'), 'v1\n');
  writeFileSync(join(dir, 'scripts', 'daemon.sh'), 'v1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const commit = (path: string) => {
    writeFileSync(join(dir, path), `${Math.random()}\n`);
    git('add', '-A');
    git('commit', '-qm', `change ${path}`);
    return git('rev-parse', 'HEAD');
  };
  const bin = join(dir, '..', `${dir.split('/').pop()}-bin`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  return { dir, git, commit, head: () => git('rev-parse', 'HEAD'), bin };
}

// a published development build carrying every file a build carries, unless `extra` says otherwise
const rel = (tag: string, sha: unknown, extra: object = {}) => ({
  id: Math.floor(Math.random() * 1e9),
  tag_name: tag,
  draft: false,
  prerelease: true,
  target_commitish: sha,
  assets: tag.startsWith('client/v') ? devFiles(tag.slice('client/v'.length)).map((name) => ({ name, state: 'uploaded', size: 10 })) : [],
  ...extra,
});
// the same build with some of its files missing
const without = (tag: string, sha: string, ...gone: string[]) => {
  const r = rel(tag, sha);
  return { ...r, assets: r.assets.filter((a) => !gone.some((g) => a.name.endsWith(g))) };
};

function run(r: ReturnType<typeof repo>, list: unknown[] | 'fail', args: string[]) {
  const listFile = join(r.dir, '..', `${r.dir.split('/').pop()}-list.json`);
  const out = join(r.dir, '..', `${r.dir.split('/').pop()}-output`);
  const calls = join(r.dir, '..', `${r.dir.split('/').pop()}-calls`);
  writeFileSync(listFile, JSON.stringify(list === 'fail' ? [] : list));
  writeFileSync(out, '');
  writeFileSync(calls, '');
  const p = spawnSync(process.execPath, [join(r.dir, 'client', 'scripts', 'dev-plan.mjs'), ...args], {
    cwd: join(r.dir, 'client'),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${r.bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, FAKE_GH_LIST: listFile, FAKE_GH_CALLS: calls, FAKE_GH_FAIL: list === 'fail' ? '1' : '' },
  });
  const o = readFileSync(out, 'utf8');
  return { code: p.status, stdout: p.stdout, build: /^build=(.*)$/m.exec(o)?.[1], why: /^why=(.*)$/m.exec(o)?.[1] ?? '', calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

describe('dev-plan: is there anything new to publish (GitHub#628)', () => {
  it('builds when the client changed since the last published development build, from the newest build by version', () => {
    const r = repo();
    const base = r.head();
    r.commit('client/app.txt');
    const head = r.head();
    // the newest by version is the one compared with — dev.9 < dev.10, list order does not matter
    const got = run(r, [rel('client/v0.5.3-dev.9', 'f'.repeat(40)), rel('client/v0.5.3-dev.10', base)], ['--sha', head]);
    expect(got).toMatchObject({ code: 0, build: 'true' });
    expect(got.why).toContain('client/v0.5.3-dev.10');
    expect(got.why).toContain('有改动');
    // it read every page of the list
    expect(got.calls[0]).toEqual(expect.arrayContaining(['--paginate', '--slurp']));
  });

  it.each([
    ['the workflow file', '.github/workflows/client.yml'],
    ['the client test setup', '.github/actions/client-setup/action.yml'],
  ])('a change to %s counts as a client change', (_, path) => {
    const r = repo();
    const base = r.head();
    const head = r.commit(path);
    expect(run(r, [rel('client/v0.5.3-dev.10', base)], ['--sha', head]).build).toBe('true');
  });

  it('no client change since the last build (main moved on with daemon-only commits) → no build; with --force → build', () => {
    const r = repo();
    const base = r.head();
    r.commit('scripts/daemon.sh');
    const head = r.commit('.github/workflows/tests.yml');
    const list = [rel('client/v0.5.3-dev.10', base)];
    const plain = run(r, list, ['--sha', head]);
    expect(plain).toMatchObject({ code: 0, build: 'false' });
    expect(plain.why).toContain('没有改动');
    const forced = run(r, list, ['--sha', head, '--force']);
    expect(forced).toMatchObject({ code: 0, build: 'true' });
    expect(forced.why).toContain('客户端没改动也出');
  });

  it('the same commit two nights running: the second night builds nothing; forced, it builds (and the publish step finds the version already out)', () => {
    const r = repo();
    const head = r.commit('client/app.txt');
    const list = [rel('client/v0.5.3-dev.2', head)];
    expect(run(r, list, ['--sha', head])).toMatchObject({ code: 0, build: 'false' });
    const forced = run(r, list, ['--sha', head, '--force']);
    expect(forced).toMatchObject({ code: 0, build: 'true' });
    expect(forced.why).toContain('已经发过');
  });

  it('the last build is published but not complete → builds, on the same commit and after daemon-only commits; complete → skips (review round 1 #2)', () => {
    const r = repo();
    const head = r.commit('client/app.txt');
    const tag = 'client/v0.5.3-dev.2';
    for (const gone of [['-windows-x64.exe'], ['latest.json'], ['-arm64.app.tar.gz.sig'], ['-windows-x64.exe', '-windows-x64.exe.sig', 'latest.json']]) {
      const got = run(r, [without(tag, head, ...gone)], ['--sha', head]);
      expect(got, gone.join(',')).toMatchObject({ code: 0, build: 'true' });
      expect(got.why).toContain('没带齐文件');
    }
    // an asset of the right name that never finished uploading, or with no state: not there (review round 2 #8)
    for (const bad of [{ state: 'starter', size: 0 }, {}, { state: 'uploaded', size: 0 }]) {
      const r2 = rel(tag, head);
      const assets = r2.assets.map((a) => (a.name.endsWith('-windows-x64.exe') ? { name: a.name, ...bad } : a));
      expect(run(r, [{ ...r2, assets }], ['--sha', head]).build, JSON.stringify(bad)).toBe('true');
    }
    // no assets at all (the review's example)
    expect(run(r, [rel(tag, head, { assets: [] })], ['--sha', head]).build).toBe('true');
    expect(run(r, [rel(tag, head)], ['--sha', head]).build).toBe('false');
    // main moved on with a daemon-only commit
    const later = r.commit('scripts/daemon.sh');
    expect(run(r, [without(tag, head, '-windows-x64.exe')], ['--sha', later]).build).toBe('true');
    expect(run(r, [rel(tag, head)], ['--sha', later]).build).toBe('false');
  });

  it('last night failed (nothing published since): tonight builds the changes again', () => {
    const r = repo();
    const published = r.head();
    r.commit('client/app.txt'); // last night's build of this failed: no release for it
    const head = r.commit('scripts/daemon.sh');
    expect(run(r, [rel('client/v0.5.3-dev.10', published)], ['--sha', head]).build).toBe('true');
  });

  it('cannot tell → builds: list unreadable, no build yet, no commit recorded, commit not in this clone', () => {
    const r = repo();
    const head = r.commit('scripts/daemon.sh');
    const unreadable = run(r, 'fail', ['--sha', head]);
    expect(unreadable).toMatchObject({ code: 0, build: 'true' });
    expect(unreadable.why).toContain('读不到发版列表');
    expect(run(r, [], ['--sha', head]).build).toBe('true');
    // only drafts, releases and other shapes: none of them is a published development build
    expect(run(r, [rel('client/v0.5.3-dev.11', head, { draft: true }), rel('client/v0.5.2', head, { prerelease: false }), rel('release/v2026.11.15.1', head, { prerelease: false })], ['--sha', head]).build).toBe('true');
    expect(run(r, [rel('client/v0.5.3-dev.10', 'main')], ['--sha', head]).why).toContain('没记下完整的提交号');
    const missing = run(r, [rel('client/v0.5.3-dev.10', '1'.repeat(40))], ['--sha', head]);
    expect(missing).toMatchObject({ code: 0, build: 'true' });
    expect(missing.why).toContain('比不出');
  });

  it('refuses a commit that is not a full id, and writes no decision', () => {
    const r = repo();
    const got = run(r, [], ['--sha', 'main']);
    expect(got.code).not.toBe(0);
    expect(got.build).toBeUndefined();
    rmSync(r.dir, { recursive: true, force: true });
  });

  it('the decision table itself (no git, no gh)', () => {
    const latest = { tag: 'client/v0.5.3-dev.10', sha: 'a'.repeat(40), complete: true };
    expect(plan({ latest, head: 'b'.repeat(40), force: false, changed: true }).build).toBe(true);
    expect(plan({ latest, head: 'b'.repeat(40), force: false, changed: false }).build).toBe(false);
    expect(plan({ latest, head: 'b'.repeat(40), force: true, changed: false }).build).toBe(true);
    expect(plan({ latest, head: 'b'.repeat(40), force: false, changed: null }).build).toBe(true);
    expect(plan({ latest, head: 'a'.repeat(40), force: false, changed: () => { throw new Error('not asked'); } }).build).toBe(false);
    expect(plan({ latest: { ...latest, complete: false }, head: 'a'.repeat(40), force: false, changed: false }).build).toBe(true);
  });
});
