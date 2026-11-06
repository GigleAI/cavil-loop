// Which negative controls `--changed` picks (GitHub#178). Each case builds a real git repository
// shaped like this one (client/ under the top level, tests/lib/mutation.sh beside it), copies the
// real runner files into it, commits a base, makes one kind of change and runs the real
// `run.mjs --changes` / `--select` (and run.sh for the "cannot tell" exit). Only the entry list and
// the "which file holds which test" map are fixtures: the map is what the baseline writes in a
// real run, which needs the whole suite.
//
// Not skipped inside the negative-control runner's child runs: the entries that break select.mjs
// (test/mutation/mutations.mjs) need these cases to go red.

import { describe, expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// inside the negative-control runner's copies, tests/lib is not copied: take it from the real checkout
const repoLib = join(process.env.CLIENT_MUT_REPO ?? root, '..', 'tests', 'lib', 'mutation.sh');

const ENTRIES = [
  { what: 'A 坏了', file: 'src/a.ts', from: 'a = 1', to: 'a = 2', expect: ['alpha works'] },
  { what: 'B 坏了', file: 'src/b.ts', from: 'b = 1', to: 'b = 2', expect: ['beta works'] },
  { what: '后台坏了', edits: [{ file: 'src-tauri/x.rs', from: 'x', to: 'y' }], expect: ['gamma works'] },
];
const MAP = [
  { name: 'suite a alpha works', file: 'test/unit/a.test.ts' },
  { name: 'suite b beta works', file: 'test/unit/b.test.ts' },
  { name: 'suite c gamma works', file: 'test/unit/c.test.ts' },
  { name: 'suite c something else', file: 'test/unit/c.test.ts' },
];

const listModule = (entries: unknown[]) => `export const MUTATIONS = ${JSON.stringify(entries, null, 2)};\n`;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
}

/** A repository with a committed base; returns paths. `withList: false` = the base predates mutations.mjs. */
function repo(opts: { withList?: boolean } = {}) {
  const top = tempDir();
  const client = join(top, 'client');
  const files: Record<string, string> = {
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 1;\n',
    'src/z.ts': 'export const z = 1;\n',
    'src-tauri/x.rs': 'fn x() {}\n',
    'src-tauri/src/main.rs': 'fn main() {}\n',
    'test/unit/a.test.ts': "it('alpha works', () => expect(1).toBe(1));\n",
    'test/unit/b.test.ts': "it('beta works', () => expect(1).toBe(1));\n",
    'test/unit/c.test.ts': "it('gamma works', () => expect(1).toBe(1));\n",
    'test/support/helper.ts': 'export const h = 1;\n',
  };
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(client, f)), { recursive: true });
    writeFileSync(join(client, f), text);
  }
  mkdirSync(join(client, 'test', 'mutation'), { recursive: true });
  for (const f of ['run.mjs', 'run.sh', 'select.mjs']) cpSync(join(root, 'test', 'mutation', f), join(client, 'test', 'mutation', f));
  mkdirSync(join(client, 'test', 'tauri'), { recursive: true });
  cpSync(join(root, 'test', 'tauri', 'mutations.mjs'), join(client, 'test', 'tauri', 'mutations.mjs'));
  mkdirSync(join(top, 'tests', 'lib'), { recursive: true });
  cpSync(repoLib, join(top, 'tests', 'lib', 'mutation.sh'));
  if (opts.withList !== false) writeFileSync(join(client, 'test', 'mutation', 'mutations.mjs'), listModule(ENTRIES));
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'add', '-A');
  git(top, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
  const base = git(top, 'rev-parse', 'HEAD').trim();
  if (opts.withList === false) writeFileSync(join(client, 'test', 'mutation', 'mutations.mjs'), listModule(ENTRIES));
  const state = join(top, '.state');
  mkdirSync(state);
  writeFileSync(join(state, 'unit-tests.json'), JSON.stringify(MAP));
  return { top, client, base, state };
}

function node(r: ReturnType<typeof repo>, args: string[], env: Record<string, string> = {}) {
  const p = spawnSync(process.execPath, [join(r.client, 'test', 'mutation', 'run.mjs'), ...args], {
    cwd: r.client,
    encoding: 'utf8',
    env: { ...process.env, CLIENT_MUT_STATE: r.state, CLIENT_MUT_BASE: r.base, CLIENT_MUT_LIST: '', ...env },
  });
  return { status: p.status, out: p.stdout, err: p.stderr };
}

/** --changes then --select, as run.sh does; returns the picked indices and the explanation. */
function pick(r: ReturnType<typeof repo>, env: Record<string, string> = {}) {
  const c = node(r, ['--changes'], env);
  if (c.status !== 0) return { status: c.status, picked: null as number[] | null, text: c.out + c.err };
  writeFileSync(join(r.state, 'changes.json'), c.out);
  const s = node(r, ['--select', '--changed'], env);
  const picked = s.status === 0 ? s.out.trim().split(/\s+/).filter(Boolean).map(Number) : null;
  return { status: s.status, picked, text: s.out + s.err };
}

const edit = (r: ReturnType<typeof repo>, f: string, text: string) => writeFileSync(join(r.client, f), text);

describe('negative controls related to a change (--changed)', () => {
  it('a new entry is picked, and only it', () => {
    const r = repo();
    edit(r, 'test/mutation/mutations.mjs', listModule([...ENTRIES, { what: 'Z 坏了', file: 'src/z.ts', from: 'z = 1', to: 'z = 2', expect: ['alpha works'] }]));
    expect(pick(r).picked).toEqual([3]);
  });

  it('an edited entry is picked, and only it', () => {
    const r = repo();
    edit(r, 'test/mutation/mutations.mjs', listModule([ENTRIES[0], { ...ENTRIES[1], to: 'b = 3' }, ENTRIES[2]]));
    expect(pick(r).picked).toEqual([1]);
  });

  it('a change to the product file an entry breaks picks that entry (also when only committed)', () => {
    const r = repo();
    edit(r, 'src/a.ts', 'export const a = 1; // changed\n');
    expect(pick(r).picked).toEqual([0]);
    git(r.top, 'add', '-A');
    git(r.top, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'change a');
    expect(pick(r).picked).toEqual([0]);
  });

  it('editing only a test (no product file, no entry): the entries naming tests in it are picked', () => {
    const r = repo();
    edit(r, 'test/unit/c.test.ts', "it('gamma works', () => expect(1).toBeDefined());\n");
    const got = pick(r);
    expect(got.picked).toEqual([2]);
    expect(got.text).toContain('test/unit/c.test.ts');
  });

  it('shared test plumbing (helpers, fake GitHub, the runner, the mutation switch): every entry', () => {
    const r = repo();
    edit(r, 'test/support/helper.ts', 'export const h = 2;\n');
    expect(pick(r).picked).toEqual([0, 1, 2]);
    const r2 = repo();
    writeFileSync(join(r2.top, 'tests', 'lib', 'mutation.sh'), `${readFileSync(join(r2.top, 'tests', 'lib', 'mutation.sh'), 'utf8')}\n# changed\n`);
    expect(pick(r2).picked).toEqual([0, 1, 2]);
    const r3 = repo();
    writeFileSync(join(r3.client, 'test', 'support', 'brand-new.ts'), 'export {};\n'); // untracked counts
    expect(pick(r3).picked).toEqual([0, 1, 2]);
  });

  it('a base with no separate entry list yet: every entry counts as new', () => {
    const r = repo({ withList: false });
    const got = pick(r);
    expect(got.picked).toEqual([0, 1, 2]);
  });

  it('nothing related: empty pick, exit 0, says which files changed', () => {
    const r = repo();
    edit(r, 'src/z.ts', 'export const z = 2;\n');
    const got = pick(r);
    expect(got.status).toBe(0);
    expect(got.picked).toEqual([]);
    expect(got.text).toContain('没有相关负对照');
    expect(got.text).toContain('src/z.ts');
  });

  it('cannot tell is never "nothing related": unknown base, not a git checkout, a named test nobody maps', () => {
    const r = repo();
    edit(r, 'src/a.ts', 'export const a = 3;\n');
    const unknown = pick(r, { CLIENT_MUT_BASE: 'no-such-ref' });
    expect(unknown.status).not.toBe(0);
    expect(unknown.picked).toBeNull();
    expect(unknown.text).toContain('判断不了');

    const r2 = repo();
    rmSync(join(r2.top, '.git'), { recursive: true, force: true });
    const nogit = pick(r2);
    expect(nogit.status).not.toBe(0);
    expect(nogit.text).toContain('判断不了');

    const r3 = repo();
    edit(r3, 'src/z.ts', 'export const z = 2;\n');
    writeFileSync(join(r3.state, 'unit-tests.json'), JSON.stringify(MAP.filter((t) => !t.name.includes('beta'))));
    const unmapped = pick(r3);
    expect(unmapped.status).not.toBe(0);
    expect(unmapped.picked).toBeNull();
    expect(unmapped.text).toContain('beta works');
  });

  it('run.sh --changed stops with exit 1 before the baseline when the base cannot be read', () => {
    const r = repo();
    const p = spawnSync('bash', [join(r.client, 'test', 'mutation', 'run.sh'), '--changed'], {
      cwd: r.client,
      encoding: 'utf8',
      env: { ...process.env, MUTATION: '1', CLIENT_MUT_BASE: 'no-such-ref', CLIENT_MUT_LIST: '' },
    });
    const out = `${p.stdout}${p.stderr}`;
    expect(p.status).toBe(1);
    expect(out).toContain('判断不了这次改了什么');
    expect(out).not.toContain('基线');
    expect(out).not.toContain('按预期变红');
    // the same script with a readable base gets past that point (reaches the baseline)
    const ok = spawnSync('bash', [join(r.client, 'test', 'mutation', 'run.sh'), '--changed'], {
      cwd: r.client,
      encoding: 'utf8',
      env: { ...process.env, MUTATION: '1', CLIENT_MUT_BASE: r.base, CLIENT_MUT_LIST: '', CLIENT_MUT_VITEST: '/nonexistent/vitest.mjs' },
    });
    expect(`${ok.stdout}${ok.stderr}`).toContain('基线没跑成');
    expect(existsSync(join(r.client, 'test', 'mutation', 'run.sh'))).toBe(true);
  });

  it('the real-app set: related when the app shell changed, "nothing related" otherwise, cannot tell = exit 2', () => {
    const related = (r: ReturnType<typeof repo>, env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [join(r.client, 'test', 'tauri', 'mutations.mjs'), '--related'], {
        cwd: r.client,
        encoding: 'utf8',
        env: { ...process.env, CLIENT_MUT_BASE: r.base, ...env },
      });
    const r = repo();
    edit(r, 'src/z.ts', 'export const z = 2;\n');
    const none = related(r);
    expect(none.status).toBe(1);
    expect(none.stdout).toContain('没有相关的真实窗口负对照');
    expect(none.stdout).toContain('src/z.ts');
    edit(r, 'src-tauri/src/main.rs', 'fn main() { }\n');
    const yes = related(r);
    expect(yes.status).toBe(0);
    expect(yes.stdout).toContain('src-tauri/src/main.rs');
    const unknown = related(r, { CLIENT_MUT_BASE: 'no-such-ref' });
    expect(unknown.status).toBe(2);
    expect(unknown.stdout).toContain('判断不了');
  });
});
