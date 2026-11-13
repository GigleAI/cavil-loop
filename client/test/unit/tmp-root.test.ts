// Each test run's own temporary folder (GitHub#469: scripts/with-tmp.mjs, test/support/tmp-root.mjs,
// the vitest / Playwright hooks). Everything here runs the real launcher, the real perl lock and the
// real vitest hook as child processes against a temp dir of its own (it plays the system temp dir),
// and checks what is left in it afterwards with the one leftover rule — names starting with `cavil-`.
//
// The cases follow a run's whole life: passed / failed / stopped by a signal; only the launcher
// killed while a process it started in a session of its own (the way the negative-control runner
// starts tests) still writes in the folder; two runs reaping the same leftover at once; a run stopped
// between "lock file made" and "locked" while another reaps; a state that cannot be judged; a framework
// started without the launcher. Where a folder must be kept, the case also shows its user really was
// alive and writing in it.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MASTER, leftovers } from '../support/tmp-root.mjs';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAUNCHER = join(root, 'scripts', 'with-tmp.mjs');
const VITEST = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const LEAKY_CONFIG = join(root, 'test', 'fixtures', 'tmp-root', 'vitest.config.ts');

/** a shell single-quoted word */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The environment of a run started from outside any run, with `sys` as the system temp dir. */
function outside(sys: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: sys, ...extra };
  for (const k of ['CAVIL_TMP_ROOT', 'CAVIL_TMP_SYSTEM', 'CAVIL_TMP_TEST_PAUSE', 'CI']) if (!(k in extra)) delete env[k];
  // the leaky suite must not build the Rust back end (its hook skips the build when this is set)
  env.CAVIL_HARNESS = '/bin/true';
  return env;
}

interface Run {
  child: ChildProcess;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>;
}
const started: ChildProcess[] = [];
afterEach(() => {
  for (const c of started.splice(0)) if (c.exitCode === null && c.signalCode === null && c.pid) try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ }
});

/** The launcher running `bash -c script` (in a process group of its own, so a case can kill it all). */
function launch(sys: string, script: string, extra: Record<string, string> = {}, env?: NodeJS.ProcessEnv): Run {
  const child = spawn(process.execPath, [LAUNCHER, 'bash', '-c', script], { env: env ?? outside(sys, extra), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  started.push(child);
  let out = '';
  child.stdout!.on('data', (d) => (out += String(d)));
  child.stderr!.on('data', (d) => (out += String(d)));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>((r) => child.on('exit', (code, signal) => setTimeout(() => r({ code, signal, out }), 20)));
  return { child, done };
}

const world = () => {
  const d = tempDir();
  const sys = join(d, 'sys');
  mkdirSync(sys);
  return { d, sys };
};
/** Only the machine-wide lock is left: no `cavil-` entry, no run folder. */
const onlyLock = (sys: string) => {
  expect(leftovers(sys)).toEqual([]);
  expect(readdirSync(sys)).toEqual([MASTER]);
};
const runDirs = (sys: string) => readdirSync(sys).filter((n) => n.startsWith('cavil-client-'));

/** A run whose folder nobody holds any more (launcher and command killed): a leftover for the next run. */
async function leftover(sys: string, d: string): Promise<string> {
  const mark = join(d, `left-${Math.random()}`);
  const r = launch(sys, `echo "$TMPDIR" > ${JSON.stringify(mark)}; mkdir "$TMPDIR/cavil-client-test-x"; touch "$TMPDIR/cavil-client-test-x/f"; exec sleep 60`);
  await until('the run to start', () => existsSync(mark) && readFileSync(mark, 'utf8').endsWith('\n'));
  process.kill(-r.child.pid!, 'SIGKILL');
  await r.done;
  const dir = readFileSync(mark, 'utf8').trim();
  expect(existsSync(dir)).toBe(true);
  return dir;
}

describe('a test run in its own temp folder (GitHub#469)', () => {
  it('a suite that leaks, through the launcher: its tests ran in the run folder, and afterwards only the machine-wide lock is left — the same one each time', async () => {
    const { d, sys } = world();
    const out = join(d, 'leaky.json');
    const once = async () => {
      const r = launch(sys, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(VITEST)} run --config ${JSON.stringify(LEAKY_CONFIG)}`, { LEAKY_OUT: out });
      const res = await r.done;
      expect(res.code, res.out).toBe(0);
      const got = JSON.parse(readFileSync(out, 'utf8'));
      // vitest's worker saw the launcher's folder (the hook did not make a second one)
      expect(got.tmpdir).toMatch(new RegExp(`^${sys}/cavil-client-run-[0-9a-f]{12}$`));
      expect(got.made.startsWith(`${got.tmpdir}/cavil-client-test-`)).toBe(true);
      onlyLock(sys);
      return statSync(join(sys, MASTER)).ino;
    };
    const first = await once();
    expect(await once()).toBe(first);
    expect(statSync(join(sys, MASTER)).size).toBe(0);
  }, 60_000);

  it('a failing suite: exit code passed on, nothing left', async () => {
    const { d, sys } = world();
    const r = launch(sys, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(VITEST)} run --config ${JSON.stringify(LEAKY_CONFIG)}`, { LEAKY_OUT: join(d, 'o.json'), LEAKY_FAIL: '1' });
    const res = await r.done;
    expect(res.code).toBe(1);
    expect(JSON.parse(readFileSync(join(d, 'o.json'), 'utf8')).made).toContain('/cavil-client-run-');
    onlyLock(sys);
    // and a plain exit code
    const r2 = launch(sys, 'mkdir "$TMPDIR/cavil-x"; exit 7');
    expect((await r2.done).code).toBe(7);
    onlyLock(sys);
  }, 60_000);

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    it(`stopped by ${sig}: passed on to the command, waited for, cleaned up`, async () => {
      const { d, sys } = world();
      const mark = join(d, 'm');
      const r = launch(sys, `d=$(mktemp -d); touch "$d/f"; echo "$d" > ${JSON.stringify(mark)}; exec sleep 60`);
      await until('the command to start', () => existsSync(mark) && readFileSync(mark, 'utf8').endsWith('\n'));
      expect(existsSync(readFileSync(mark, 'utf8').trim())).toBe(true);
      process.kill(r.child.pid!, sig);
      const res = await r.done;
      expect(res.code).toBe(sig === 'SIGINT' ? 130 : 143);
      onlyLock(sys);
    }, 30_000);
  }

  it('only the launcher killed, a process in a session of its own still writing: the folder stays while it lives, the next run after it ended removes it', async () => {
    const { d, sys } = world();
    const mark = join(d, 'm');
    const stop = join(d, 'stop');
    // the command starts a writer the way the negative-control runner starts tests (detached: own session)
    const writer = `require('child_process').spawn('sh', ['-c', 'echo $$ > "$0.pid"; while [ ! -e "$1" ]; do date +%s%N > "$TMPDIR/w"; sleep 0.05; done', process.argv[1], process.argv[2]], { detached: true, stdio: 'ignore' }).unref()`;
    const r = launch(sys, `${sq(process.execPath)} -e ${sq(writer)} ${JSON.stringify(mark)} ${JSON.stringify(stop)}; echo "$$ $TMPDIR" > ${JSON.stringify(mark)}; exec sleep 60`);
    await until('the writer', () => existsSync(`${mark}.pid`) && existsSync(mark) && readFileSync(mark, 'utf8').endsWith('\n'));
    const [cmdPid, dir] = readFileSync(mark, 'utf8').trim().split(' ');
    const writerPid = Number(readFileSync(`${mark}.pid`, 'utf8'));
    // kill the launcher and its command; the writer is left
    process.kill(r.child.pid!, 'SIGKILL');
    process.kill(Number(cmdPid), 'SIGKILL');
    await r.done;
    expect(alive(writerPid)).toBe(true);
    // a second run: the folder is in use, kept; the writer really is still writing in it
    const second = launch(sys, 'true');
    const res2 = await second.done;
    expect(res2.code, res2.out).toBe(0);
    expect(existsSync(dir)).toBe(true);
    const before = readFileSync(join(dir, 'w'), 'utf8');
    await until('the writer to write again', () => readFileSync(join(dir, 'w'), 'utf8') !== before);
    // the writer ends; a third run removes the folder
    writeFileSync(stop, '');
    await until('the writer to end', () => !alive(writerPid));
    const third = launch(sys, 'true');
    expect((await third.done).code).toBe(0);
    onlyLock(sys);
  }, 60_000);

  it('the same, with the session process already gone: the very next run removes the folder (the lock is released)', async () => {
    const { d, sys } = world();
    const mark = join(d, 'm');
    const writer = `require('child_process').spawn('sh', ['-c', 'echo $$ > "$0.pid"; date > "$TMPDIR/w"', process.argv[1]], { detached: true, stdio: 'ignore' }).unref()`;
    const r = launch(sys, `${sq(process.execPath)} -e ${sq(writer)} ${JSON.stringify(mark)}; echo "$$ $TMPDIR" > ${JSON.stringify(mark)}; exec sleep 60`);
    await until('the writer', () => existsSync(`${mark}.pid`) && existsSync(mark) && readFileSync(mark, 'utf8').endsWith('\n'));
    const [cmdPid, dir] = readFileSync(mark, 'utf8').trim().split(' ');
    await until('the writer to end', () => !alive(Number(readFileSync(`${mark}.pid`, 'utf8'))) && existsSync(join(dir, 'w')));
    process.kill(r.child.pid!, 'SIGKILL');
    process.kill(Number(cmdPid), 'SIGKILL');
    await r.done;
    expect(existsSync(dir)).toBe(true);
    expect((await launch(sys, 'true').done).code).toBe(0);
    onlyLock(sys);
  }, 30_000);

  it('two runs reaping one leftover at the same time: both end normally, the leftover is gone', async () => {
    const { d, sys } = world();
    const dir = await leftover(sys, d);
    const [a, b] = [launch(sys, 'true'), launch(sys, 'true')];
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect([ra.code, rb.code], ra.out + rb.out).toEqual([0, 0]);
    expect(ra.out + rb.out).not.toContain('判断不了');
    expect(existsSync(dir)).toBe(false);
    onlyLock(sys);
  }, 30_000);

  it('a run stopped between "lock file made" and "locked": another run waits on the machine-wide lock, does not touch that folder, both end normally', async () => {
    const { d, sys } = world();
    const pause = join(d, 'pause');
    const bDone = join(d, 'b-done');
    const a = launch(sys, `touch "$TMPDIR/mine"; while [ ! -e ${JSON.stringify(bDone)} ]; do sleep 0.05; done; test -f "$TMPDIR/mine"`, { CAVIL_TMP_TEST_PAUSE: pause });
    await until('the first run to reach the pause', () => existsSync(`${pause}.reached`));
    expect(runDirs(sys)).toEqual([expect.stringMatching(/^cavil-client-new-/)]);
    const b = launch(sys, 'true');
    // b is held on the machine-wide lock: still running, a's half-made folder untouched
    await sleep(800);
    expect(b.child.exitCode).toBe(null);
    expect(runDirs(sys)).toEqual([expect.stringMatching(/^cavil-client-new-/)]);
    writeFileSync(`${pause}.go`, '');
    const rb = await b.done;
    expect(rb.code, rb.out).toBe(0);
    // a published and kept its folder through b's reaping
    expect(runDirs(sys)).toEqual([expect.stringMatching(/^cavil-client-run-/)]);
    writeFileSync(bDone, '');
    const ra = await a.done;
    expect(ra.code, ra.out).toBe(0);
    onlyLock(sys);
  }, 30_000);

  it('a run killed at that same moment: the next run removes its half-made folder', async () => {
    const { d, sys } = world();
    const pause = join(d, 'pause');
    const a = launch(sys, 'true', { CAVIL_TMP_TEST_PAUSE: pause });
    await until('the run to reach the pause', () => existsSync(`${pause}.reached`));
    process.kill(-a.child.pid!, 'SIGKILL');
    await a.done;
    expect(runDirs(sys)).toEqual([expect.stringMatching(/^cavil-client-new-/)]);
    expect((await launch(sys, 'true').done).code).toBe(0);
    onlyLock(sys);
  }, 30_000);

  it('cannot judge (the lock file cannot be opened; no perl): nothing removed; once it can, the next run removes it', async () => {
    const { d, sys } = world();
    const dir = await leftover(sys, d);
    chmodSync(join(dir, '.lock'), 0o000);
    const r = await launch(sys, 'true').done;
    expect(r.code).toBe(0);
    expect(r.out).toContain('判断不了');
    expect(existsSync(join(dir, 'cavil-client-test-x', 'f'))).toBe(true);
    chmodSync(join(dir, '.lock'), 0o600);
    // no perl at all: the launcher refuses to start, the leftover stays
    const bin = join(d, 'bin');
    mkdirSync(bin);
    for (const t of ['bash', 'sh']) symlinkSync(spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim(), join(bin, t));
    const ran = join(d, 'ran');
    const np = await launch(sys, `touch ${JSON.stringify(ran)}`, {}, { ...outside(sys), PATH: bin }).done;
    expect(np.code).toBe(70);
    expect(np.out).toContain('perl');
    expect(existsSync(ran)).toBe(false);
    expect(existsSync(join(dir, 'cavil-client-test-x', 'f'))).toBe(true);
    // back to normal
    expect((await launch(sys, 'true').done).code).toBe(0);
    onlyLock(sys);
  }, 30_000);

  it('vitest started without the launcher: its own hook makes the folder, the workers use it, it is removed at the end', async () => {
    const { d, sys } = world();
    const out = join(d, 'leaky.json');
    const r = spawnSync(process.execPath, [VITEST, 'run', '--config', LEAKY_CONFIG], { env: outside(sys, { LEAKY_OUT: out }), encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const got = JSON.parse(readFileSync(out, 'utf8'));
    expect(got.tmpdir).toMatch(new RegExp(`^${sys}/cavil-client-run-[0-9a-f]{12}$`));
    onlyLock(sys);
  }, 60_000);

  it('with CI set, a `cavil-` entry left in the system temp dir fails the run; a clean run passes', async () => {
    const { sys } = world();
    const dirty = await launch(sys, 'mkdir "$CAVIL_TMP_SYSTEM/cavil-e2e-leak"', { CI: 'true' }).done;
    expect(dirty.code).not.toBe(0);
    expect(dirty.out).toContain('cavil-e2e-leak');
    const { sys: sys2 } = world();
    const clean = await launch(sys2, 'mkdir "$TMPDIR/cavil-e2e-x"', { CI: 'true' }).done;
    expect(clean.code, clean.out).toBe(0);
    onlyLock(sys2);
  }, 30_000);

  it("the README's count (find … -name 'cavil-*') and the launcher's check agree", () => {
    const { sys } = world();
    writeFileSync(join(sys, MASTER), '');
    mkdirSync(join(sys, 'cavil-client-test-a'));
    mkdirSync(join(sys, 'cavil-e2e-daemon-b', 'inner'), { recursive: true });
    writeFileSync(join(sys, 'cavil-file'), '');
    mkdirSync(join(sys, 'xcavil-c'));
    mkdirSync(join(sys, '.cavil-hidden'));
    const found = spawnSync('sh', ['-c', `find "$1" -maxdepth 1 -name 'cavil-*'`, '_', sys], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((p) => p.slice(sys.length + 1)).sort();
    expect(found).toEqual(['cavil-client-test-a', 'cavil-e2e-daemon-b', 'cavil-file']);
    expect(leftovers(sys)).toEqual(found);
  });

  it("the README's clean-up of older versions' folders, run as written in a bare environment: removes only old folders nobody has open", async () => {
    const { d, sys } = world();
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const block = /<!-- tmp-cleanup-ops:begin -->\n```bash\n([\s\S]*?)\n```\n<!-- tmp-cleanup-ops:end -->/.exec(readme);
    expect(block, 'the clean-up block in client/README.md').not.toBeNull();
    const hoursAgo = (p: string, h: number) => utimesSync(p, new Date(Date.now() - h * 3600_000), new Date(Date.now() - h * 3600_000));
    const mk = (name: string, h: number) => {
      mkdirSync(join(sys, name, 'inner'), { recursive: true });
      writeFileSync(join(sys, name, 'inner', 'f'), '');
      hoursAgo(join(sys, name), h);
    };
    mk('cavil-client-test-old', 3);
    mk('cavil-driver-old', 5);
    mk('cavil-e2e-daemon-open', 3);
    mk('cavil-client-test-recent', 0);
    mk('cavil-client-run-0123456789ab', 3);
    mk('other-old', 3);
    writeFileSync(join(sys, MASTER), '');
    // a process with a file open in one of the old folders (its working directory)
    const holder = spawn('sleep', ['60'], { cwd: join(sys, 'cavil-e2e-daemon-open', 'inner'), stdio: 'ignore' });
    started.push(holder);
    await until('the holder', () => holder.pid !== undefined);
    await sleep(100);
    const home = join(d, 'home');
    mkdirSync(home);
    const r = spawnSync('bash', ['-c', block![1]], { env: { HOME: home, PATH: process.env.PATH!, LANG: process.env.LANG ?? 'C.UTF-8', TMPDIR: sys }, encoding: 'utf8', maxBuffer: 64 << 20 });
    holder.kill('SIGKILL');
    expect(r.status, `${r.error ?? r.signal ?? ''} ${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).not.toContain('停下');
    const lines = r.stdout.trim().split('\n');
    // step 2 counted the two it was going to remove, step 4 counted what is left
    expect(lines).toContain('2');
    expect(lines[lines.length - 1].trim()).toBe('3');
    expect(readdirSync(sys).sort()).toEqual([MASTER, 'cavil-client-run-0123456789ab', 'cavil-client-test-recent', 'cavil-e2e-daemon-open', 'other-old'].sort());
    expect(existsSync(join(sys, 'cavil-e2e-daemon-open', 'inner', 'f'))).toBe(true);
    expect(readdirSync(home)).toEqual([]);
  }, 30_000);

  it('a command started inside a run starts no second folder', async () => {
    const { d, sys } = world();
    const mark = join(d, 'm');
    const r = await launch(sys, `${JSON.stringify(process.execPath)} ${JSON.stringify(LAUNCHER)} sh -c 'echo "$TMPDIR" > ${mark}; ls -d "$CAVIL_TMP_SYSTEM"/cavil-client-* | wc -l >> ${mark}'`).done;
    expect(r.code, r.out).toBe(0);
    const [inner, count] = readFileSync(mark, 'utf8').trim().split('\n');
    expect(inner).toMatch(/\/cavil-client-run-[0-9a-f]{12}$/);
    expect(count.trim()).toBe('1');
    onlyLock(sys);
  }, 30_000);
});
