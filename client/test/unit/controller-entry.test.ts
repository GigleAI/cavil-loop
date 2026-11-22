// GitHub#649: every test builds its controller through test/support/controller.ts, so the client's
// read retries never sleep in a test by accident. A source check — the one place this rule is read
// from the code instead of from behaviour (test/unit/connection-retry.test.ts checks the behaviour).
// A file that must build it another way goes into ALLOWED with the reason.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** files allowed to build a controller themselves, each with why */
const ALLOWED: Record<string, string> = {
  'test/support/controller.ts': 'the shared function itself',
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? (e === 'node_modules' ? [] : files(p)) : /\.(ts|mts|mjs|js)$/.test(e) ? [p] : [];
  });
}

describe('building a controller in tests', () => {
  it('goes through the shared function everywhere (exceptions listed with a reason)', () => {
    const all = files(join(root, 'test'));
    const direct = all
      .map((f) => relative(root, f))
      .filter((f) => f !== 'test/unit/controller-entry.test.ts')
      .filter((f) => /\bController\.create\(|\bnew Controller\(/.test(readFileSync(join(root, f), 'utf8')));
    expect(direct.filter((f) => !(f in ALLOWED))).toEqual([]);
    // the rule is reachable: the shared function is found by the same scan
    expect(direct).toContain('test/support/controller.ts');
    // and the tests do use it
    expect(all.filter((f) => readFileSync(f, 'utf8').includes('createController(')).length).toBeGreaterThan(20);
  });
});
