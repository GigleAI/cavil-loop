// The app quits at an arbitrary point of a sign-out / sign-in / refresh (a
// keychain call still outstanding), then starts again on the same files.
// Two real Node processes per case (test/drivers/signout-crash.ts, bundled):
// the second one shares nothing with the first but the disk.

import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let driver: string;

beforeAll(async () => {
  driver = join(tempDir(), 'signout-crash.mjs');
  await build({ entryPoints: [join(root, 'test/drivers/signout-crash.ts')], outfile: driver, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
});

function phase(dir: string, scenario: string) {
  const r = spawnSync(process.execPath, [driver, dir, scenario], { encoding: 'utf8', timeout: 60_000 });
  const line = `${r.stdout}`.split('\n').find((l) => l.startsWith(scenario === 'restart' ? 'PHASE2 ' : 'PHASE1 '));
  if (r.status !== 0 || !line) throw new Error(`driver ${scenario} failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(7)) as { phase: string; stored: string | null; auths: string[]; reason: string | null };
}

const OLD = 'ghu_oldtoken0000000000000000000000000001';
const NEW = 'ghu_newtoken0000000000000000000000000001';

describe('quit at any point, start again: never back into an account the user signed out of', () => {
  for (const scenario of ['logout-delete-pending', 'logout-delete-queued', 'logout-delete-fails', 'logout-delete-ok']) {
    it(`sign-out, ${scenario.replace('logout-', '')}, quit → restart stays on the login page and sends nothing`, () => {
      const dir = tempDir();
      const one = phase(dir, scenario);
      expect(one.phase).toBe('login'); // the first process already showed the sign-out
      if (scenario !== 'logout-delete-ok') expect(one.stored).toBe(OLD); // "something did happen": the old credential really is still on disk
      const two = phase(dir, 'restart');
      expect(two.phase).toBe('login');
      expect(two.auths).toEqual([]); // the leftover was never sent to GitHub
      expect(two.stored).toBeNull(); // and the restart removed it
    });
  }

  it('a new sign-in quits while its keychain write has not returned → restart does not trust the half-done login', () => {
    const dir = tempDir();
    const one = phase(dir, 'login-write-pending');
    expect(one.stored).toBe(NEW); // the write did land on disk
    const two = phase(dir, 'restart');
    expect(two.phase).toBe('login');
    expect(two.auths).toEqual([]);
  });

  it('a refresh quits while writing the new token → restart keeps going with the new token (no new sign-in needed)', () => {
    const dir = tempDir();
    const one = phase(dir, 'refresh-write-pending');
    expect(one.stored).toBe(NEW);
    const two = phase(dir, 'restart');
    expect(two.phase).toBe('ready');
    expect(two.auths.length).toBeGreaterThan(0);
    expect(two.auths.every((a) => a === `Bearer ${NEW}`)).toBe(true);
  });
});
