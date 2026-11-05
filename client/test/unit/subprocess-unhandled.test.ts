// A real child process: bundles test/drivers/refresh-save-fails.ts and runs it
// with plain Node. Node's default for an unhandled rejection is to crash the
// process, which is exactly what the Electron main process must never do.

import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('in a separate Node process', () => {
  it('refresh succeeds, the keychain refuses the write: no unhandled rejection, still signed in, the problem is shown', async () => {
    const out = join(tempDir(), 'driver.mjs');
    await build({
      entryPoints: [join(root, 'test/drivers/refresh-save-fails.ts')],
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    });
    const r = spawnSync(process.execPath, [out], { encoding: 'utf8', timeout: 60_000 });
    const text = `${r.stdout}${r.stderr}`;
    expect(text).toContain('AFTER_START ready');
    expect(text).toContain('钥匙串');
    expect(text).toContain('UNHANDLED []');
    expect(text).not.toContain('CALLER_CAUGHT');
    expect(r.status).toBe(0);
  }, 90_000);
});
