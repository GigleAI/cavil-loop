// Credential storage. The rest of the app only sees `CredentialStore`;
// v1 implements macOS (login keychain via /usr/bin/security). Windows
// Credential Manager / Linux Secret Service plug in here later.

import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CredentialStore {
  /** true when the credential survives an app restart */
  readonly persistent: boolean;
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** execFile reports a non-zero exit status as a numeric `code` */
function exitCode(err: Error): number | string | undefined {
  return (err as unknown as { code?: number | string }).code;
}

export const KEYCHAIN_SERVICE = 'dev.luosky.cavil-loop.client';
export const KEYCHAIN_ACCOUNT = 'github-oauth';

// Stored credentials are GitHub tokens ([A-Za-z0-9_]) or the `v2:` form that
// joins them with ':' (see data/grant.ts); anything else is refused rather than quoted.
const TOKEN_SHAPE = /^[A-Za-z0-9_:]{20,1024}$/;

export function assertTokenShape(token: string): void {
  if (!TOKEN_SHAPE.test(token)) throw new Error('凭据格式不符合预期，未保存');
}

/** macOS login keychain. The token is passed on stdin (`security -i`), never in argv. */
export class MacKeychainStore implements CredentialStore {
  readonly persistent = true;
  constructor(
    private readonly service = KEYCHAIN_SERVICE,
    private readonly account = KEYCHAIN_ACCOUNT,
    private readonly bin = '/usr/bin/security',
  ) {}

  get(): Promise<string | null> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, ['find-generic-password', '-s', this.service, '-a', this.account, '-w'], (err, stdout, stderr) => {
        if (err) {
          // 44 = errSecItemNotFound
          if (exitCode(err) === 44) return resolve(null);
          return reject(new Error(`读取钥匙串失败：${stderr.trim() || err.message}`));
        }
        const t = stdout.trim();
        resolve(t || null);
      });
    });
  }

  set(token: string): Promise<void> {
    assertTokenShape(token);
    return new Promise((resolve, reject) => {
      const p = spawn(this.bin, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += String(d)));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code === 0 && !/error/i.test(stderr)) resolve();
        else reject(new Error(`写入钥匙串失败：${stderr.trim() || `exit ${code}`}`));
      });
      p.stdin.end(
        `add-generic-password -U -s "${this.service}" -a "${this.account}" -l "Cavil Loop (GitHub)" -w "${token}"\n`,
      );
    });
  }

  clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, ['delete-generic-password', '-s', this.service, '-a', this.account], (err, _o, stderr) => {
        if (err && exitCode(err) !== 44) {
          return reject(new Error(`删除钥匙串条目失败：${stderr.trim() || err.message}`));
        }
        resolve();
      });
    });
  }
}

/** Test-only: a plain file (the e2e suite points it into a temp dir). */
export class FileStore implements CredentialStore {
  readonly persistent = true;
  constructor(private readonly path: string) {}
  async get(): Promise<string | null> {
    try {
      return (await readFile(this.path, 'utf8')).trim() || null;
    } catch {
      return null;
    }
  }
  async set(token: string): Promise<void> {
    assertTokenShape(token);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, token, { mode: 0o600 });
  }
  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

/** Platforms v1 does not support yet: keep the token for this run only. */
export class MemoryStore implements CredentialStore {
  readonly persistent = false;
  private token: string | null = null;
  async get() {
    return this.token;
  }
  async set(t: string) {
    assertTokenShape(t);
    this.token = t;
  }
  async clear() {
    this.token = null;
  }
}
