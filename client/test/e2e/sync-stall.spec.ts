// GigleAI/cavil-loop#733: a sync that stopped moving shows in the real window — also when nothing was
// ever checked (a first sync stuck at its first save: no "上次检查" time yet). The real window (built with
// --test-bridge) with its watch on, as the app runs it; the real back end behind the loopback bridge,
// one of its calls held by the test; the local fake GitHub. The window's clock is Playwright's.

import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });
const REPO = 'GigleAI/cavil-loop';

let env: AppEnv;
let dir: string;
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
  rmSync(dir, { recursive: true, force: true });
});
test.afterAll(closeEngine);

test('a first sync stuck at its first save: yellow dot and "同步卡住" with no check time; the hover names the step and how to recover; gone once the save lands', async () => {
  const app = await launchApp(env, { watch: true, clockAt: Date.now() });
  const page = app.page;
  // sign in without any source: nothing is read yet
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('sync-status')).toHaveCount(0); // nothing checked, nothing stuck: nothing shown

  // the first source: its first save is held
  const release = app.holdCall((cmd) => cmd === 'replaceSnapshots');
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(REPO);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('refresh')).toHaveAttribute('data-syncing', 'yes', { timeout: 15_000 });

  // the round's reads answer (its progress) and it reaches the held save
  await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.sync.roundAt?.lastProgressAt ?? null), { timeout: 15_000 }).not.toBeNull();
  await page.waitForTimeout(500);
  // the watch wakes every 15 s: a few more than 12 quiet wakes with the save still held
  for (let i = 0; i < 15; i++) {
    await page.clock.fastForward('00:15');
    await page.waitForTimeout(50);
  }
  const status = page.getByTestId('sync-status');
  await expect(status).toBeVisible();
  await expect(status).toHaveClass(/stalled/);
  await expect(page.getByTestId('sync-stall')).toHaveText('同步卡住');
  await expect(status).not.toContainText('上次检查');
  const hover = (await status.getAttribute('title')) ?? '';
  expect(hover).toContain('卡在「存到本机」已 3 分钟没有进展');
  expect(hover).toContain('完全退出客户端再打开');
  // the dot is the warning colour, not the green of a fresh check
  const dot = await status.locator('.dot').evaluate((e) => getComputedStyle(e).backgroundColor);
  const green = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--state-open-fg').trim());
  expect(dot).not.toBe(green);
  await page.screenshot({ path: join(screens, '733-first-sync-stuck.png') });

  // the save lands: the round completes, the stall is gone, the check time shows
  release();
  await expect(page.getByTestId('sync-stall')).toHaveCount(0, { timeout: 15_000 });
  await expect(status).toContainText('上次检查');
  await expect(status).not.toHaveClass(/stalled/);
  await app.close();
});
