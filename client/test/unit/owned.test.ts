// GitHub#649: owned.mjs — the one way the negative-control runner and its tests start processes.
// Real processes throughout: the program is the head of a new group, the test owns its cleanup.
// The runner cases use the real run.mjs worker with a stand-in `cargo` first on PATH (it starts a
// grandchild and writes both pids down), so "nothing is left" is checked pid by pid.

import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';
import { waitUntil } from '../support/wait';
import { account, owned, prewarmBackend, runRunner } from '../support/owned-run';
// @ts-expect-error: plain JavaScript module
import { CLEANUP_BUDGET_MS, CacheGuard, TimeAccount, runOwned } from '../mutation/owned.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = join(root, 'test/mutation/run.mjs');
const runSh = join(root, 'test/mutation/run.sh');

/** these cases read /proc and use setsid: Linux only (CI runs them there) */
const NOT_LINUX = process.platform !== 'linux';
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
const pidsIn = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : []);
const sh = (dir: string, name: string, body: string) => {
  const f = join(dir, name);
  writeFileSync(f, `#!/bin/bash\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
};
const did = (r: { events: { what: string }[] }, what: string) => r.events.some((e) => e.what === what);

// processes a case may leave for the next one to check are stopped when the file ends
const leftovers: number[] = [];
afterAll(() => {
  for (const p of leftovers) if (alive(p)) process.kill(p, 'SIGKILL');
});

describe.skipIf(process.env.CLIENT_MUT_CHILD === '1' || NOT_LINUX)('owned: one group, cleaned up by its owner', () => {
  it('a program that ends with nothing left: done at once — no grace period, no signal', async () => {
    const r = await owned([process.execPath, '-e', 'console.log("hi")'], { settle: 'command', ownMs: 10_000 });
    expect(r.status).toBe('exited');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hi\n');
    // the first look at the group already found it empty
    expect(r.events.find((e) => e.what === 'probe')?.state).toBe('gone');
    expect(did(r, 'grace-start')).toBe(false);
    expect(r.events.filter((e) => e.what === 'signal')).toEqual([]);
    // for the record only (not a pass mark): how long the cleanup took
    const exited = r.events.find((e) => e.what === 'program-exited')!.at;
    const removed = r.events.find((e) => e.what === 'folder-removed')!.at;
    console.log(`正常结束到收尾完成：${removed - exited} ms`);
  });

  it('a descendant still holding the output: stopped with the group, the output is read to its end', async () => {
    const dir = tempDir();
    const pids = join(dir, 'pids');
    // the program starts a grandchild that inherits its output and sleeps, then exits itself
    const prog = sh(dir, 'prog', `sleep 300 & echo $! >> "${pids}"; echo started; exit 0`);
    const r = await owned([prog], { settle: 'command', ownMs: 30_000 });
    expect(r.status).toBe('exited');
    expect(r.stdout).toBe('started\n');
    expect(did(r, 'grace-start')).toBe(true);
    expect(pidsIn(pids)).toHaveLength(1);
    for (const p of pidsIn(pids)) expect(alive(p), `pid ${p}`).toBe(false);
  });

  it('the folder is still there when the group is told to stop, and gone once the call returns; products are read first', async () => {
    const dir = tempDir();
    const seen = join(dir, 'seen');
    // ignores SIGTERM (so the cleanup has to go on to SIGKILL), and notes whether its folder is still there then
    const prog = sh(dir, 'prog', `echo product > "$CLIENT_MUT_OWNED_WORK/out.txt"\ntrap '[ -d "$CLIENT_MUT_OWNED_WORK" ] && echo there > "${seen}"' TERM\nwhile :; do sleep 0.1; done`);
    let rootSeen = '';
    const r = await owned((work) => ((rootSeen = dirname(work)), [prog]), { settle: 'command', keep: ['out.txt'], ownMs: 30_000 });
    await waitUntil(() => existsSync(seen), 'the program noted its folder');
    expect(readFileSync(seen, 'utf8').trim()).toBe('there');
    expect(r.status).toBe('timeout');
    expect(r.events.filter((e) => e.what === 'signal').map((e) => e.sig)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(String(r.products['out.txt'])).toBe('product\n');
    const order = r.events.map((e) => e.what);
    expect(order.indexOf('products-read')).toBeLessThan(order.indexOf('folder-removed'));
    expect(order.indexOf('group-empty')).toBeLessThan(order.indexOf('products-read'));
    expect(existsSync(rootSeen)).toBe(false);
  }, 30_000);

  // the call's own limit is what makes it stop here: keep it short
  it('a call over its limit, then a cleanup that cannot confirm the group is gone: a bounded failure, the folder kept, the cache not reused', async () => {
    const dir = tempDir();
    const prog = sh(dir, 'prog', 'sleep 300');
    const guard = new CacheGuard();
    const t0 = Date.now();
    // the probe is the one step replaced: the group never reads as gone
    const r = await runOwned([prog], { settle: 'command', timeoutMs: 300, probe: () => 'there', grace: 200, confirm: 300, drain: 200 });
    guard.note(r);
    expect(r.status).toBe('cleanup-failed');
    expect(r.diag).toContain('未能确认退出');
    expect(Date.now() - t0).toBeLessThan(300 + 200 + 300 + 2_000);
    expect(r.root).not.toBeNull();
    expect(existsSync(r.root)).toBe(true);
    expect(() => guard.check()).toThrow('上一场景收尾未确认，不复用编译缓存');
    // the real group did get both signals (the sleep is gone even though the probe said otherwise)
    expect(r.events.filter((e: { what: string }) => e.what === 'signal').map((e: { sig: string }) => e.sig)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('a process outside the group holding the output: a bounded failure, nothing passed on, the folder kept', async () => {
    const dir = tempDir();
    const pids = join(dir, 'pids');
    // the grandchild makes a group of its own (setsid) and keeps the output; it exits by itself after
    // 6 s. The program waits until it has left the group (it writes its pid from the new session)
    const prog = sh(dir, 'prog', `setsid bash -c 'echo $$ >> "${pids}"; exec sleep 6' &\nwhile [ ! -s "${pids}" ]; do sleep 0.05; done\necho partial; exit 0`);
    const t0 = Date.now();
    // straight to runOwned: this failure is the point here, it must not mark the file's build cache as unusable
    const r = await runOwned([prog], { settle: 'command', timeoutMs: account().limitFor(30_000)! });
    const took = Date.now() - t0;
    leftovers.push(...pidsIn(pids));
    expect(r.status).toBe('cleanup-failed');
    expect(r.diag).toContain('输出没能确认读完');
    expect(r.stdout).toBe('');
    expect(did(r, 'group-empty')).toBe(true);
    expect(did(r, 'drain-timeout')).toBe(true);
    expect(took).toBeLessThan(5_000);
    expect(existsSync(r.root!)).toBe(true);
  });

  it('the time account: a call fits only with its cleanup time left over', () => {
    let now = 0;
    const a = new TimeAccount(60_000, { now: () => now, minCallMs: 1_000 });
    expect(a.limitFor(120_000)).toBe(60_000 - CLEANUP_BUDGET_MS);
    now = 60_000 - (CLEANUP_BUDGET_MS + 1_000);
    expect(a.limitFor(120_000)).toBe(1_000);
    now += 1;
    expect(a.limitFor(120_000)).toBeNull();
    expect(a.given).toEqual([60_000 - CLEANUP_BUDGET_MS, 1_000]);
  });
});

/** A stand-in for cargo, first on PATH: it starts a grandchild, writes both pids down, then does `mode`. */
function fakeCargo(mode: 'hold-pipe' | 'kill-parent' | 'sleep') {
  const dir = tempDir();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const pids = join(dir, 'pids');
  const lines = {
    // the grandchild keeps cargo's stderr (the worker's pipe) open; cargo itself is done
    'hold-pipe': `sleep 300 & echo $! >> "${pids}"; echo $$ >> "${pids}"; exit 0`,
    // the very first thing it does is kill the worker that started it (the gap the old design had)
    'kill-parent': `kill -9 $PPID; sleep 300 & echo $! >> "${pids}"; echo $$ >> "${pids}"; exec sleep 300`,
    sleep: `sleep 300 & echo $! >> "${pids}"; echo $$ >> "${pids}"; exec sleep 300`,
  }[mode];
  sh(bin, 'cargo', lines);
  return { pids, env: { PATH: `${bin}:${process.env.PATH}` } };
}

const STORE_ENTRY = {
  what: '缓存不覆盖旧快照',
  file: 'src-tauri/crates/core/src/store.rs',
  from: 'ON CONFLICT(source_key) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data',
  to: 'ON CONFLICT(source_key) DO NOTHING',
  expect: ['each successful round replaces the cached snapshot as a whole'],
};
/** one cargo target dir for every case of the next block: the stand-ins and, last, a real build share it */
let sharedTarget = '';
function buildingEntry(extra: Record<string, string>) {
  const dir = tempDir();
  sharedTarget ||= join(tempDir(), 'target');
  const list = join(dir, 'list.json');
  writeFileSync(list, JSON.stringify([STORE_ENTRY]));
  const state = join(dir, 'state');
  mkdirSync(state);
  writeFileSync(join(state, 'unit-tests.json'), JSON.stringify([{ name: 'cache each successful round replaces the cached snapshot as a whole', file: 'test/unit/controller.test.ts' }]));
  // this file's own cargo target dir (never the suite's): shared by every case below, so the last one
  // shows a real build still runs in it after each way a build was cut short
  return { CLIENT_MUT_LIST: list, CLIENT_MUT_STATE: state, CLIENT_MUT_CARGO_TARGET: sharedTarget, ...extra };
}

describe.skipIf(process.env.CLIENT_MUT_CHILD === '1' || NOT_LINUX)('owned: the runner, its build cut short in every way', () => {
  it('a descendant holds the output and the step runs out of time: "timed out: building", nothing left', async () => {
    const c = fakeCargo('hold-pipe');
    const t0 = Date.now();
    const r = await runRunner(runner, ['--one', '0'], buildingEntry({ ...c.env, CLIENT_MUT_TIMEOUT_MS: '3000' }), 60_000);
    expect(r.owned.status).toBe('step-timeout');
    expect(r.owned.result?.step).toBe('编译后台');
    expect(r.out).toContain('超时');
    expect(Date.now() - t0).toBeLessThan(3_000 + CLEANUP_BUDGET_MS + 15_000);
    expect(pidsIn(c.pids)).toHaveLength(2);
    for (const p of pidsIn(c.pids)) expect(alive(p), `pid ${p}`).toBe(false);
  }, 60_000);

  it('the worker is killed the moment the build starts: the group is still cleaned up', async () => {
    const c = fakeCargo('kill-parent');
    const r = await runRunner(runner, ['--one', '0'], buildingEntry(c.env), 60_000);
    expect(r.owned.status).toBe('no-result');
    expect(r.status).toBe(1);
    await waitUntil(() => pidsIn(c.pids).length === 2, 'the stand-in wrote its pids');
    for (const p of pidsIn(c.pids)) expect(alive(p), `pid ${p}`).toBe(false);
  }, 60_000);

  it('the worker is killed from outside mid-build: the group is still cleaned up', async () => {
    const c = fakeCargo('sleep');
    const p = runRunner(runner, ['--one', '0'], buildingEntry(c.env), 60_000);
    await waitUntil(() => pidsIn(c.pids).length === 2, 'the build started');
    // the worker is the group's head: its pid is the group id, the parent of the stand-in
    const worker = Number(readFileSync(`/proc/${pidsIn(c.pids)[1]}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
    process.kill(worker, 'SIGKILL');
    const r = await p;
    expect(r.owned.status).toBe('no-result');
    for (const q of pidsIn(c.pids)) expect(alive(q), `pid ${q}`).toBe(false);
  }, 60_000);

  it('the owner gives up (cancelled): "cancelled", nothing left', async () => {
    const c = fakeCargo('sleep');
    const ac = new AbortController();
    const limit = account().limitFor(60_000)!;
    const p = runOwned([process.execPath, runner, '--one', '0'], { settle: 'runner', env: { ...buildingEntry(c.env), CLIENT_MUT_WORKER: '1' }, timeoutMs: limit, signal: ac.signal, cwd: process.cwd() });
    await waitUntil(() => pidsIn(c.pids).length === 2, 'the build started');
    ac.abort();
    const r = await p;
    expect(r.status).toBe('cancelled');
    for (const q of pidsIn(c.pids)) expect(alive(q), `pid ${q}`).toBe(false);
  }, 60_000);

  it('the warm-up build is cancelled: "准备失败：编后台", nothing left', async () => {
    const c = fakeCargo('sleep');
    const ac = new AbortController();
    const p = prewarmBackend(root, { timeoutMs: account().limitFor(60_000)!, signal: ac.signal, env: { ...c.env, CLIENT_MUT_CARGO_TARGET: join(tempDir(), 'target') } }).then(
      () => null,
      (e) => e as Error,
    );
    await waitUntil(() => pidsIn(c.pids).length === 2, 'the warm-up started');
    ac.abort();
    const e = await p;
    expect(e?.message).toContain('准备失败：编后台');
    for (const q of pidsIn(c.pids)) expect(alive(q), `pid ${q}`).toBe(false);
  }, 60_000);

  it('the nightly entry gets SIGTERM mid-build: it fails, its worker\'s group is gone, the folder is removed', async () => {
    const c = fakeCargo('sleep');
    const p = owned([process.execPath, runner, '--one', '0'], { settle: 'command', env: buildingEntry(c.env), cwd: process.cwd(), ownMs: 60_000 });
    await waitUntil(() => pidsIn(c.pids).length === 2, 'the build started');
    const stand = pidsIn(c.pids)[1];
    const worker = Number(readFileSync(`/proc/${stand}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
    const entry = Number(readFileSync(`/proc/${worker}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
    const workerRoot = readFileSync(`/proc/${worker}/environ`, 'utf8').split('\0').find((x) => x.startsWith('CLIENT_MUT_OWNED_ROOT='))!.split('=')[1];
    process.kill(entry, 'SIGTERM');
    const r = await p;
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('已取消');
    for (const q of [...pidsIn(c.pids), worker]) expect(alive(q), `pid ${q}`).toBe(false);
    expect(existsSync(workerRoot)).toBe(false);
  }, 60_000);
});

/** A stand-in worker for run.sh's calls: answers each step as `plan` says and writes every start to `log`. */
function fakeWorker(plan: Record<string, 'ok' | 'fail' | 'hold'>) {
  const dir = tempDir();
  const log = join(dir, 'log');
  const seen = join(dir, 'seen');
  const known = JSON.stringify({ ok: true, files: ['client/src/a.ts'], outside: [] });
  const w = join(dir, 'worker.mjs');
  writeFileSync(
    w,
    `import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [cmd, ...args] = process.argv.slice(2);
const key = cmd === '--one' ? '--one ' + args[0] : cmd;
appendFileSync(${JSON.stringify(log)}, key + '\\n');
const plan = ${JSON.stringify(plan)};
const how = plan[key] ?? 'ok';
const done = (code) => { writeFileSync(process.env.CLIENT_MUT_OWNED_RESULT, JSON.stringify({ outcome: 'done', exitCode: code })); process.exitCode = code; };
if (how === 'hold') {
  // a grandchild in a session of its own keeps the output open for 6 s; wait until it has left the group
  const ready = ${JSON.stringify(dir)} + '/held-' + process.pid;
  // unref: this stand-in exits right away, as a worker would, leaving the grandchild behind
  spawn('setsid', ['bash', '-c', 'echo $$ > "$1"; exec sleep 6', '_', ready], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();
  while (!existsSync(ready) || !readFileSync(ready, 'utf8').trim()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  console.log('3'); done(0);
}
else if (how === 'fail') { console.log('第 ' + (args[0] ?? '') + ' 项的失败原因：没变红'); done(1); }
else {
  if (cmd === '--count') console.log('3');
  else if (cmd === '--changes') console.log(${JSON.stringify(known)});
  else if (cmd === '--select') {
    if (args[0] === '--all') console.log('0 1 2');
    else {
      const f = process.env.CLIENT_MUT_STATE + '/changes.json';
      const got = existsSync(f) ? readFileSync(f, 'utf8') : '';
      writeFileSync(${JSON.stringify(seen)}, got);
      console.log(got.trim() === ${JSON.stringify(known)} ? '1' : '0 1 2');
    }
  } else if (cmd === '--one') console.log('✅ 变红：第 ' + args[0] + ' 项');
  done(0);
}
`,
  );
  return { log, seen, known, env: { CLIENT_MUT_WORKER_CMD: JSON.stringify([process.execPath, w]) } };
}
const started = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
async function nightly(args: string[], env: Record<string, string>) {
  return owned(['/bin/bash', runSh, ...args], { settle: 'command', env: { MUTATION: '1', ...env }, cwd: root, ownMs: 60_000 });
}

describe.skipIf(process.env.CLIENT_MUT_CHILD === '1' || NOT_LINUX)('owned: after every cut-short build, the same build folder still works', () => {
  it('a real build and a real run of one entry, in the folder every case above used', async () => {
    const r = await runRunner(runner, ['--one', '0'], buildingEntry({}), 600_000);
    expect(r.out).toContain('后台：本项重编');
    expect(r.out).toContain('✅ 变红');
    expect(r.status).toBe(0);
  }, 660_000);
});

describe.skipIf(process.env.CLIENT_MUT_CHILD === '1' || NOT_LINUX)('owned: run.sh tells a failed cleanup from an ordinary failure', () => {
  it('cleanup fails while reading the list size: exit 75, nothing after it starts, no half a number', async () => {
    const f = fakeWorker({ '--count': 'hold' });
    const r = await nightly([], f.env);
    expect(r.exitCode).toBe(75);
    expect(r.stdout).toContain('收尾失败（读负对照清单）');
    expect(started(f.log)).toEqual(['--count']);
    expect(r.stdout).not.toMatch(/^3$/m);
  }, 60_000);

  it('the list size is an ordinary failure: the old words, exit 1, nothing after it', async () => {
    const f = fakeWorker({ '--count': 'fail' });
    const r = await nightly([], f.env);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('读不到负对照清单（退出码 1）');
    expect(started(f.log)).toEqual(['--count']);
  }, 60_000);

  it('cleanup fails while working out what changed: exit 75, no selection and no entry starts', async () => {
    const f = fakeWorker({ '--changes': 'hold' });
    const r = await nightly(['--changed'], f.env);
    expect(r.exitCode).toBe(75);
    expect(r.stdout).toContain('收尾失败（判断改动）');
    expect(started(f.log)).toEqual(['--count', '--changes']);
  }, 60_000);

  it('selecting by change: the selection step gets the change list exactly as written, and only its entry runs', async () => {
    const f = fakeWorker({});
    const r = await nightly(['--changed'], f.env);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(f.seen, 'utf8').trim()).toBe(f.known);
    expect(started(f.log).filter((x) => x.startsWith('--one'))).toEqual(['--one 1']);
  }, 60_000);

  it('cleanup fails while selecting: exit 75, no UI baseline and no entry starts; not the ordinary words', async () => {
    const f = fakeWorker({ '--select': 'hold' });
    const r = await nightly([], f.env);
    expect(r.exitCode).toBe(75);
    expect(r.stdout).toContain('收尾失败（挑选负对照项目）');
    expect(r.stdout).not.toContain('判断不了哪些负对照相关');
    expect(started(f.log)).toEqual(['--count', '--baseline', '--select']);
  }, 60_000);

  it('selecting is an ordinary failure: the old words, exit 1, nothing after it', async () => {
    const f = fakeWorker({ '--select': 'fail' });
    const r = await nightly([], f.env);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('判断不了哪些负对照相关，一项都没跑');
    expect(started(f.log)).toEqual(['--count', '--baseline', '--select']);
  }, 60_000);

  it('cleanup fails on entry 0: exit 75, entries 1 and 2 never start', async () => {
    const f = fakeWorker({ '--one 0': 'hold' });
    const r = await nightly([], f.env);
    expect(r.exitCode).toBe(75);
    expect(r.stdout).toContain('第 0 项（已经跑了 1 项）');
    expect(started(f.log).filter((x) => x.startsWith('--one'))).toEqual(['--one 0']);
  }, 60_000);

  it('entry 0 fails the ordinary way: entries 1 and 2 still run, its reason is shown, exit 1', async () => {
    const f = fakeWorker({ '--one 0': 'fail' });
    const r = await nightly([], f.env);
    expect(r.exitCode).toBe(1);
    expect(started(f.log).filter((x) => x.startsWith('--one'))).toEqual(['--one 0', '--one 1', '--one 2']);
    expect(r.stdout).toContain('第 0 项的失败原因：没变红');
    expect(r.stdout).toContain('1 项失败');
  }, 60_000);

  it('the exit code for a failed cleanup is the same number in run.mjs and run.sh', async () => {
    // @ts-expect-error: plain JavaScript module
    const { CLEANUP_FAILED } = await import('../mutation/owned.mjs');
    const r = await owned(['/bin/bash', '-c', `eval "$(grep -m1 '^CLEANUP_FAILED=' "$1")"; echo "$CLEANUP_FAILED"`, '_', runSh], { settle: 'command', ownMs: 10_000 });
    expect(Number(r.stdout.trim())).toBe(CLEANUP_FAILED);
  });
});
