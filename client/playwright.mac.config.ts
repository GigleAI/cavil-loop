import { defineConfig } from '@playwright/test';

// The packaged macOS app keeps syncing with its window closed / started hidden (GitHub#169).
// Run by scripts/mac-open-check.sh on the CI Macs (CAVIL_MAC_APP = the .app it checks).
export default defineConfig({
  testDir: 'test/mac',
  timeout: 360_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/mac',
});
