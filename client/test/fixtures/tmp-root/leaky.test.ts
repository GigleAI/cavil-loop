// Leaves temp folders behind on purpose (GitHub#469, test/unit/tmp-root.test.ts) and writes where
// they went to $LEAKY_OUT; exits non-zero when LEAKY_FAIL is set.
import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('leaks', () => {
  const d = mkdtempSync(join(tmpdir(), 'cavil-client-test-'));
  for (let i = 0; i < 20; i++) writeFileSync(join(d, `f${i}`), 'x');
  writeFileSync(process.env.LEAKY_OUT!, JSON.stringify({ tmpdir: tmpdir(), made: d }));
  expect(process.env.LEAKY_FAIL ?? '').toBe('');
});
