// The real back end (Rust, src-tauri/crates/core) as a child process for the
// suites: same commands as the app's IPC, over stdin/stdout. The credential
// store, the clock and the browser stay in the test (the back end calls back
// for them), so a test can hold a keychain write, fail it, or move time.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Backend } from '../../src/backend/backend';
import type { Endpoints } from '../../src/data/github';
import type { CredentialStore } from './credentials';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TAURI_DIR = join(root, 'src-tauri');

/** Path of the harness binary; CAVIL_HARNESS overrides (the negative-control runner points it at a mutated build). */
export function harnessBin(): string {
  return process.env.CAVIL_HARNESS ?? join(TAURI_DIR, 'target', 'debug', 'cavil-harness');
}

/** Build the harness (once per run; cargo is a no-op when nothing changed). */
export function buildHarness(): void {
  if (process.env.CAVIL_HARNESS) return;
  const r = spawnSync('cargo', ['build', '-q', '-p', 'cavil-harness'], { cwd: TAURI_DIR, stdio: 'inherit' });
  if (r.status !== 0 || !existsSync(harnessBin())) throw new Error('cargo build -p cavil-harness failed');
}

export interface HarnessOptions {
  db: string;
  endpoints: Endpoints;
  credentials: CredentialStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** URLs the app asked the system browser to open */
  opened?: string[];
  /** use the real macOS keychain store with this stand-in for /usr/bin/security (ignores `credentials`) */
  keychainBin?: string;
  /** extra environment for the back end (GitHub#314: the CAVIL_CLIENT_TEST_DAEMON_* switches) */
  env?: Record<string, string>;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class HarnessBackend implements Backend {
  private readonly p: ChildProcessWithoutNullStreams;
  private seq = 1;
  private readonly pending = new Map<number, Pending>();
  private closedErr: Error | null = null;
  readonly exited: Promise<number | null>;
  /** every command sent, in order (what crossed the boundary) */
  readonly sent: { cmd: string; args: unknown }[] = [];
  /** every status the updater reported (test.update.*), in order */
  readonly updates: any[] = [];
  /** every answer received, in order */
  readonly received: unknown[] = [];

  constructor(private readonly o: HarnessOptions) {
    const args = ['--db', o.db, '--api', o.endpoints.api, '--web', o.endpoints.web];
    if (!o.credentials.persistent) args.push('--memory-credentials');
    if (o.keychainBin) args.push('--keychain-bin', o.keychainBin);
    this.p = spawn(harnessBin(), args, { stdio: ['pipe', 'pipe', 'pipe'], ...(o.env ? { env: { ...process.env, ...o.env } } : {}) });
    let stderr = '';
    this.p.stderr.on('data', (d) => (stderr += String(d)));
    this.exited = new Promise((r) => this.p.on('exit', (code) => r(code)));
    this.p.on('exit', (code) => {
      this.closedErr = new Error(`back end exited (${code}) ${stderr.trim()}`);
      for (const w of this.pending.values()) w.reject(this.closedErr);
      this.pending.clear();
    });
    this.p.stdin.on('error', () => {});
    createInterface({ input: this.p.stdout }).on('line', (line) => void this.onLine(line));
  }

  private write(msg: unknown) {
    if (!this.p.stdin.destroyed) this.p.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private async onLine(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.ev === 'update') {
      this.updates.push(m.status);
      return;
    }
    if (typeof m.cb === 'number') {
      try {
        const ok = await this.callback(m.op, m.args ?? {});
        this.write({ cb: m.cb, ok: ok ?? null });
      } catch (e) {
        this.write({ cb: m.cb, err: (e as Error).message ?? String(e) });
      }
      return;
    }
    const w = this.pending.get(m.id);
    if (!w) return;
    this.pending.delete(m.id);
    this.received.push(m.ok ?? m.err);
    if ('err' in m) w.reject(new Error(m.err));
    else w.resolve(m.ok);
  }

  private async callback(op: string, args: any): Promise<unknown> {
    switch (op) {
      case 'cred.get':
        return this.o.credentials.get();
      case 'cred.set':
        return this.o.credentials.set(String(args.value));
      case 'cred.clear':
        return this.o.credentials.clear();
      case 'now':
        return (this.o.now ?? Date.now)();
      case 'sleep':
        return (this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(Number(args.ms));
      case 'open':
        this.o.opened?.push(String(args.url));
        return null;
      case 'openFile':
        // GitHub#314: a file the daemon section handed to the system
        this.o.opened?.push(`file:${String(args.what)}:${String(args.path)}`);
        return null;
      default:
        throw new Error(`unknown callback ${op}`);
    }
  }

  call<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    const id = this.seq++;
    this.sent.push({ cmd, args });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, cmd, args });
    });
  }

  /** End the process the way the app quits: stdin closes, it exits. */
  async close(): Promise<void> {
    this.p.stdin.end();
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2000))]);
    if (this.p.exitCode === null) this.p.kill('SIGKILL');
  }

  /** End it abruptly (a crash, or quitting while a keychain call has not returned). */
  kill(): Promise<number | null> {
    this.p.kill('SIGKILL');
    return this.exited;
  }
}
