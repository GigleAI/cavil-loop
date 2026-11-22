import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // GitHub#649: `expect.poll` waits as long as its case may (it used to give up after 1 s on its own,
    // which a loaded machine overran); the case's own limit is the only one
    expect: { poll: { timeout: 20_000 } },
    // the real back end (Rust) is built once before the suites run
    globalSetup: ['test/unit/setup-harness.ts'],
  },
});
