// A project's "配置" (GitHub#388). Two halves:
//   - the pure rules the dialog draws from (shared/daemon.ts);
//   - the real back end (Rust, child process) running the daemon's real
//     scripts/project-config.sh in a fake HOME, on a project the real setup.sh
//     connected. Results are read back from the config file on disk, not from
//     the back end's word.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { connect, daemonEnv, daemonWorld, dropWorlds, installByHand, pathFor, wrapTool, type DaemonWorld, type Os, restoreWorld, snapshotWorld } from '../support/daemon-world';
import { canEdit, configGroups, configLayout, draftChanges, fieldProblem, saveKind, saveWord, valueText, type ConfigField, type ProjectConfig } from '../../src/shared/daemon';
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
    // GitHub#555: the bound is the using code's own, compared digit by digit — not a 9-digit cap, never through a Number
    const big = field({ type: 'int', min: 0, max: '18446744073709551615' });
    expect(['0', '999999999', '1000000000', '9007199254740993', '18446744073709551615'].map((v) => fieldProblem(big, v))).toEqual([null, null, null, null, null]);
    for (const v of ['18446744073709551616', '99999999999999999999', '01']) expect(fieldProblem(big, v), v).not.toBeNull();
    // a number past 2^53 compared exactly: 9007199254740993 is over a 9007199254740992 bound (as Numbers they are equal)
    expect(fieldProblem(field({ type: 'int', min: 0, max: '9007199254740992' }), '9007199254740993')).not.toBeNull();
    // no upper bound in the code: any whole number from the minimum on, up to the 200 characters every value may have
    const open = field({ type: 'int', min: 1, max: null });
    expect([fieldProblem(open, '1'), fieldProblem(open, '1' + '0'.repeat(199))]).toEqual([null, null]);
    expect(fieldProblem(open, '1' + '0'.repeat(200))).not.toBeNull();
    expect(fieldProblem(open, '0')).toBe('只能是不小于 1 的整数');
    // GitHub#556: an integer the daemon marks `empty` may also be left blank; one without it may not
    const blank = field({ type: 'int', min: 1, max: 65535, empty: true });
    expect(['', '1', '65535'].map((v) => fieldProblem(blank, v))).toEqual([null, null, null]);
    expect(fieldProblem(blank, '0')).toBe('只能是 1 到 65535 之间的整数，或者留空');
    for (const v of ['65536', ' ', '01']) expect(fieldProblem(blank, v), v).not.toBeNull();
    expect(fieldProblem(field({ type: 'int', min: 1, max: 65535 }), '')).toBe('只能是 1 到 65535 之间的整数');
  });

  it('only what the daemon calls editable, of a type the client knows, is an input', () => {
    expect(canEdit(field({}))).toBe(true);
    expect(canEdit(field({ editable: false }))).toBe(false);
    expect(canEdit(field({ mode: 'show' }))).toBe(false);
    expect(canEdit(field({ type: 'label' }))).toBe(false);
    expect(canEdit(field({ type: 'text' }))).toBe(false);
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
    // a plain value (GitHub#555: flow labels, label lists, a branch) reads as written — a flow label is a name, not a switch
    expect(valueText(field({ type: 'text' }), 'doing/agent')).toBe('doing/agent');
    expect(valueText(field({ type: 'text' }), 'priority/p0,priority/p1')).toBe('priority/p0,priority/p1');
    expect(valueText(field({ type: 'text' }), '')).toBe('（空）');
    // an option whose value is empty (GitHub#554: "off" written as an empty line): its label alone
    expect(valueText(field({ type: 'enum', options: [{ value: '', label: '关' }, { value: 'block', label: '拦住' }] }), '')).toBe('关');
    expect(valueText(field({ type: 'enum', options: [{ value: '', label: '关' }, { value: 'block', label: '拦住' }] }), 'block')).toBe('拦住（block）');
    // a switch whose "off" is an empty value
    expect(valueText(field({ type: 'bool', on: 'on', off: '' }), '')).toBe('关');
    expect(fieldProblem(field({ type: 'bool', on: 'on', off: '' }), '')).toBeNull();
    expect(fieldProblem(field({ type: 'bool', on: 'on', off: '' }), 'yes')).not.toBeNull();
    const g = configGroups([field({ name: 'A', group: 'one' }), field({ name: 'B', group: 'two' }), field({ name: 'C', group: 'one' })]);
    expect(g.map((x) => [x.title, x.fields.map((f) => f.name)])).toEqual([['one', ['A', 'C']], ['two', ['B']]]);
  });

  it('GitHub#591: main fields shown, more fields folded in their group, all-advanced groups in the 高级设置 block; nothing hidden on a guess', () => {
    const fs = [
      field({ name: 'A', group: 'one', tier: 'main' }),
      field({ name: 'B', group: 'one', tier: 'more' }),
      field({ name: 'C', group: 'two', tier: 'advanced' }),
      field({ name: 'D', group: 'one', tier: 'main' }),
      field({ name: 'E', group: 'two', tier: 'advanced' }),
      field({ name: 'F', group: 'three', tier: 'main' }),
    ];
    const l = configLayout(fs);
    expect(l.tiered).toBe(true);
    expect(l.common.map((g) => [g.title, g.main.map((f) => f.name), g.more.map((f) => f.name)])).toEqual([['one', ['A', 'D'], ['B']], ['three', ['F'], []]]);
    expect(l.advanced.map((g) => [g.title, g.fields.map((f) => f.name)])).toEqual([['two', ['C', 'E']]]);
    // every field lands in exactly one place
    const placed = [...l.common.flatMap((g) => [...g.main, ...g.more]), ...l.advanced.flatMap((g) => g.fields)].map((f) => f.name).sort();
    expect(placed).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    // a daemon from before the field: everything at once, in its groups, as before
    const old = configLayout([field({ name: 'A', group: 'one' }), field({ name: 'B', group: 'two' })]);
    expect([old.tiered, old.common.map((g) => [g.title, g.main.map((f) => f.name), g.more.length]), old.advanced]).toEqual([false, [['one', ['A'], 0], ['two', ['B'], 0]], []]);
    // a word the client does not know is shown, never folded away; a group with one advanced and one main field stays common
    const odd = configLayout([field({ name: 'A', group: 'one', tier: 'someday' }), field({ name: 'B', group: 'one', tier: 'advanced' }), field({ name: 'C', group: 'one', tier: 'main' })]);
    expect(odd.common.map((g) => [g.main.map((f) => f.name), g.more.map((f) => f.name)])).toEqual([[['A', 'C'], ['B']]]);
    expect(odd.advanced).toEqual([]);
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

  // GitHub#649: the machine, the daemon cloned and a project connected with the real setup.sh, built
  // once for this block with its own time limit; every case gets a fresh copy of it
  let snap: string;
  beforeAll(() => {
    w = daemonWorld(tempDir());
    installByHand(w);
    path = pathFor(w);
    host = connect(w, 'widget', 'Darwin', path);
    config = join(host, 'cavil-loop.config');
    snap = snapshotWorld(w);
  }, 120_000);
  beforeEach(() => {
    restoreWorld(w, snap);
  }, 30_000);
  afterEach(async () => {
    await Promise.all(open.splice(0).map((b) => b.close()));
  });
  // the machine and its copy go when the block is done (~2300 files, GitHub#469)
  afterAll(() => {
    dropWorlds();
  }, 60_000);
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

  // GitHub#649: two cases of one read and one save each (they were one case of four script runs)
  it('a file edited since it was read: "changed", and the outside edit stays', async () => {
    const b = backend();
    const c: ProjectConfig = (await b.call('daemonConfigGet', { key: 'widget' })).config;
    writeFileSync(config, readFileSync(config, 'utf8') + '# edited elsewhere\n');
    const after = readFileSync(config, 'utf8');
    const r = await b.call('daemonConfigSet', { key: 'widget', rev: c.rev, values: { MAX_CONCURRENT_WORKERS: '2' } });
    expect(r.result).toBe('changed');
    expect(readFileSync(config, 'utf8')).toBe(after);
  });
  it('…reachable: the same save with the fingerprint of the file as it is now goes through, the outside edit kept', async () => {
    const b = backend();
    writeFileSync(config, readFileSync(config, 'utf8') + '# edited elsewhere\n');
    const c2: ProjectConfig = (await b.call('daemonConfigGet', { key: 'widget' })).config;
    expect((await b.call('daemonConfigSet', { key: 'widget', rev: c2.rev, values: { MAX_CONCURRENT_WORKERS: '2' } })).result).toBe('saved');
    expect(readFileSync(config, 'utf8')).toContain('# edited elsewhere\n');
    expect(line('MAX_CONCURRENT_WORKERS')).toEqual(['MAX_CONCURRENT_WORKERS=2']);
  });

  // GitHub#649: one case per request (each on a fresh copy of the machine), so no case holds tens of
  // calls through the real back end under one time limit
  /** a back end, the config's text before, and `set` sending one save for that config's current rev */
  async function saving() {
    // the save is the only thing that takes a lock: a wrapper in front of flock records every start
    const calls = join(w.dir, 'flock-calls');
    wrapTool(path, 'flock', `echo x >> ${JSON.stringify(calls)}\nexec "$REAL" "$@"`);
    const b = backend();
    const before = readFileSync(config, 'utf8');
    const c: ProjectConfig = (await b.call('daemonConfigGet', { key: 'widget' })).config;
    const set = (o: Record<string, unknown>) => b.call('daemonConfigSet', { key: 'widget', rev: c.rev, values: { MAX_CONCURRENT_WORKERS: '2' }, ...o });
    return { calls, before, c, set };
  }
  const REFUSED: [string, (rev: string) => Record<string, unknown>][] = [
    ['key ../x', () => ({ key: '../x' })],
    ['key deploy', () => ({ key: 'deploy' })],
    ['rev abc', () => ({ rev: 'abc' })],
    ['rev with a command after it', (rev) => ({ rev: `${rev}; rm -rf x` })],
    ['no values', () => ({ values: {} })],
    ['GH_TOKEN', () => ({ values: { GH_TOKEN: 'x' } })],
    ['WORKTREE_SETUP_CMD', () => ({ values: { WORKTREE_SETUP_CMD: 'true' } })],
    ['PR_CREATED_HOOK', () => ({ values: { PR_CREATED_HOOK: 'x' } })],
    ['DISPATCH_MODE', () => ({ values: { DISPATCH_MODE: 'greedy' } })],
    ['LABEL_AUTOPILOT', () => ({ values: { LABEL_AUTOPILOT: 'autopilot' } })],
    ['a setting that does not exist next to a real one', () => ({ values: { MAX_CONCURRENT_WORKERS: '2', NOT_A_SETTING: '1' } })],
    ['a name with a line break', () => ({ values: { 'MAX_CONCURRENT_WORKERS=2\nGH_TOKEN': 'x' } })],
    ['WORKER_MODEL with a blank', () => ({ values: { WORKER_MODEL: 'a b' } })],
    ['WORKER_MODEL with $( )', () => ({ values: { WORKER_MODEL: '$(id)' } })],
    ['WORKER_MODEL with a quote and a line break', () => ({ values: { WORKER_MODEL: 'a"\nGH_TOKEN="x' } })],
    ['a number, not text', () => ({ values: { MAX_CONCURRENT_WORKERS: 2 } })],
  ];
  it.each(REFUSED)('what the window may not name is refused before the script\'s save ever starts: %s', async (_name, req) => {
    const { calls, before, c, set } = await saving();
    const o = req(c.rev);
    expect((await set(o)).result, JSON.stringify(o)).toBe('refused');
    expect(existsSync(calls)).toBe(false);
    expect(readFileSync(config, 'utf8')).toBe(before);
  });
  it('…while a value of plain characters the type does not allow reaches the script ("invalid"), and a good one is saved', async () => {
    const { calls, before, set } = await saving();
    const r = await set({ values: { MAX_CONCURRENT_WORKERS: '99' } });
    expect(r.result).toBe('invalid');
    expect(readFileSync(config, 'utf8')).toBe(before);
    // reachable: the wrapper does see a save, and this one is written
    expect((await set({})).result).toBe('saved');
    expect(readFileSync(calls, 'utf8').trim().split('\n').length).toBe(2);
    expect(line('MAX_CONCURRENT_WORKERS')).toEqual(['MAX_CONCURRENT_WORKERS=2']);
  });

  // GitHub#649: one case per value (each is one read and one save through the real script, on a fresh
  // copy of the machine), so no case holds tens of script runs under one time limit
  const MODEL_VALUES = ['', 'opus-5.5', 'vendor/model:1@x', 'a,b+c', 'a b', 'a"b', "a'b", '$HOME', '`id`', 'a\\b', 'a;b', 'a\nb', 'a=b', 'a#b', '-x', '中', 'x'.repeat(81)];
  const modelVerdicts: [string, boolean, string][] = [];
  it.each(MODEL_VALUES.map((v) => [JSON.stringify(v), v]))('one value, three checks — the form, the back end, the script — agree whether it may be written: %s', async (_name, v) => {
    const b = backend();
    const c: ProjectConfig = (await b.call('daemonConfigGet', { key: 'widget' })).config;
    const model = byName(c, 'WORKER_MODEL');
    const form = fieldProblem(model, v) === null;
    const r = await b.call('daemonConfigSet', { key: 'widget', rev: c.rev, values: { WORKER_MODEL: v } });
    modelVerdicts.push([v, form, r.result]);
    // written exactly when the form would have let it through (the value already there is "unchanged")
    expect(['saved', 'unchanged'].includes(r.result), `${JSON.stringify(v)} → ${r.result}`).toBe(form);
    if (form) expect(line('WORKER_MODEL')).toEqual([`WORKER_MODEL="${v}"`]);
  });
  it('…and across those values both kinds occurred; a refusal never came back as anything but "nothing written"', () => {
    expect(modelVerdicts).toHaveLength(MODEL_VALUES.length);
    expect(modelVerdicts.filter((x) => x[1]).map((x) => x[0])).toEqual(['', 'opus-5.5', 'vendor/model:1@x']);
    expect(new Set(modelVerdicts.filter((x) => !x[1]).map((x) => x[2]))).toEqual(new Set(['refused', 'invalid']));
  });

  // GitHub#555: whole numbers past 9 digits, up to the using code's own bound, go through the form, the back end and the
  // script alike; one past the bound, or a leading zero, through none of them. GitHub#649: one case per value.
  const INTEGER_CASES: [string, string, boolean][] = [
    ['GREEDY_SCAN_LIMIT', '1000000000', true], ['GREEDY_SCAN_LIMIT', '18446744073709551616', true],
    ['GREEDY_SCAN_LIMIT', '0', true], ['GREEDY_SCAN_LIMIT', '0100', false], ['GREEDY_SCAN_LIMIT', '100', true],
    ['AUTOPILOT_CHECKS_TIMEOUT_HOURS', '2562047788015215', true], ['AUTOPILOT_CHECKS_TIMEOUT_HOURS', '2562047788015216', false],
    ['CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS', '1' + '0'.repeat(60), true], ['CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS', '0', false],
    // GitHub#556: the one integer that may be left blank, and one that may not
    ['PREVIEW_PORT_MODULO', '1000', true], ['PREVIEW_PORT_MODULO', '', true], ['PREVIEW_PORT_MODULO', '0', false], ['PREVIEW_PORT_MODULO', '1000000000', true],
    ['PREVIEW_PORT_MODULO', '3074457345618258603', true], ['PREVIEW_PORT_MODULO', '9223372036854775808', false],
    ['PREVIEW_BACKEND_OFFSET', '', false],
  ];
  it.each(INTEGER_CASES.map(([n, v, ok]) => [`${n}=${v.length > 24 ? `${v.slice(0, 4)}…(${v.length} digits)` : v}`, n, v, ok] as const))(
    'integers: the form, the back end and the script agree up to the using code\'s own bound: %s',
    async (_label, name, v, ok) => {
      const b = backend();
      const c: ProjectConfig = (await b.call('daemonConfigGet', { key: 'widget' })).config;
      const f = byName(c, name);
      expect(f.editable, `${name} editable before ${v}`).toBe(true);
      const form = fieldProblem(f, v) === null;
      expect(form, `${name}=${v}: the form`).toBe(ok);
      const r = await b.call('daemonConfigSet', { key: 'widget', rev: c.rev, values: { [name]: v } });
      expect(['saved', 'unchanged'].includes(r.result), `${name}=${v} → ${r.result}`).toBe(ok);
      if (ok) expect(line(name).map((l) => l.replace(/"/g, ''))).toEqual([`${name}=${v}`]);
    },
  );

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
