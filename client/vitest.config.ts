import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // the real back end (Rust) is built once before the suites run
    globalSetup: ['test/unit/setup-harness.ts'],
  },
});
