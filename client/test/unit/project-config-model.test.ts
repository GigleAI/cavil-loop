// A project's "配置" (GitHub#388): the value checks, text values — one case per request, each through the real
// back end and the daemon's real scripts/project-config.sh on a fresh copy of the machine. In files of
// their own (GitHub#649: refused / model / integers) so they run side by side with test/unit/project-config.test.ts.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wrapTool } from '../support/daemon-world';
import { configWorld } from '../support/config-world';
import { fieldProblem, type ProjectConfig } from '../../src/shared/daemon';

describe('the back end and the daemon\'s real script: which values may be written (text values)', () => {
  const cw = configWorld();
  const backend = () => cw.backend();
  const line = (name: string) => cw.line(name);
  const byName = (c: ProjectConfig, name: string) => cw.byName(c, name);

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
});
