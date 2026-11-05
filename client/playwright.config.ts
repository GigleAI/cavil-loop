import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/playwright',
  globalSetup: './test/e2e/global-setup.ts',
});
