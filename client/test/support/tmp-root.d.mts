// Types for tmp-root.mjs (plain JS so the launcher runs under bare node).
export const MASTER: string;
export const LEFTOVER_PREFIX: string;
export const LOCK_FD: number;
export interface Reaped {
  error?: string;
  removed: string[];
  busy: string[];
  unknown: string[];
}
export function systemTmp(env?: NodeJS.ProcessEnv): string;
export function insideRun(env?: NodeJS.ProcessEnv): boolean;
export function leftovers(dir: string): string[];
export function lockToolProblem(env?: NodeJS.ProcessEnv): string | null;
export function reap(sys: string, env?: NodeJS.ProcessEnv): Reaped;
export function runEnv(sys: string, root: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function spawnInRun(
  sys: string,
  cmd: string[],
  o?: { env?: NodeJS.ProcessEnv; stdio?: import('node:child_process').StdioOptions },
): { root: string; child: import('node:child_process').ChildProcess };
export function directRun(): Promise<() => Promise<void>>;
