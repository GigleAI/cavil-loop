// GitHub#649: how the runner's own tests start a process — always through owned.mjs, so the test
// owns the process group and its cleanup; each test case's time is shared by all its calls.

import { TestRunner } from 'vitest';
// @ts-expect-error: plain JavaScript module
import { CacheGuard, TimeAccount, runOwned, runnerExit } from '../mutation/owned.mjs';

/** what a case keeps free at the end, beyond each call's own cleanup budget */
const CASE_MARGIN_MS = 5_000;

const accounts = new WeakMap<object, InstanceType<typeof TimeAccount>>();

/** the current test case's time account (its own time limit, less a margin) */
export function account(): InstanceType<typeof TimeAccount> {
  const t = TestRunner.getCurrentTest() as ({ timeout?: number } & object) | undefined;
  if (!t) throw new Error('account() outside a test case');
  let a = accounts.get(t);
  if (!a) {
    a = new TimeAccount((t.timeout ?? 20_000) - CASE_MARGIN_MS);
    accounts.set(t, a);
  }
  return a;
}

function testSignal(): AbortSignal | undefined {
  const t = TestRunner.getCurrentTest() as { context?: { signal?: AbortSignal } } | undefined;
  return t?.context?.signal;
}

export const guard = new CacheGuard();

export type Owned = {
  status: string;
  diag: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  events: { what: string; at: number; [k: string]: unknown }[];
  products: Record<string, Buffer | null>;
  result: { outcome: string; step?: string; exitCode: number } | null;
  root: string | null;
};

/** Start `argv` as an owned group within this case's time; `ownMs` is the most this call may take. */
export async function owned(argv: string[] | ((work: string) => string[]), opts: Record<string, unknown> & { ownMs?: number } = {}): Promise<Owned> {
  guard.check();
  const limit = account().limitFor(opts.ownMs ?? 120_000);
  if (limit === null) throw new Error('本用例剩余时间不够再调一次');
  const r: Owned = await runOwned(argv, { signal: testSignal(), ...opts, timeoutMs: limit });
  guard.note(r);
  return r;
}

/** The runner's worker, as the command-line entry would run it: exit code and everything it said. */
export async function runRunner(runner: string, args: string[], env: Record<string, string> = {}, ownMs = 120_000) {
  const r = await owned([process.execPath, runner, ...args], { settle: 'runner', env: { ...env, CLIENT_MUT_WORKER: '1' }, cwd: process.cwd(), ownMs });
  const { code, said } = runnerExit(r);
  return { status: code as number, out: `${r.stdout}${r.stderr}${said ? `${said}\n` : ''}`, owned: r };
}

/** the cargo target dir the runner builds mutated back ends into (run.mjs's MUT_TARGET) */
export function mutTarget(clientRoot: string): string {
  return process.env.CLIENT_MUT_CARGO_TARGET ?? `${clientRoot}/src-tauri/target/mutation`;
}

/**
 * GitHub#649: build the unmodified back end into the runner's cargo target dir once, before a file's
 * cases, under a time limit of its own — so a case that builds a mutated copy only recompiles what
 * changed. Owned like every process here; a failure is "准备失败：编后台".
 */
export async function prewarmBackend(clientRoot: string, o: { timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> }): Promise<void> {
  const target = mutTarget(clientRoot);
  const r: Owned = await runOwned(['cargo', 'build', '-q', '-p', 'cavil-harness'], {
    settle: 'command',
    cwd: `${clientRoot}/src-tauri`,
    env: { CARGO_TARGET_DIR: target, ...(o.env ?? {}) },
    timeoutMs: o.timeoutMs,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  guard.note(r);
  const { existsSync } = await import('node:fs');
  if (r.status !== 'exited' || r.exitCode !== 0 || !existsSync(`${target}/debug/cavil-harness`)) {
    throw new Error(`准备失败：编后台（${r.status}${r.diag ? `：${r.diag}` : ''}，退出码 ${r.exitCode}）${r.stderr.trim().split('\n').slice(-3).join(' / ')}`);
  }
}
