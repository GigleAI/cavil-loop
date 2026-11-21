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
import { FAKE_GH as STATEFUL_GH } from './fake-gh-releases';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_GH_FAIL) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }
if (process.argv.some((x) => x.includes('/git/matching-refs/tags/'))) {
  if (process.env.FAKE_GH_FAIL_TAGS) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }
  const tags = JSON.parse(process.env.FAKE_GH_TAGS || '[]');
  process.stdout.write(JSON.stringify([tags.map((t) => ({ ref: 'refs/tags/' + t, object: { type: 'commit', sha: 'a'.repeat(40) } }))]));
  process.exit(0);
}
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

function run(r: ReturnType<typeof repo>, list: unknown[] | 'fail', args: string[], tags: string[] | 'fail' = []) {
  const listFile = join(r.dir, '..', `${r.dir.split('/').pop()}-list.json`);
  const out = join(r.dir, '..', `${r.dir.split('/').pop()}-output`);
  const calls = join(r.dir, '..', `${r.dir.split('/').pop()}-calls`);
  writeFileSync(listFile, JSON.stringify(list === 'fail' ? [] : list));
  writeFileSync(out, '');
  writeFileSync(calls, '');
  const p = spawnSync(process.execPath, [join(r.dir, 'client', 'scripts', 'dev-plan.mjs'), ...args], {
    cwd: join(r.dir, 'client'),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${r.bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, FAKE_GH_LIST: listFile, FAKE_GH_CALLS: calls, FAKE_GH_FAIL: list === 'fail' ? '1' : '', FAKE_GH_TAGS: JSON.stringify(tags === 'fail' ? [] : tags), FAKE_GH_FAIL_TAGS: tags === 'fail' ? '1' : '' },
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

  // PR #630 Q1 = B: a public build is never changed. Not complete on its own commit → nothing to put
  // out (forced: built and checked; the publish step refuses); on any later commit → a higher version
  it('the last build is published but not complete: on its own commit → no build (forced → build); after any later commit → build; complete → skips', () => {
    const r = repo();
    const head = r.commit('client/app.txt');
    const tag = 'client/v0.5.3-dev.2';
    const later = r.commit('scripts/daemon.sh'); // main moved on with a daemon-only commit
    const shapes: [string, unknown][] = [
      ...[['-windows-x64.exe'], ['latest.json'], ['-arm64.app.tar.gz.sig'], ['-windows-x64.exe', '-windows-x64.exe.sig', 'latest.json']].map((g) => [g.join(','), without(tag, head, ...g)] as [string, unknown]),
      // an asset of the right name that never finished uploading, or with no state (review round 2 #8)
      ...[{ state: 'starter', size: 0 }, {}, { state: 'uploaded', size: 0 }].map((bad) => {
        const r2 = rel(tag, head);
        return [JSON.stringify(bad), { ...r2, assets: r2.assets.map((a) => (a.name.endsWith('-windows-x64.exe') ? { name: a.name, ...bad } : a)) }] as [string, unknown];
      }),
      ['no assets at all', rel(tag, head, { assets: [] })],
    ];
    for (const [name, rl] of shapes) {
      const same = run(r, [rl], ['--sha', head]);
      expect(same, name).toMatchObject({ code: 0, build: 'false' });
      expect(same.why, name).toContain('已公开的版本一律不改');
      expect(run(r, [rl], ['--sha', head, '--force']).build, name).toBe('true');
      const next = run(r, [rl], ['--sha', later]);
      expect(next, name).toMatchObject({ code: 0, build: 'true' });
      expect(next.why, name).toContain('更高的版本');
    }
    // a file whose upload state cannot be judged: said so
    const r3 = rel(tag, head);
    const noState = run(r, [{ ...r3, assets: r3.assets.map((a) => (a.name.endsWith('latest.json') ? { name: a.name, size: 10 } : a)) }], ['--sha', later]);
    expect(noState.build).toBe('true');
    expect(noState.why).toContain('读不出');
    // complete: same commit or daemon-only commits since → nothing to do
    expect(run(r, [rel(tag, head)], ['--sha', head]).build).toBe('false');
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

  // review round 4 #9: a build that was public and was hidden again (the publish step turned it back
  // into a draft to fill it in, and could not finish). The plan's token cannot see drafts; the tag the
  // build kept shows it.
  it('a higher build that is tagged but not public → builds, client change or not; tags of public or lower builds do not count', () => {
    const r = repo();
    const base = r.head();
    const head = r.commit('scripts/daemon.sh');
    const list = [rel('client/v0.5.3-dev.10', base)];
    expect(run(r, list, ['--sha', head], ['client/v0.5.3-dev.10']).build).toBe('false');
    const hidden = run(r, list, ['--sha', head], ['client/v0.5.3-dev.10', 'client/v0.5.3-dev.12']);
    expect(hidden).toMatchObject({ code: 0, build: 'true' });
    expect(hidden.why).toContain('client/v0.5.3-dev.12');
    expect(hidden.why).toContain('没有公开');
    expect(hidden.calls.some((c: string[]) => c.some((x) => x.includes('git/matching-refs/tags/client/v')))).toBe(true);
    // a lower one (an old build the clean-up is removing), other shapes, a release tag: nothing
    expect(run(r, list, ['--sha', head], ['client/v0.5.3-dev.9', 'client/v0.6.0', 'client/v0.5.3-dev.x', 'release/v2026.11.15.1']).build).toBe('false');
    // a draft of a higher version, when the token does see drafts
    const draft = run(r, [...list, rel('client/v0.5.3-dev.11', head, { draft: true })], ['--sha', head]);
    expect(draft.build).toBe('true');
    expect(draft.why).toContain('停在草稿');
    // the tag list cannot be read → build
    const unreadable = run(r, list, ['--sha', head], 'fail');
    expect(unreadable).toMatchObject({ code: 0, build: 'true' });
    expect(unreadable.why).toContain('读不到标签列表');
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
    expect(plan({ latest: { ...latest, complete: false }, head: 'a'.repeat(40), force: false, changed: false }).build).toBe(false);
    expect(plan({ latest: { ...latest, complete: false }, head: 'a'.repeat(40), force: true, changed: false }).build).toBe(true);
    expect(plan({ latest: { ...latest, complete: false }, head: 'b'.repeat(40), force: false, changed: false }).build).toBe(true);
  });
});

// Review rounds 4–5 #9 under the maintainer's choice (PR #630 Q1 = B: a public build is never changed),
// as one lifecycle over several nights: the nightly plan (read-only token: drafts are not listed) and
// the publish step (a token that can write) run, as the workflow runs them, against one stateful fake
// GitHub. The previous build stays public and complete the whole time.
describe('a public build that broke is never changed; the next commit puts out a higher version over it (GitHub#628, PR #630 Q1 = B)', () => {
  it('forced build of a daemon-only commit → one of its files breaks → nights on that commit write nothing → the next commit publishes a higher version, the broken one untouched', () => {
    const r = repo();
    const a = r.commit('client/app.txt');
    const b = r.commit('scripts/daemon.sh'); // main moves on with a daemon-only commit
    const X = '0.5.3-dev.10';
    const Y = '0.5.3-dev.11';
    const asset = (name: string) => ({ name, state: 'uploaded', size: 10 });
    const tag = (v: string) => `client/v${v}`;
    const state = join(r.dir, '..', `${r.dir.split('/').pop()}-world.json`);
    writeFileSync(
      state,
      JSON.stringify({
        releases: [{ id: 1, tag_name: tag(X), draft: false, prerelease: true, target_commitish: a, assets: devFiles(X).map(asset) }],
        tags: [tag(X)],
        tagSha: { [tag(X)]: a },
        fail: [],
        calls: [],
        deleted: [],
        tagsDeleted: [],
        nextId: 100,
        sha: b,
      }),
    );
    const sbin = join(r.dir, '..', `${r.dir.split('/').pop()}-sbin`);
    mkdirSync(sbin, { recursive: true });
    writeFileSync(join(sbin, 'gh'), STATEFUL_GH);
    chmodSync(join(sbin, 'gh'), 0o755);
    const world = () => JSON.parse(readFileSync(state, 'utf8'));
    const edit = (f: (w: any) => void) => {
      const w = world();
      f(w);
      writeFileSync(state, JSON.stringify(w));
    };
    const env = (readonly: boolean, out = '') => ({ ...process.env, PATH: `${sbin}:${process.env.PATH}`, FAKE_GH_STATE: state, FAKE_GH_READONLY: readonly ? '1' : '', GITHUB_OUTPUT: out });
    const plan = (head: string, force = false) => {
      const out = join(r.dir, '..', `${r.dir.split('/').pop()}-plan-out`);
      writeFileSync(out, '');
      const p = spawnSync(process.execPath, [join(r.dir, 'client', 'scripts', 'dev-plan.mjs'), '--sha', head, ...(force ? ['--force'] : [])], { cwd: join(r.dir, 'client'), encoding: 'utf8', env: env(true, out) });
      expect(p.status, p.stdout + p.stderr).toBe(0);
      const o = readFileSync(out, 'utf8');
      return { build: /^build=(.*)$/m.exec(o)?.[1], why: /^why=(.*)$/m.exec(o)?.[1] ?? '' };
    };
    const dist = join(r.dir, '..', `${r.dir.split('/').pop()}-dist`);
    const notes = join(r.dir, '..', `${r.dir.split('/').pop()}-notes.md`);
    writeFileSync(notes, '开发版\n');
    const publish = (v: string, sha: string) => {
      rmSync(dist, { recursive: true, force: true });
      mkdirSync(dist);
      for (const f of devFiles(v)) writeFileSync(join(dist, f), `${f} ${Math.random()}`);
      const p = spawnSync(process.execPath, [join(r.dir, 'client', 'scripts', 'dev-release.mjs'), '--version', v, '--sha', sha, '--dir', dist, '--notes-file', notes], { cwd: join(r.dir, 'client'), encoding: 'utf8', env: env(false) });
      return { code: p.status, out: p.stdout + p.stderr };
    };
    const rel = (v: string) => world().releases.find((x: any) => x.tag_name === tag(v));
    const complete = (v: string) => rel(v)?.draft === false && rel(v)?.prerelease === true && devFiles(v).every((f) => rel(v).assets.some((x: any) => x.name === f && x.state === 'uploaded' && x.size > 0));
    const xStays = (when: string) => expect(complete(X), `${X} public and complete ${when}`).toBe(true);

    // night 1: nothing changed in the client since X; a maintainer forces a build of b → Y, published
    expect(plan(b).build).toBe('false');
    expect(plan(b, true).build).toBe('true');
    expect(publish(Y, b).code).toBe(0);
    expect(complete(Y)).toBe(true);
    xStays('after Y came out');

    // one of Y's files breaks (a placeholder left where the Windows installer was)
    edit((w) => {
      const y = w.releases.find((x: any) => x.tag_name === tag(Y));
      y.assets = y.assets.map((x: any) => (x.name.endsWith('-windows-x64.exe') ? { name: x.name, state: 'starter', size: 0 } : x));
    });
    const brokenY = JSON.stringify(rel(Y));

    // night 2, same commit: nothing to build — the public Y is not changed
    const n2 = plan(b);
    expect(n2.build, n2.why).toBe('false');
    expect(n2.why).toContain('已公开的版本一律不改');
    // forced anyway: built, and the publish step refuses — no write at all, Y exactly as it was
    expect(plan(b, true).build).toBe('true');
    const writesBefore = world().calls.filter((c: string[]) => c[0] === 'release').length;
    const p2 = publish(Y, b);
    expect(p2.code).toBe(1);
    expect(p2.out).toContain('已公开的版本一律不改');
    expect(world().calls.filter((c: string[]) => c[0] === 'release').length).toBe(writesBefore);
    expect(JSON.stringify(rel(Y))).toBe(brokenY);
    xStays('while Y is broken');

    // the next commit (daemon-only, no client change): a higher version Z comes out over Y
    const c = r.commit('scripts/daemon.sh');
    const Z = '0.5.3-dev.12';
    const n3 = plan(c);
    expect(n3.build, n3.why).toBe('true');
    expect(n3.why).toContain('更高的版本');
    const p3 = publish(Z, c);
    expect(p3.code, p3.out).toBe(0);
    expect(complete(Z)).toBe(true);
    expect(JSON.stringify(rel(Y))).toBe(brokenY); // the broken public one is never touched
    xStays('after Z came out');

    // and the night after: Z is complete, of this very commit → nothing to do
    expect(plan(c).build).toBe('false');
  });
});
