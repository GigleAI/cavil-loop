// GitHub#577: the release scripts decide "am I being run, not imported?" by comparing their own URL
// with the path they were started with. Written as `file://${process.argv[1]}` that never matched on
// Windows (`D:\a\…` against `file:///D:/a/…`) — nor anywhere when the path has a space: the script then
// did nothing at all and exited 0, so the Windows build stamped no version, verified no signature and
// measured no size while every step looked green. Two checks:
//   1. no script under scripts/ uses that form any more
//   2. each one, copied to a folder whose name has a space, really runs (a refusal it must give comes out)

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scripts = join(root, 'scripts');

function run(file: string, args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(process.execPath, [file, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('release scripts run when started from any path (GitHub#577)', () => {
  it('no script compares its URL with a hand-made file:// + path', () => {
    const bad = readdirSync(scripts)
      .filter((f) => f.endsWith('.mjs'))
      .filter((f) => /file:\/\/\$\{process\.argv\[1\]\}/.test(readFileSync(join(scripts, f), 'utf8')));
    expect(bad).toEqual([]);
  });

  it('started from a folder with a space in its name, each one does its work and gives its refusal', () => {
    const dir = join(tempDir(), 'a folder', 'scripts');
    mkdirSync(dir, { recursive: true });
    for (const f of ['size-gate.mjs', 'update-manifest.mjs', 'release-version.mjs', 'dev-version.mjs', 'dev-release.mjs', 'dev-plan.mjs']) cpSync(join(scripts, f), join(dir, f));
    // size gate: a file that is not there fails (never "small enough")
    const size = run(join(dir, 'size-gate.mjs'), [join(dir, 'missing.exe')]);
    expect(size).toMatchObject({ code: 1 });
    expect(size.out).toMatch(/量不到/);
    // the manifest builder: an unknown channel is refused
    const plat = run(join(dir, 'update-manifest.mjs'), ['--print-platforms', 'nightly']);
    expect(plat).toMatchObject({ code: 1 });
    expect(plat.out).toMatch(/不认识的渠道/);
    expect(JSON.parse(run(join(dir, 'update-manifest.mjs'), ['--print-platforms', 'dev']).out)).toContain('windows-x86_64');
    // --verify of a package with no signature: refused, not silently "fine"
    writeFileSync(join(dir, 'p.exe'), 'x');
    writeFileSync(join(dir, 'p.exe.sig'), 'not a signature');
    expect(run(join(dir, 'update-manifest.mjs'), ['--verify', join(dir, 'p.exe'), join(dir, 'p.exe.sig'), '--conf', join(root, 'src-tauri', 'tauri.conf.json')]).code).toBe(1);
    // the two version scripts: started with no usable input they refuse instead of printing nothing
    expect(run(join(dir, 'release-version.mjs'), ['write', 'not-a-version', '--root', join(dir, 'nowhere')]).code).not.toBe(0);
    expect(run(join(dir, 'dev-version.mjs'), ['--root', join(dir, 'nowhere')]).code).not.toBe(0);
    expect(run(join(dir, 'dev-release.mjs'), ['--version', 'nope']).code).not.toBe(0);
    // the nightly "anything new?" check: no full commit, refused, and says why (GitHub#628)
    const plan = run(join(dir, 'dev-plan.mjs'), ['--sha', 'nope']);
    expect(plan.code).not.toBe(0);
    expect(plan.out).toMatch(/不是完整的提交号/);
  });
});
