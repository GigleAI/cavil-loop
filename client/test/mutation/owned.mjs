// GitHub#649: the one way the negative-control runner, and anything the runner's own tests start,
// is run: as the head of a new process group that exists before the program runs its first line,
// owned and cleaned up by whoever called this function. One group, one owner, no list to keep.
//
//   1. a folder R of its own: R/work for the program, R/result.json for the runner's verdict
//   2. the program is started with `detached` (its pid is the group id, known the moment spawn returns)
//   3. cleanup starts on the first of: the program exits (the `exit` event — not waiting for its
//      pipes), this call's time limit, the caller's abort signal
//   4. cleanup: the group already empty → done, no waiting, no signal; otherwise SIGTERM, check every
//      50 ms up to GRACE_MS, then SIGKILL, check every 50 ms up to CONFIRM_MS. A failed check is not "empty".
//   5. empty: read what is left on the pipes (at most DRAIN_MS); not ended → the output is void
//   6. then, in this order: read the products into memory, remove R, settle the verdict
//   7. not confirmed empty, or output not read to the end: CLEANUP_FAILED, R is kept
//
// Two ways to settle: 'runner' (the runner must leave a complete R/result.json that agrees with how
// it really exited) and 'command' (anything else: the exit code / signal and the files the caller
// lists in `keep` are handed back as they are; the caller judges them as it always did).

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The exit code of the runner's command-line entry when cleanup failed: stop the whole run. */
export const CLEANUP_FAILED = 75;

export const GRACE_MS = 2_000;
export const CONFIRM_MS = 10_000;
export const DRAIN_MS = 2_000;
/** what every call keeps free for its own cleanup, on top of its time limit */
export const CLEANUP_BUDGET_MS = GRACE_MS + CONFIRM_MS + DRAIN_MS;

const POLL_MS = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is anything left in group `pgid`? 'gone' only when the system says so; anything else is 'there' or 'unknown'. */
export function probeGroup(pgid) {
  try {
    process.kill(-pgid, 0);
    return 'there';
  } catch (e) {
    if (e.code === 'ESRCH') return 'gone';
    if (e.code === 'EPERM') return 'there';
    return 'unknown';
  }
}

function signalGroup(pgid, sig) {
  try {
    process.kill(-pgid, sig);
  } catch {
    /* gone already, or not ours to signal: the probe decides */
  }
}

/**
 * Run `argv` as the head of a new group and own its cleanup.
 * opts: { settle: 'runner'|'command', env, cwd, timeoutMs, signal, keep: [paths relative to R/work or absolute],
 *         stdin, onStderr(chunk), probe (tests only: replaces probeGroup), grace/confirm/drain (tests only) }
 */
export async function runOwned(argv, opts = {}) {
  const settle = opts.settle ?? 'command';
  if (settle !== 'runner' && settle !== 'command') throw new Error(`settle must be 'runner' or 'command', got ${settle}`);
  const probe = opts.probe ?? probeGroup;
  const grace = opts.grace ?? GRACE_MS;
  const confirm = opts.confirm ?? CONFIRM_MS;
  const drain = opts.drain ?? DRAIN_MS;
  const events = [];
  const ev = (what, extra = {}) => events.push({ what, at: Date.now(), ...extra });

  const root = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), 'cavil-owned-'));
  const work = join(root, 'work');
  mkdirSync(work);
  const resultFile = join(root, 'result.json');
  const env = { ...process.env, ...(opts.env ?? {}), CLIENT_MUT_OWNED_ROOT: root, CLIENT_MUT_OWNED_WORK: work, CLIENT_MUT_OWNED_RESULT: resultFile };

  // argv may depend on the call's own folder (e.g. a report written into it)
  const cmd = typeof argv === 'function' ? argv(work) : argv;
  let child;
  try {
    child = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd ?? work, env, stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    return { status: 'start-failed', diag: String(e.message ?? e), events, stdout: '', stderr: '', exitCode: null, signal: null, products: {}, result: null, root: null };
  }
  const pgid = child.pid;
  ev('started', { pgid });
  if (opts.stdin !== undefined && child.stdin) child.stdin.end(opts.stdin);

  const out = [];
  const err = [];
  const ended = { stdout: false, stderr: false };
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => {
    err.push(d);
    opts.onStderr?.(d);
  });
  child.stdout.on('end', () => (ended.stdout = true));
  child.stderr.on('end', () => (ended.stderr = true));

  // the start of cleanup: whichever comes first, once
  let why = null;
  let exitInfo = null;
  let spawnError = null;
  const trigger = new Promise((resolve) => {
    child.on('error', (e) => {
      spawnError = e;
      why ??= 'start-error';
      resolve();
    });
    child.on('exit', (code, sig) => {
      exitInfo = { code, signal: sig };
      ev('program-exited', { code, signal: sig });
      why ??= 'exited';
      resolve();
    });
    if (opts.timeoutMs !== undefined) {
      const t = setTimeout(() => {
        why ??= 'timeout';
        ev('time-limit');
        resolve();
      }, opts.timeoutMs);
      child.on('exit', () => clearTimeout(t));
      child.on('error', () => clearTimeout(t));
    }
    if (opts.signal) {
      const onAbort = () => {
        why ??= 'cancelled';
        ev('cancelled');
        resolve();
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  await trigger;

  if (spawnError && pgid === undefined) {
    rmSync(root, { recursive: true, force: true });
    return { status: 'start-failed', diag: String(spawnError.message ?? spawnError), events, stdout: '', stderr: '', exitCode: null, signal: null, products: {}, result: null, root: null };
  }

  // ---- cleanup: empty already? → done at once; else SIGTERM, grace, SIGKILL, confirm ----
  let state = probe(pgid);
  ev('probe', { state });
  if (state !== 'gone') {
    ev('grace-start');
    signalGroup(pgid, 'SIGTERM');
    ev('signal', { sig: 'SIGTERM' });
    for (const end = Date.now() + grace; Date.now() < end; ) {
      await sleep(POLL_MS);
      state = probe(pgid);
      if (state === 'gone') break;
    }
    if (state !== 'gone') {
      signalGroup(pgid, 'SIGKILL');
      ev('signal', { sig: 'SIGKILL' });
      for (const end = Date.now() + confirm; Date.now() < end; ) {
        await sleep(POLL_MS);
        state = probe(pgid);
        if (state === 'gone') break;
      }
    }
  }
  if (state !== 'gone') {
    ev('not-confirmed', { state });
    child.stdout.destroy();
    child.stderr.destroy();
    return {
      status: 'cleanup-failed',
      diag: `进程组 ${pgid} 未能确认退出（最后一次查询：${state}）`,
      events,
      stdout: '',
      stderr: Buffer.concat(err).toString(),
      exitCode: exitInfo?.code ?? null,
      signal: exitInfo?.signal ?? null,
      products: {},
      result: null,
      root,
    };
  }
  ev('group-empty');

  // ---- what is left on the pipes: every writer is gone, so it ends — unless someone outside the group holds it ----
  for (const end = Date.now() + drain; !(ended.stdout && ended.stderr) && Date.now() < end; ) await sleep(10);
  if (!(ended.stdout && ended.stderr)) {
    ev('drain-timeout');
    child.stdout.destroy();
    child.stderr.destroy();
    return {
      status: 'cleanup-failed',
      diag: '输出没能确认读完：组已清空，但还有组外进程持有输出',
      events,
      stdout: '',
      stderr: Buffer.concat(err).toString(),
      exitCode: exitInfo?.code ?? null,
      signal: exitInfo?.signal ?? null,
      products: {},
      result: null,
      root,
    };
  }
  ev('output-read');
  const stdout = Buffer.concat(out).toString();
  const stderr = Buffer.concat(err).toString();

  // ---- read the products, then remove R, then settle ----
  const products = {};
  let result = null;
  let resultProblem = null;
  if (settle === 'runner') {
    if (!existsSync(resultFile)) resultProblem = 'missing';
    else {
      try {
        result = JSON.parse(readFileSync(resultFile, 'utf8'));
        if (!result || typeof result !== 'object' || !['done', 'step-timeout'].includes(result.outcome) || !Number.isInteger(result.exitCode) || (result.outcome === 'step-timeout' && typeof result.step !== 'string')) {
          resultProblem = 'malformed';
          result = null;
        }
      } catch {
        resultProblem = 'malformed';
      }
    }
  }
  for (const k of opts.keep ?? []) {
    const p = k.startsWith('/') ? k : join(work, k);
    products[k] = existsSync(p) ? readFileSync(p) : null;
  }
  ev('products-read');
  rmSync(root, { recursive: true, force: true });
  ev('folder-removed');

  const base = { events, stdout, stderr, exitCode: exitInfo?.code ?? null, signal: exitInfo?.signal ?? null, products, result, root: null };
  if (why === 'timeout') return { ...base, status: 'timeout', diag: result?.step ? `超时：${result.step}` : '超时' };
  if (why === 'cancelled') return { ...base, status: 'cancelled', diag: result?.step ? `已取消（卡在：${result.step}）` : '已取消' };
  if (why === 'start-error') return { ...base, status: 'start-failed', diag: String(spawnError?.message ?? spawnError) };
  if (settle === 'command') return { ...base, status: 'exited', diag: '' };
  // settle === 'runner'
  const how = exitInfo?.signal ? `信号 ${exitInfo.signal}` : `退出码 ${exitInfo?.code}`;
  if (resultProblem) return { ...base, status: 'no-result', diag: `执行器没有交出结果（${how}）` };
  if (exitInfo?.signal || exitInfo?.code !== result.exitCode) return { ...base, status: 'bad-exit', diag: `执行器退出状态异常（结果写 ${result.exitCode}，实际 ${how}）` };
  if (result.outcome === 'step-timeout') return { ...base, status: 'step-timeout', diag: `超时：${result.step}` };
  return { ...base, status: 'ok', diag: '' };
}

/**
 * GitHub#649: what the runner's command-line entry exits with, and the line it says, for one call's
 * outcome — the same for the entry and for the tests that drive the worker directly.
 */
export function runnerExit(r) {
  if (r.status === 'cleanup-failed') return { code: CLEANUP_FAILED, said: `❌ 收尾失败：${r.diag}` };
  if (r.status === 'ok') return { code: r.result.exitCode, said: '' };
  // a step's own time limit: the worker already said which step
  if (r.status === 'step-timeout') return { code: 1, said: '' };
  if (r.status === 'timeout' || r.status === 'cancelled') return { code: 1, said: `❌ 执行异常（${r.diag}）` };
  return { code: 1, said: `❌ ${r.diag}` };
}

/**
 * GitHub#649: after a cleanup that could not be confirmed, processes may still hold the shared build
 * cache: nothing later in the same run may use it. One guard per run (a test file, or run.sh's night).
 */
export class CacheGuard {
  constructor() {
    this.why = null;
  }
  /** note a call's outcome */
  note(r) {
    if (r.status === 'cleanup-failed') this.why ??= r.diag;
  }
  /** throws when an earlier cleanup was not confirmed */
  check() {
    if (this.why !== null) throw new Error(`上一场景收尾未确认，不复用编译缓存（${this.why}）`);
  }
}

/**
 * GitHub#649: one test case's time, shared by every call it makes. Each call gets
 * min(its own limit, what is left − CLEANUP_BUDGET_MS); too little left → no call at all.
 * `now` is replaceable so the arithmetic can be tested on a clock the test moves.
 */
export class TimeAccount {
  constructor(totalMs, { now = () => Date.now(), minCallMs = 1_000 } = {}) {
    this.now = now;
    this.end = now() + totalMs;
    this.minCallMs = minCallMs;
    /** every limit handed out, in order */
    this.given = [];
  }
  /** the limit for the next call, or null when too little is left for it plus its cleanup */
  limitFor(ownMs) {
    const left = this.end - this.now();
    if (left < CLEANUP_BUDGET_MS + this.minCallMs) return null;
    const ms = Math.min(ownMs, left - CLEANUP_BUDGET_MS);
    this.given.push(ms);
    return ms;
  }
}
