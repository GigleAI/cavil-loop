// GigleAI/cavil-loop#587: in the real window (built with --test-bridge), the real back end behind the
// loopback bridge and the fake GitHub. Three repository sources: GigleAI/cavil-loop (the recorded
// issues), GigleAI/second (read, no issue at all) and GigleAI/third (its read always fails, so it was
// never read). The table keeps a place for the two without items: a section under "all
// repositories", the table of the one picked repository (also without a grouping), a group when
// grouped by repository. A read one's line carries "+ new issue", which opens the dialog with that
// repository picked and greys out offline; the one never read says so and offers nothing.
// Screenshots land in test-results/screens/.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-empty-repo-'));
  const fake = await startFakeGitHub();
  fake.state.repos.set('gigleai/second', []);
  fake.state.repos.set('gigleai/third', []);
  fake.state.failRepoPage.set('gigleai/third', 1);
  env = { fake, userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

const shot = (page: Page, name: string) => page.screenshot({ path: join(screens, `587-${name}.png`) });

/** the "+" of GigleAI/second's line opens the new-issue dialog with that repository picked */
async function opensWithSecond(page: Page, where: ReturnType<Page['locator']>) {
  const add = where.locator('[data-testid="repo-blank"][data-repo="GigleAI/second"] [data-testid="repo-blank-add"]');
  await expect(add).toBeEnabled({ timeout: 15_000 });
  await add.click();
  await expect(page.getByTestId('new-issue')).toBeVisible();
  await expect(page.getByTestId('new-issue-repo')).toHaveValue('GigleAI/second');
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('new-issue')).toHaveCount(0);
}

test('GitHub#587: a repository source with nothing to show keeps its place in the table, with "+ new issue", in every layout', async () => {
  const { page } = await launchApp(env);
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  for (const s of ['GigleAI/cavil-loop', 'GigleAI/second', 'GigleAI/third']) {
    await page.getByTestId('source-input').fill(s);
    await page.getByTestId('source-add').click();
  }
  await page.getByTestId('back').click();
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('slice-by-repo').check();
  await page.getByTestId('group-by').selectOption('iteration');
  await page.getByTestId('open-view-panel').click();
  // the repository with items is there first (it is what makes the rest comparable)
  await expect(page.locator('[data-testid="repo-group"][data-key="repo:gigleai/cavil-loop"]')).toHaveCount(1, { timeout: 15_000 });

  // ---- the slice list: 0 for the read one, "—" for the one never read ----
  const slice = (v: string) => page.locator(`[data-testid="slice"][data-value="${v}"]`);
  // (until the round that read it lands, every source counts as never read: "—" first, then 0)
  await expect(slice('GigleAI/second').getByTestId('slice-count')).toHaveText('0', { timeout: 15_000 });
  await expect(slice('GigleAI/third').getByTestId('slice-count')).toHaveText('—');

  // ---- 1. "all repositories", grouped by iteration: a section each ----
  const head = (k: string) => page.locator(`[data-testid="repo-group"][data-key="repo:gigleai/${k}"]`);
  await expect(head('second').getByTestId('repo-count')).toHaveText('0');
  await expect(head('third').getByTestId('repo-count')).toHaveText('—');
  const table = page.getByTestId('table');
  await expect(table.locator('[data-testid="repo-blank"][data-repo="GigleAI/second"]')).toContainText('这个仓库没有要显示的 issue / PR');
  const third = table.locator('[data-testid="repo-blank"][data-repo="GigleAI/third"]');
  await expect(third).toHaveAttribute('data-unread', 'yes');
  await expect(third).toContainText('这个仓库还没读到，读到之后才知道有没有条目');
  await expect(third.getByTestId('repo-blank-add')).toHaveCount(0);
  await expect(page.getByTestId('table-empty')).toHaveCount(0);
  await third.scrollIntoViewIfNeeded();
  await shot(page, 'all-repositories');
  await opensWithSecond(page, table);
  // its section folds like any other
  await head('second').getByTestId('repo-toggle').click();
  await expect(table.locator('[data-testid="repo-blank"][data-repo="GigleAI/second"]')).toHaveCount(0);
  await head('second').getByTestId('repo-toggle').click();
  await expect(table.locator('[data-testid="repo-blank"][data-repo="GigleAI/second"]')).toHaveCount(1);

  // ---- 2. the empty repository picked, no grouping: the line names it ----
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('none');
  await page.getByTestId('open-view-panel').click();
  await slice('GigleAI/second').click();
  const picked = table.locator('[data-testid="repo-blank"][data-repo="GigleAI/second"]');
  await expect(picked).toContainText('GigleAI/second');
  await expect(picked).toContainText('没有要显示的 issue / PR');
  await expect(page.locator('[data-testid="row"]')).toHaveCount(0);
  await expect(page.getByTestId('table-empty')).toHaveCount(0);
  await shot(page, 'picked-no-grouping');
  await opensWithSecond(page, table);
  await slice('GigleAI/third').click();
  await expect(table.locator('[data-testid="repo-blank"][data-repo="GigleAI/third"]')).toContainText('还没读到');
  await expect(table.getByTestId('repo-blank-add')).toHaveCount(0);

  // ---- 3. grouped by repository: a group each ----
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('repo');
  await page.getByTestId('open-view-panel').click();
  await page.locator('[data-testid="slice"][data-value=""]').click();
  const group = page.locator('[data-testid="group"][data-key="repo:gigleai/second"]');
  await expect(group.getByTestId('group-count')).toHaveText('0');
  await expect(group.getByTestId('repo-blank')).toHaveCount(1);
  // the group's own "+" row is not drawn twice
  await expect(group.getByTestId('group-add')).toHaveCount(0);
  await expect(page.locator('[data-testid="group"][data-key="repo:gigleai/third"]').getByTestId('group-count')).toHaveText('—');
  await group.scrollIntoViewIfNeeded();
  await shot(page, 'grouped-by-repository');
  await opensWithSecond(page, group);

  // ---- 4. offline: the line's "+" greys out, as every group's ----
  env.fake.state.offline = true;
  await page.getByTestId('refresh').press('Enter');
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  const add = group.getByTestId('repo-blank-add');
  await expect(add).toBeDisabled();
  await expect(add).toHaveAttribute('title', '离线时不能修改');
  await expect(page.getByTestId('group-add').first()).toBeDisabled();
  env.fake.state.offline = false;
});
