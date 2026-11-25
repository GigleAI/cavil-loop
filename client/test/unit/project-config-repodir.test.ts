// A project's "配置": the report directory of the post-merge retrospective (GitHub#688), the one setting of type
// `repodir` — a directory inside the project's repository. Every value of tests/fixtures/repodir-cases.txt (the list
// the retrospective and scripts/project-config.sh are checked against too, tests/retrospective-report-dir.test.sh) goes
// through the form's check and through the real back end and the daemon's real scripts/project-config.sh; all three
// must say what the list says. One case per value (GitHub#649), each on a fresh copy of the machine.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configWorld } from '../support/config-world';
import { canEdit, fieldProblem, type ProjectConfig } from '../../src/shared/daemon';

const CASES = readFileSync(join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'repodir-cases.txt'), 'utf8')
  .split('\n')
  .filter((l) => l !== '' && !l.startsWith('#'))
  .map((l) => {
    const at = l.indexOf('|');
    return [l.slice(0, at) === 'ok', l.slice(at + 1)] as const;
  });
const NAME = 'RETROSPECTIVE_REPORT_DIR';

describe('the retrospective report directory: the form, the back end and the script agree with the shared list', () => {
  const cw = configWorld();

  it('the list has both kinds, and the field is shown as an editable directory with its default', async () => {
    expect(new Set(CASES.map((c) => c[0]))).toEqual(new Set([true, false]));
    const c: ProjectConfig = (await cw.backend().call('daemonConfigGet', { key: 'widget' })).config;
    const f = cw.byName(c, NAME);
    expect([f.type, f.mode, f.value, canEdit(f)]).toEqual(['repodir', 'edit', 'docs/retrospectives', true]);
  });

  const seen: [string, boolean, string][] = [];
  it.each(CASES.map(([ok, v]) => [JSON.stringify(v), ok, v] as const))('%s', async (_name, ok, v) => {
    const b = cw.backend();
    const c: ProjectConfig = (await b.call('daemonConfigGet', { key: 'widget' })).config;
    const f = cw.byName(c, NAME);
    const form = fieldProblem(f, v) === null;
    const r = await b.call('daemonConfigSet', { key: 'widget', rev: c.rev, values: { [NAME]: v } });
    seen.push([v, form, r.result]);
    expect(form, `form on ${JSON.stringify(v)}`).toBe(ok);
    // written exactly when the list says so (the value already there comes back "unchanged")
    expect(['saved', 'unchanged'].includes(r.result), `${JSON.stringify(v)} → ${r.result}`).toBe(ok);
    if (r.result === 'saved') expect(cw.line(NAME)).toEqual([`${NAME}="${v}"`]);
  });

  it('…every value ran, and a refusal never came back as anything but "nothing written"', () => {
    expect(seen).toHaveLength(CASES.length);
    expect(new Set(seen.filter((x) => !x[1]).map((x) => x[2]))).toEqual(new Set(['refused', 'invalid']));
  });
});
