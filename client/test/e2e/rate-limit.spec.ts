// GigleAI/cavil-loop#558, in the real window: the client keeps no quota of its own. While GitHub
// answers there is nothing next to the refresh button; when GitHub refuses with its rate limit the
// button becomes the yellow "GitHub 限流（HH:MM 恢复）" and its panel says so in GitHub's words; once
// GitHub answers again it goes. Screenshots of each state land in test-results/screens/ (issue558-*).

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';
// the window's own clock text (rounded up to the minute)
import { hhmm } from '../../src/shared/readFailure';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

async function signIn(): Promise<Page> {
  const app = await launchApp(env);
  const page = app.page;
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toHaveText(/^ABCD-\d+$/);
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  return page;
}
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `issue558-${name}.png`) });
};

test('no quota of its own: nothing while GitHub answers; GitHub\'s rate limit = the yellow "GitHub 限流（HH:MM 恢复）"; gone once GitHub answers', async () => {
  env.fake.state.memberOrgs.set('user-1', ['GigleAI']);
  // the account well past half of its hour: the client reads as usual (GitHub#558)
  env.fake.state.quota.graphql = { limit: 5000, used: 4900, resetAt: Math.ceil((Date.now() + 40 * 60_000) / 1000) };
  env.fake.state.quota.core = { limit: 5000, used: 4900, resetAt: Math.ceil((Date.now() + 40 * 60_000) / 1000) };
  const page = await signIn();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(PROJECT_URL);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('empty-guide')).toHaveCount(0, { timeout: 15_000 });
  // the board was read (whichever view the window opens in)
  await expect(page.getByTestId('item-total')).toHaveText(/^[1-9]\d* 个条目$/, { timeout: 15_000 });
  const btn = page.getByTestId('sync-trouble');
  await expect(btn).toHaveCount(0);
  expect(env.fake.log.some((e) => e.path.startsWith('/api/rate_limit'))).toBe(false);
  await shot(page, 'normal');

  // GitHub refuses with its hourly limit (REST: 403, remaining 0, the reset in seconds)
  const reset = Math.ceil((Date.now() + 20 * 60_000) / 1000);
  env.fake.state.answerOverride = (e) =>
    e.path.startsWith('/api/')
      ? {
          status: 403,
          body: { message: 'API rate limit exceeded for user ID 1.', documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api' },
          headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        }
      : null;
  await page.getByTestId('refresh').click();
  await expect(btn).toBeVisible({ timeout: 15_000 });
  await expect(btn).toHaveAttribute('data-limited', 'yes');
  await expect(btn).toHaveText(`GitHub 限流（${hhmm(reset * 1000)} 恢复）`);
  await btn.click();
  const panel = page.getByTestId('sync-trouble-panel');
  await expect(panel).toHaveAttribute('aria-label', 'GitHub 限流中');
  // the line under the source says the same minute as the button
  await expect(page.getByTestId('sync-trouble-retry').first()).toContainText(`额度约 ${hhmm(reset * 1000)} 恢复`);
  await expect(page.getByTestId('sync-trouble-failure').first().getByTestId('failure-title')).toHaveText('GitHub 暂时限制了读取次数');
  await expect(page.getByTestId('sync-trouble-failure').first().getByTestId('failure-body')).toContainText('每小时的查询额度已经用完');
  // the board keeps what it showed
  await expect(page.getByTestId('item-total')).toHaveText(/^[1-9]\d* 个条目$/);
  await shot(page, 'limited');
  await btn.click();

  // GitHub answers again: a refresh by hand reads, and the yellow goes
  env.fake.state.answerOverride = null;
  await page.getByTestId('refresh').click();
  await expect(btn).toHaveCount(0, { timeout: 15_000 });
});
