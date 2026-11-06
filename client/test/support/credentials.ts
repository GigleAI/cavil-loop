// Test-only credential stores. The app's own stores (macOS keychain, memory,
// test-mode file) live in the Rust back end (src-tauri/crates/core/src/platform.rs);
// these are what the suites hand to the back end through the test harness, so a
// test can hold, fail or inspect a keychain write.

import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CredentialStore {
  /** true when the credential survives an app restart */
  readonly persistent: boolean;
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

// Stored credentials are GitHub tokens ([A-Za-z0-9_]) or the `v2:` form that
// joins them with ':' (see data/grant.ts); anything else is refused rather than quoted.
const TOKEN_SHAPE = /^[A-Za-z0-9_:]{20,1024}$/;

export function assertTokenShape(token: string): void {
  if (!TOKEN_SHAPE.test(token)) throw new Error('凭据格式不符合预期，未保存');
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
