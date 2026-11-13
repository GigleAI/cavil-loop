import { defineConfig } from '@playwright/test';

// The real Tauri app over WebDriver (test/tauri). Linux only; CI runs it under xvfb.
export default defineConfig({
  testDir: 'test/tauri',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/tauri',
  globalSetup: './test/tauri/global-setup.ts',
});
