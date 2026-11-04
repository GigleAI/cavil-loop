// The macOS keychain store, run against a stand-in `security` executable
// (a real child process): the token must travel on stdin, never in argv,
// and "not found" (exit 44) must read as "no credential", not as an error.

import { describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MacKeychainStore } from '../../src/platform/credentials';
import { tempDir } from './helpers';

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
    const s = new MacKeychainStore('svc', 'acct', f.bin);
    expect(await s.get()).toBeNull();
    const token = 'gho_' + 'Z'.repeat(36);
    await s.set(token);
    expect(readFileSync(f.store, 'utf8')).toBe(token);
    expect(await s.get()).toBe(token);
    await s.clear();
    expect(existsSync(f.store)).toBe(false);
    await s.clear(); // clearing twice is fine
    const argv = readFileSync(f.argvLog, 'utf8');
    expect(argv).toContain('find-generic-password -s svc -a acct -w');
    expect(argv).not.toContain(token);
  });

  it('other keychain failures are errors, not "logged out"', async () => {
    const dir = tempDir();
    const bin = join(dir, 'security');
    writeFileSync(bin, '#!/usr/bin/env bash\necho "user interaction is not allowed" >&2\nexit 36\n');
    chmodSync(bin, 0o755);
    await expect(new MacKeychainStore('svc', 'acct', bin).get()).rejects.toThrow(/钥匙串/);
  });
});
