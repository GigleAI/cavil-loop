// A project's "配置" (GitHub#388): the value checks, requests the window may not send — one case per request, each through the real
// back end and the daemon's real scripts/project-config.sh on a fresh copy of the machine. In files of
// their own (GitHub#649: refused / model / integers) so they run side by side with test/unit/project-config.test.ts.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wrapTool } from '../support/daemon-world';
import { configWorld } from '../support/config-world';
import { fieldProblem, type ProjectConfig } from '../../src/shared/daemon';

describe('the back end and the daemon\'s real script: which values may be written (requests the window may not send)', () => {
  const cw = configWorld();
  const backend = () => cw.backend();
  const line = (name: string) => cw.line(name);
  const byName = (c: ProjectConfig, name: string) => cw.byName(c, name);


  // GitHub#649: one case per request (each on a fresh copy of the machine), so no case holds tens of
  // calls through the real back end under one time limit
  /** a back end, the config's text before, and `set` sending one save for that config's current rev */
  async function saving() {
    // the save is the only thing that takes a lock: a wrapper in front of flock records every start
    const calls = join(cw.w.dir, 'flock-calls');
    wrapTool(cw.path, 'flock', `echo x >> ${JSON.stringify(calls)}\nexec "$REAL" "$@"`);
    const b = backend();
    const before = readFileSync(cw.config, 'utf8');
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
    expect(readFileSync(cw.config, 'utf8')).toBe(before);
  });
  it('…while a value of plain characters the type does not allow reaches the script ("invalid"), and a good one is saved', async () => {
    const { calls, before, set } = await saving();
    const r = await set({ values: { MAX_CONCURRENT_WORKERS: '99' } });
    expect(r.result).toBe('invalid');
    expect(readFileSync(cw.config, 'utf8')).toBe(before);
    // reachable: the wrapper does see a save, and this one is written
    expect((await set({})).result).toBe('saved');
    expect(readFileSync(calls, 'utf8').trim().split('\n').length).toBe(2);
    expect(line('MAX_CONCURRENT_WORKERS')).toEqual(['MAX_CONCURRENT_WORKERS=2']);
  });
});
