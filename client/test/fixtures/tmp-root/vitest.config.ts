// A tiny suite for test/unit/tmp-root.test.ts (GitHub#469): the client's real vitest hook, one test
// file that leaves temp folders behind on purpose.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['leaky.test.ts'],
    environment: 'node',
    globalSetup: ['../../unit/setup-harness.ts'],
  },
});
