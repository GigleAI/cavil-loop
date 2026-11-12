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
import { harnessBin } from '../support/harness';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let driver: string;
/** the Electron build (client 0.2, the last one before the Rust back end), straight from git */
let electronDriver: string;
/** the same, but with the controller of the last preview build before the trust list */
let legacyDriver: string;
const ELECTRON_REV = '76dd682';
const LEGACY_REV = '1dc8219';

/** Export the client sources of `rev` into a temp dir (CI checks out full history for this). */
function exportRev(rev: string): string {
  const out = tempDir();
  // inside a negative-control sandbox (not a git checkout) the runner points at the real repository
  const repo = process.env.CLIENT_MUT_REPO ?? root;
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim();
  const tar = execFileSync('git', ['archive', '--format=tar', rev, 'client/src', 'client/test/drivers'], { cwd: top, maxBuffer: 64 << 20 });
  const r = spawnSync('tar', ['-x', '-C', out], { input: tar });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  return join(out, 'client');
}

beforeAll(async () => {
  driver = join(tempDir(), 'signout-crash.mjs');
  await build({ entryPoints: [join(root, 'test/drivers/signout-crash.ts')], outfile: driver, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  // the old builds wrote their profile with their own code: run exactly that code
  const old = exportRev(ELECTRON_REV);
  electronDriver = join(tempDir(), 'signout-crash-electron.mjs');
  await build({ entryPoints: [join(old, 'test/drivers/signout-crash.ts')], outfile: electronDriver, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  const repo = process.env.CLIENT_MUT_REPO ?? root;
  const oldController = execFileSync('git', ['show', `${LEGACY_REV}:client/src/main/controller.ts`], { cwd: repo, encoding: 'utf8' });
  legacyDriver = join(tempDir(), 'signout-crash-legacy.mjs');
  const controllerPath = join(old, 'src/main/controller.ts');
  await build({
    entryPoints: [join(old, 'test/drivers/signout-crash.ts')],
    outfile: legacyDriver,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    plugins: [
      {
        name: 'legacy-controller',
        setup(b) {
          b.onLoad({ filter: /src[\\/]main[\\/]controller\.ts$/ }, (args) =>
            args.path === controllerPath ? { contents: oldController, loader: 'ts', resolveDir: dirname(controllerPath) } : undefined,
          );
        },
      },
    ],
  });
  if (!readFileSync(legacyDriver, 'utf8').includes('pendingCredentialDelete')) throw new Error('legacy bundle does not contain the old controller');
  if (readFileSync(electronDriver, 'utf8').includes('pendingCredentialDelete')) throw new Error('electron bundle should be the 0.2 controller');
  // two `git archive` exports and three esbuild bundles: ~7 s on an idle box, already most of vitest's
  // default 10 s hook limit — a loaded box timed it out and skipped all 11 cases (GitHub#413 code review round 1)
}, 60_000);

/** One phase in its own process: the current client (Rust back end), the Electron build ('electron') or the preview build before the trust list ('legacy'). */
function phase(dir: string, scenario: string, build: 'current' | 'electron' | 'legacy' | true = 'current') {
  const which = build === true ? 'legacy' : build;
  const r = spawnSync(process.execPath, [which === 'legacy' ? legacyDriver : which === 'electron' ? electronDriver : driver, dir, scenario], {
    encoding: 'utf8',
    timeout: 60_000,
    // the bundled driver cannot find the back end relative to itself: tell it
    env: { ...process.env, LEGACY: which === 'legacy' ? '1' : '', CAVIL_HARNESS: harnessBin() },
  });
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

  // ---- upgrade from the last preview build (review 2026-11-05 20:12) ----
  it('old build signed out but could not delete the credential (it promised never to reuse it) → new build does not sign back in', () => {
    const dir = tempDir();
    const one = phase(dir, 'logout-delete-fails', true);
    expect(one.phase).toBe('login');
    expect(one.stored).toBe(OLD); // the old build really left it on disk
    const two = phase(dir, 'restart');
    expect(two.phase).toBe('login');
    expect(two.auths).toEqual([]);
    expect(two.stored).toBeNull();
    // starting again changes nothing
    expect(phase(dir, 'restart')).toMatchObject({ phase: 'login', auths: [] });
  });

  it('old build simply signed in → the new build asks for one new sign-in (it cannot prove that credential was not signed out of)', () => {
    const dir = tempDir();
    expect(phase(dir, 'signed-in', true).phase).toBe('ready');
    const two = phase(dir, 'restart');
    expect(two.phase).toBe('login');
    expect(two.auths).toEqual([]);
  });

  // ---- upgrade from the Electron build (client 0.2) to the Rust back end (GitHub#151) ----
  it('Electron build signed in → the new build starts signed in with the same credential (same keychain entry, same files)', () => {
    const dir = tempDir();
    expect(phase(dir, 'signed-in', 'electron').phase).toBe('ready');
    const two = phase(dir, 'restart');
    expect(two.phase).toBe('ready');
    expect(two.stored).toBe(OLD);
    expect(two.auths.length).toBeGreaterThan(0);
    expect(two.auths.every((a) => a === `Bearer ${OLD}`)).toBe(true);
  });

  it('Electron build signed out but could not delete the credential → the new build does not sign back in', () => {
    const dir = tempDir();
    const one = phase(dir, 'logout-delete-fails', 'electron');
    expect(one.stored).toBe(OLD);
    const two = phase(dir, 'restart');
    expect(two).toMatchObject({ phase: 'login', auths: [], stored: null });
  });

  it('after the upgrade, a new sign-in sticks: restart signs in with it (the old build\'s leftover mark does not get in the way)', () => {
    const dir = tempDir();
    phase(dir, 'logout-delete-fails', true);
    expect(phase(dir, 'restart').phase).toBe('login');
    const login = phase(dir, 'login');
    expect(login).toMatchObject({ phase: 'ready', stored: NEW });
    const again = phase(dir, 'restart');
    expect(again.phase).toBe('ready');
    expect(again.auths.every((a) => a === `Bearer ${NEW}`)).toBe(true);
    expect(again.auths.length).toBeGreaterThan(0);
  });
});

