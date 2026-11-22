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
import { wrapTool, type DaemonWorld, type Os } from '../support/daemon-world';
import { configWorld } from '../support/config-world';
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
  // GitHub#649: the machine, built once for this block, a fresh copy per case (test/support/config-world.ts)
  const cw = configWorld();
  const backend = (os?: Os, p?: string) => cw.backend(os, p);
  const line = (name: string) => cw.line(name);
  const byName = (c: ProjectConfig, name: string) => cw.byName(c, name);
  let w: DaemonWorld;
  let path: string;
  let config: string;
  beforeEach(() => {
    ({ w, path, config } = cw);
  });

  it('reads the settings of a project the real setup.sh connected: values from its config, nothing secret', async () => {
    const r = await backend().call('daemonConfigGet', { key: 'widget' });
    expect(r.result).toBe('ok');
    const c: ProjectConfig = r.config;
    expect(c.config).toBe(config);
    expect(byName(c, 'WORKER_AGENT')).toMatchObject({ value: 'claude', in_file: true, editable: true, type: 'agent' });
    expect(byName(c, 'MAX_CONCURRENT_WORKERS')).toMatchObject({ value: '1', editable: true, min: 1, max: 16 });
    expect(byName(c, 'DISPATCH_MODE')).toMatchObject({ mode: 'show', value: 'label', editable: false });
    // every registered setting is in the template setup.sh writes, as a plain literal: all "edit" rows are inputs
    expect(c.fields.filter((f) => f.mode === 'edit' && !f.editable).map((f) => `${f.name}: ${f.reason}`)).toEqual([]);
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
