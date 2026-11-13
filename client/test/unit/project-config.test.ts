// A project's "配置" (GitHub#388). Two halves:
//   - the pure rules the dialog draws from (shared/daemon.ts);
//   - the real back end (Rust, child process) running the daemon's real
//     scripts/project-config.sh in a fake HOME, on a project the real setup.sh
//     connected. Results are read back from the config file on disk, not from
//     the back end's word.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { connect, daemonEnv, daemonWorld, dropWorlds, installByHand, pathFor, wrapTool, type DaemonWorld, type Os } from '../support/daemon-world';
import { canEdit, configGroups, draftChanges, fieldProblem, saveKind, saveWord, valueText, type ConfigField, type ProjectConfig } from '../../src/shared/daemon';
import { tempDir } from './helpers';

const field = (o: Partial<ConfigField>): ConfigField => ({ name: 'X', group: 'g', mode: 'edit', label: 'x', help: '', type: 'model', value: '', default: '', in_file: true, editable: true, reason: null, ...o });

describe('the rules the form is drawn from', () => {
  it('a typed value is checked by the field\'s type; nothing with a blank, quote or $ ever passes', () => {
    const int = field({ type: 'int', min: 1, max: 16 });
    expect(['1', '16', '7'].map((v) => fieldProblem(int, v))).toEqual([null, null, null]);
    for (const v of ['0', '17', '', '01', '2.5', '-1', ' 2', '2;x']) expect(fieldProblem(int, v), v).not.toBeNull();
    const model = field({ type: 'model' });
    expect(['', 'opus-5.5', 'vendor/model:1@x'].map((v) => fieldProblem(model, v))).toEqual([null, null, null]);
    for (const v of ['a b', 'a"b', '$HOME', '`id`', "a'b", 'a\\b', 'a\nb', '-x', 'a;b', '中']) expect(fieldProblem(model, v), v).not.toBeNull();
    const agent = field({ type: 'agent', options: [{ value: 'claude', label: 'claude' }, { value: 'codex', label: 'codex' }] });
    expect(fieldProblem(agent, 'codex')).toBeNull();
    expect(fieldProblem(agent, 'other')).not.toBeNull();
    const sw = field({ type: 'bool', on: 'on', off: 'off' });
    expect([fieldProblem(sw, 'on'), fieldProblem(sw, 'off')]).toEqual([null, null]);
    expect(fieldProblem(sw, 'true')).not.toBeNull();
    // a type this client has not heard of is never an input
    expect(fieldProblem(field({ type: 'path' }), 'x')).not.toBeNull();
  });

  it('only what the daemon calls editable, of a type the client knows, is an input', () => {
    expect(canEdit(field({}))).toBe(true);
    expect(canEdit(field({ editable: false }))).toBe(false);
    expect(canEdit(field({ mode: 'show' }))).toBe(false);
    expect(canEdit(field({ type: 'label' }))).toBe(false);
    expect(canEdit(field({ type: 'command' }))).toBe(false);
  });

  it('a save sends only editable fields whose value really differs', () => {
    const fields = [field({ name: 'A', value: '1', type: 'int', min: 1, max: 9 }), field({ name: 'B', value: 'x' }), field({ name: 'C', value: 'x', editable: false }), field({ name: 'D', mode: 'show', value: 'x' })];
    expect(draftChanges(fields, { A: '2', B: 'x', C: 'y', D: 'y', E: 'z' })).toEqual({ A: '2' });
    expect(draftChanges(fields, {})).toEqual({});
  });

  it('values read as a person would say them; groups keep the daemon\'s order', () => {
    expect(valueText(field({ type: 'label' }), '')).toBe('关');
    expect(valueText(field({ type: 'label' }), 'pending/review')).toBe('开，标签 pending/review');
    expect(valueText(field({ type: 'bool', on: 'true', off: 'false' }), 'false')).toBe('关');
    expect(valueText(field({ type: 'enum', options: [{ value: 'zh', label: '中文' }] }), 'zh')).toBe('中文（zh）');
    expect(valueText(field({}), '')).toBe('（空）');
    const g = configGroups([field({ name: 'A', group: 'one' }), field({ name: 'B', group: 'two' }), field({ name: 'C', group: 'one' })]);
    expect(g.map((x) => [x.title, x.fields.map((f) => f.name)])).toEqual([['one', ['A', 'C']], ['two', ['B']]]);
  });

  it('a result word the client does not know is neither "saved" nor "nothing written"', () => {
    expect(saveKind('saved')).toBe('saved');
    expect(saveKind('unchanged')).toBe('unchanged');
    expect(saveKind('changed')).toBe('conflict');
    expect(saveKind('saved_then_changed')).toBe('rewritten');
    for (const w of ['invalid', 'not_editable', 'busy', 'unreadable', 'verify_failed', 'backup_failed', 'write_failed', 'not_found', 'refused']) {
      expect(saveKind(w), w).toBe('not_written');
      expect(saveWord(w), w).not.toBe('');
    }
    for (const w of ['unconfirmed', 'something_new', '']) expect(saveKind(w), w).toBe('unknown');
  });
});

describe('the back end and the daemon\'s real script', () => {
  const open: HarnessBackend[] = [];
  let w: DaemonWorld;
  let path: string;
  let host: string;
  let config: string;

  beforeEach(() => {
    w = daemonWorld(tempDir());
    installByHand(w);
    path = pathFor(w);
    host = connect(w, 'widget', 'Darwin', path);
    config = join(host, 'cavil-loop.config');
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((b) => b.close()));
    dropWorlds();
  });
  function backend(os: Os = 'Darwin', p = path) {
    const b = new HarnessBackend({
      db: join(w.dir, `cache-${open.length}.sqlite`),
      endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
      credentials: new MemoryStore(),
      env: daemonEnv(w, { os, path: p }),
    });
    open.push(b);
    return b;
  }
  const line = (name: string) => readFileSync(config, 'utf8').split('\n').filter((l) => l.startsWith(`${name}=`));
  const byName = (c: ProjectConfig, name: string) => c.fields.find((f) => f.name === name)!;

  it('reads the settings of a project the real setup.sh connected: values from its config, nothing secret', async () => {
    const r = await backend().call('daemonConfigGet', { key: 'widget' });
    expect(r.result).toBe('ok');
    const c: ProjectConfig = r.config;
    expect(c.config).toBe(config);
    expect(byName(c, 'WORKER_AGENT')).toMatchObject({ value: 'claude', in_file: true, editable: true, type: 'agent' });
    expect(byName(c, 'MAX_CONCURRENT_WORKERS')).toMatchObject({ value: '1', editable: true, min: 1, max: 16 });
    expect(byName(c, 'DISPATCH_MODE')).toMatchObject({ mode: 'show', value: 'label', editable: false });
    // every registered setting is in the template setup.sh writes, as a plain literal: all "edit" rows are inputs
    expect(c.fields.filter((f) => f.mode === 'edit' && !f.editable).map((f) => f.name)).toEqual([]);
    const all = JSON.stringify(r);
    for (const secret of ['GH_TOKEN', 'WORKTREE_SETUP_CMD', 'PR_CREATED_HOOK', 'npm ci', 'dangerously']) expect(all, secret).not.toContain(secret);
  });

  it('saves two settings: only those lines change, the pre-save file is the backup, the answer lists old and new', async () => {
    const b = backend();
    const before = readFileSync(config, 'utf8');
    const c: ProjectConfig = (await b.call('daemonConfigGet', { key: 'widget' })).config;
    const r = await b.call('daemonConfigSet', { key: 'widget', rev: c.rev, values: { MAX_CONCURRENT_WORKERS: '2', WORKER_AGENT: 'codex' } });
    expect(r.result).toBe('saved');
    expect(line('MAX_CONCURRENT_WORKERS')).toEqual(['MAX_CONCURRENT_WORKERS=2']);
    expect(line('WORKER_AGENT')).toEqual(['WORKER_AGENT="codex"']);
    const a = before.split('\n');
    const z = readFileSync(config, 'utf8').split('\n');
    expect(z.length).toBe(a.length);
    expect(z.filter((l, i) => l !== a[i]).sort()).toEqual(['MAX_CONCURRENT_WORKERS=2', 'WORKER_AGENT="codex"']);
    expect(r.detail.changes.map((x: any) => [x.name, x.old, x.new]).sort()).toEqual([
      ['MAX_CONCURRENT_WORKERS', '1', '2'],
      ['WORKER_AGENT', 'claude', 'codex'],
    ]);
    expect(readFileSync(r.detail.backup, 'utf8')).toBe(before);
    expect(statSync(r.detail.backup).mode & 0o777).toBe(0o600);
    // the daemon's own status now names the new agent (and that its program is missing on this machine)
    const s = await b.call('daemonStatus');
    const p = s.status.projects.find((x: any) => x.key === 'widget');
    expect(p.agents.find((x: any) => x.role === 'worker').agent).toBe('codex');
    expect(p.deps).toEqual({ state: 'missing', missing: ['codex'] });
  });

  it('a file edited since it was read: "changed", and the outside edit stays', async () => {
    const b = backend();
    const c: ProjectConfig = (await b.call('daemonConfigGet', { key: 'widget' })).config;
    writeFileSync(config, readFileSync(config, 'utf8') + '# edited elsewhere\n');
    const after = readFileSync(config, 'utf8');
    const r = await b.call('daemonConfigSet', { key: 'widget', rev: c.rev, values: { MAX_CONCURRENT_WORKERS: '2' } });
    expect(r.result).toBe('changed');
    expect(readFileSync(config, 'utf8')).toBe(after);
    // reachable: the same save with the fingerprint of the file as it is now goes through
    const c2: ProjectConfig = (await b.call('daemonConfigGet', { key: 'widget' })).config;
    expect((await b.call('daemonConfigSet', { key: 'widget', rev: c2.rev, values: { MAX_CONCURRENT_WORKERS: '2' } })).result).toBe('saved');
    expect(readFileSync(config, 'utf8')).toContain('# edited elsewhere\n');
  });

  it('what the window may not name is refused before the script\'s save ever starts', async () => {
    // the save is the only thing that takes a lock: a wrapper in front of flock records every start
    const calls = join(w.dir, 'flock-calls');
    wrapTool(path, 'flock', `echo x >> ${JSON.stringify(calls)}\nexec "$REAL" "$@"`);
    const b = backend();
    const before = readFileSync(config, 'utf8');
    const c: ProjectConfig = (await b.call('daemonConfigGet', { key: 'widget' })).config;
    const set = (o: Record<string, unknown>) => b.call('daemonConfigSet', { key: 'widget', rev: c.rev, values: { MAX_CONCURRENT_WORKERS: '2' }, ...o });
    const refused: Record<string, unknown>[] = [
      { key: '../x' },
      { key: 'deploy' },
      { rev: 'abc' },
      { rev: `${c.rev}; rm -rf x` },
      { values: {} },
      { values: { GH_TOKEN: 'x' } },
      { values: { WORKTREE_SETUP_CMD: 'true' } },
      { values: { PR_CREATED_HOOK: 'x' } },
      { values: { DISPATCH_MODE: 'greedy' } },
      { values: { LABEL_AUTOPILOT: 'autopilot' } },
      { values: { MAX_CONCURRENT_WORKERS: '2', NOT_A_SETTING: '1' } },
      { values: { 'MAX_CONCURRENT_WORKERS=2\nGH_TOKEN': 'x' } },
      { values: { WORKER_MODEL: 'a b' } },
      { values: { WORKER_MODEL: '$(id)' } },
      { values: { WORKER_MODEL: 'a"\nGH_TOKEN="x' } },
      { values: { MAX_CONCURRENT_WORKERS: 2 } },
    ];
    for (const o of refused) expect((await set(o)).result, JSON.stringify(o)).toBe('refused');
    expect(existsSync(calls)).toBe(false);
    expect(readFileSync(config, 'utf8')).toBe(before);
    // a value of plain characters that the type does not allow reaches the script, which says "invalid"
    const r = await set({ values: { MAX_CONCURRENT_WORKERS: '99' } });
    expect(r.result).toBe('invalid');
    expect(readFileSync(config, 'utf8')).toBe(before);
    // reachable: the wrapper does see a save, and this one is written
    expect((await set({})).result).toBe('saved');
    expect(readFileSync(calls, 'utf8').trim().split('\n').length).toBe(2);
    expect(line('MAX_CONCURRENT_WORKERS')).toEqual(['MAX_CONCURRENT_WORKERS=2']);
  });

  // 17 values × (read + save) through the real script, one after another: 16 s on CI with the
  // default 20 s budget (main run 43150760693), so any extra load on the runner tipped it over
  // (PR #400 review round 5). The work is the point of the test; give it the time, keep every value.
  it('one list of values, three checks — the form, the back end, the script — agree on which may be written', async () => {
    const b = backend();
    const values = ['', 'opus-5.5', 'vendor/model:1@x', 'a,b+c', 'a b', 'a"b', "a'b", '$HOME', '`id`', 'a\\b', 'a;b', 'a\nb', 'a=b', 'a#b', '-x', '中', 'x'.repeat(81)];
    const verdicts: [string, boolean, string][] = [];
    for (const v of values) {
      const c: ProjectConfig = (await b.call('daemonConfigGet', { key: 'widget' })).config;
      const model = byName(c, 'WORKER_MODEL');
      const form = fieldProblem(model, v) === null;
      const r = await b.call('daemonConfigSet', { key: 'widget', rev: c.rev, values: { WORKER_MODEL: v } });
      verdicts.push([v, form, r.result]);
      // written exactly when the form would have let it through (the same value twice is "unchanged")
      expect(['saved', 'unchanged'].includes(r.result), `${JSON.stringify(v)} → ${r.result}`).toBe(form);
      if (form) expect(line('WORKER_MODEL')).toEqual([`WORKER_MODEL="${v}"`]);
    }
    // both kinds really occurred, and a refusal never came back as anything but "nothing written"
    expect(verdicts.filter((x) => x[1]).map((x) => x[0])).toEqual(['', 'opus-5.5', 'vendor/model:1@x']);
    expect(new Set(verdicts.filter((x) => !x[1]).map((x) => x[2]))).toEqual(new Set(['refused', 'invalid']));
    // 17 values × (read + save through the real script): ~17 s on a loaded dev box, past the 20 s default on CI (PR #415)
  }, 60_000);

  it('a config that does not load: "unreadable" with no values; an unknown project: "not_found"', async () => {
    const b = backend();
    writeFileSync(config, readFileSync(config, 'utf8') + 'if then fi (\n');
    const r = await b.call('daemonConfigGet', { key: 'widget' });
    expect(r.result).toBe('unreadable');
    expect(r.config).toBeUndefined();
    expect((await b.call('daemonConfigGet', { key: 'nope' })).result).toBe('not_found');
    expect((await b.call('daemonConfigGet', { key: '../x' })).result).toBe('refused');
  });

  it('a daemon without the config script: "unsupported", and a save is refused', async () => {
    rmSync(join(w.skill, 'scripts', 'project-config.sh'));
    const b = backend();
    const r = await b.call('daemonConfigGet', { key: 'widget' });
    expect(r.result).toBe('unsupported');
    expect(r.output).toContain('更新 daemon');
    expect((await b.call('daemonConfigSet', { key: 'widget', rev: 'a'.repeat(64), values: { MAX_CONCURRENT_WORKERS: '2' } })).result).toBe('refused');
  });

  it('a save cut off before its verdict is "unconfirmed" — not "saved", not one of the "nothing written" words', async () => {
    const b = backend();
    const c: ProjectConfig = (await b.call('daemonConfigGet', { key: 'widget' })).config;
    // the swap itself dies: the script ends without its RESULT line
    wrapTool(path, 'mv', 'kill -9 $PPID');
    const r = await b.call('daemonConfigSet', { key: 'widget', rev: c.rev, values: { MAX_CONCURRENT_WORKERS: '2' } });
    expect(r.result).toBe('unconfirmed');
    expect(saveKind(r.result)).toBe('unknown');
    // the backup of the pre-save version was already made
    expect(readdirSync(join(w.home, '.local', 'state', 'cavil-loop', 'widget', 'config-backups')).length).toBe(1);
  });
});
