// GigleAI/cavil-loop#368: in the real window (built with --test-bridge), the real back end behind
// the loopback bridge and the fake GitHub serving the relations recorded from the real board
// (#346 ⊃ #349 #350; test/fixtures/record.mjs --relations). The table with "show hierarchy" on
// (imported from the saved web view): a search that matches #346 only keeps its two sub-issues
// under it, faded, and the view bar says how many were added; clearing the search puts the
// table back as it was (since GitHub#404 the two counts sit in the view bar numbers' hover). Screenshots land in
// test-results/screens/.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelationIssues, loadRelationPages, startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const K = (n: number) => `gigleai/cavil-loop#${n}`;
const PULLED_TITLE = '此条目不符合搜索条件；因上层有命中的 issue 而显示';

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-pulled-'));
  env = {
    fake: await startFakeGitHub({ projects: new Map([['org/gigleai/11', loadRelationPages()]]), repos: new Map([['gigleai/cavil-loop', loadRelationIssues()]]) }),
    userData: join(dir, 'userData'),
    cred: join(dir, 'cred'),
    opened: join(dir, 'opened.txt'),
    requests: join(dir, 'requests.txt'),
  };
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

const row = (page: Page, n: number) => page.locator(`[data-testid="row"][data-key="${K(n)}"]`);

test('GitHub#368: a matched parent keeps its sub-issues in the table, faded, counted apart; clearing the search puts it back', async () => {
  const { page } = await launchApp(env);
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill('https://github.com/orgs/GigleAI/projects/11');
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  // the saved web view is imported: table, "show hierarchy" on, its own search
  await expect(page.getByTestId('search')).toHaveValue('-label:Done -status:Done', { timeout: 15_000 });
  await expect(page.getByTestId('table')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.view.table.hierarchy)).toBe(true);

  // ---- a search that matches the parent only ----
  await page.getByTestId('search').fill('新增依赖图视图');
  // GitHub#404: the view bar no longer says it; the flow numbers' hover carries both counts
  const tip = page.locator('[data-testid="tally"][data-kind="human"]');
  await expect(tip).toHaveAttribute('title', /\n搜索命中 1 条\n另有 2 个子 issue 随父 issue 显示$/);
  await expect(page.locator('.vbar')).not.toContainText('随父 issue 显示');
  await expect(page.locator('.vbar')).not.toContainText('显示 1 /');
  await expect(row(page, 346)).toHaveAttribute('data-depth', '0');
  await expect(row(page, 346)).not.toHaveAttribute('data-pulled', '');
  for (const n of [349, 350]) {
    await expect(row(page, n)).toHaveCount(1);
    await expect(row(page, n)).toHaveAttribute('data-depth', '1');
    await expect(row(page, n)).toHaveAttribute('data-pulled', '');
    await expect(row(page, n)).toHaveAttribute('title', PULLED_TITLE);
    const opacity = await row(page, n).locator('td').first().evaluate((e) => getComputedStyle(e).opacity);
    expect(Number(opacity)).toBeLessThan(1);
  }
  // right under their parent, in the same group
  const keys = await page.locator('[data-testid="row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
  const at = keys.indexOf(K(346));
  expect(new Set(keys.slice(at + 1, at + 3))).toEqual(new Set([K(349), K(350)]));
  // the group and the repository heading count what they show
  const group = page.locator('[data-testid="group"]').filter({ has: row(page, 346) });
  await expect(group.getByTestId('group-count')).toHaveText('3');
  await expect(page.getByTestId('repo-count')).toHaveText('3');
  // the repository list counts what matched
  await expect(page.locator('[data-testid="slice"][data-value=""] .count')).toHaveText('1');
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, 'table-pulled-01-searching.png') });

  // ---- a search that matches a sub-issue too: it is a normal row, the other one still pulled ----
  await page.getByTestId('search').fill('依赖图视图');
  await expect(row(page, 350)).not.toHaveAttribute('data-pulled', '');
  await expect(row(page, 349)).toHaveAttribute('data-pulled', '');
  await expect(tip).toHaveAttribute('title', /\n另有 1 个子 issue 随父 issue 显示$/);

  // ---- search cleared: no pulled rows, no extra sentence ----
  await page.getByTestId('search').fill('');
  await expect(tip).not.toHaveAttribute('title', /搜索命中|随父 issue/);
  await expect(tip).toHaveAttribute('title', /当前来源共 \d+ 个条目$/);
  await expect(page.locator('[data-testid="row"][data-pulled]')).toHaveCount(0);
  await expect(row(page, 349)).toHaveAttribute('data-depth', '1');
  await page.screenshot({ path: join(screens, 'table-pulled-02-cleared.png') });
});
