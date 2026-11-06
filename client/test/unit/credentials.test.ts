// The macOS keychain store (the back end's, src-tauri/crates/core/src/platform.rs),
// run against a stand-in `security` executable (a real child process): the token
// must travel on stdin, never in argv, and "not found" (exit 44) must read as
// "no credential", not as an error.

import { describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessBackend } from '../support/harness';
import { MemoryStore } from '../support/credentials';
import { tempDir } from './helpers';

/** The back end with its real keychain store, pointed at a stand-in for /usr/bin/security. */
function keychain(dir: string, bin: string) {
  const b = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints: { api: 'http://127.0.0.1:1/api', web: 'http://127.0.0.1:1/web' }, credentials: new MemoryStore(), keychainBin: bin });
  return {
    get: () => b.call<string | null>('test.cred.get'),
    set: (value: string) => b.call('test.cred.set', { value }),
    clear: () => b.call('test.cred.clear'),
    close: () => b.close(),
  };
}

function fakeSecurity(dir: string) {
  const bin = join(dir, 'security');
  const store = join(dir, 'store');
  const argvLog = join(dir, 'argv.log');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${argvLog}'
case "$1" in
  -i)
    line=$(cat)
    case "$line" in
      add-generic-password*) tok=$(printf '%s' "$line" | sed -n 's/.* -w "\\([^"]*\\)".*/\\1/p'); printf '%s' "$tok" > '${store}' ;;
      *) echo "error: unknown $line" >&2; exit 1 ;;
    esac ;;
  find-generic-password) [ -f '${store}' ] || { echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; exit 44; }; cat '${store}'; echo ;;
  delete-generic-password) [ -f '${store}' ] || exit 44; rm -f '${store}' ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, store, argvLog };
}

describe('MacKeychainStore', () => {
  it('set → get → clear round-trips; the token never appears in argv', async () => {
    const dir = tempDir();
    const f = fakeSecurity(dir);
    const s = keychain(dir, f.bin);
    expect(await s.get()).toBeNull();
    const token = 'gho_' + 'Z'.repeat(36);
    await s.set(token);
    expect(readFileSync(f.store, 'utf8')).toBe(token);
    expect(await s.get()).toBe(token);
    await s.clear();
    expect(existsSync(f.store)).toBe(false);
    await s.clear(); // clearing twice is fine
    // the token shape is checked before anything reaches the keychain command line
    await expect(s.set('gho_x" -w "evil')).rejects.toThrow(/凭据格式/);
    expect(existsSync(f.store)).toBe(false);
    await s.close();
    const argv = readFileSync(f.argvLog, 'utf8');
    // the same keychain entry the Electron build used: an existing sign-in carries over
    expect(argv).toContain('find-generic-password -s dev.luosky.cavil-loop.client -a github-oauth -w');
    expect(argv).not.toContain(token);
    expect(argv).not.toContain('evil');
  });

  it('other keychain failures are errors, not "logged out"', async () => {
    const dir = tempDir();
    const bin = join(dir, 'security');
    writeFileSync(bin, '#!/usr/bin/env bash\necho "user interaction is not allowed" >&2\nexit 36\n');
    chmodSync(bin, 0o755);
    const s = keychain(dir, bin);
    await expect(s.get()).rejects.toThrow(/钥匙串/);
    await s.close();
  });
});
