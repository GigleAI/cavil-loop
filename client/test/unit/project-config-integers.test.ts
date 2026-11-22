// A project's "配置" (GitHub#388): the value checks, whole numbers — one case per request, each through the real
// back end and the daemon's real scripts/project-config.sh on a fresh copy of the machine. In files of
// their own (GitHub#649: refused / model / integers) so they run side by side with test/unit/project-config.test.ts.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wrapTool } from '../support/daemon-world';
import { configWorld } from '../support/config-world';
import { fieldProblem, type ProjectConfig } from '../../src/shared/daemon';

describe('the back end and the daemon\'s real script: which values may be written (whole numbers)', () => {
  const cw = configWorld();
  const backend = () => cw.backend();
  const line = (name: string) => cw.line(name);
  const byName = (c: ProjectConfig, name: string) => cw.byName(c, name);

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
});
