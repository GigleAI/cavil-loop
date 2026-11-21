// GigleAI/cavil-loop#622: a lit view-bar number that matches a PR but not the issue it belongs to shows that
// issue too, faded, with the PR under it. In the real window (built with --test-bridge), the real back end
// behind the loopback bridge, the fake GitHub serving the board recorded from the real cavil project: there
// PR #16 carries pending/human while the issue it closes, #9, carries only Done — so "等人处理" matches the
// PR and not its issue. Expected numbers are counted here from the items the window holds, with the rule
// written out in this file. Screenshots land in test-results/screens/.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub, loadCavilProjectPages, loadCavilRepoIssues } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';
import { unfoldSettings } from './unfold';
import type { Item } from '../../src/shared/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const CARRIED_TITLE = '此 issue 不符合搜索条件；因下面有命中的 PR 而显示';

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-carry-'));
  env = {
    fake: await startFakeGitHub({ projects: new Map([['org/gigleai/11', loadCavilProjectPages()]]), repos: new Map([['gigleai/cavil-loop', loadCavilRepoIssues()]]) }),
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

const items = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).data.items as Item[]);
const card = (page: Page, n: number) => page.locator(`[data-testid="card"][data-key="${K(n)}"]`);
const human = (page: Page) => page.locator('[data-testid="tally"][data-kind="human"]');
const keysOf = (page: Page, sel: string) => page.$$eval(sel, (cs) => [...new Set(cs.map((c) => c.getAttribute('data-key')!))].sort());

test('GitHub#622: "等人处理" lit, PR #16 matches and its issue #9 does not — #9 is shown faded right above it, counted apart; a second click puts it back', async () => {
  const { page } = await launchApp(env);
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await unfoldSettings(page);
  await page.getByTestId('source-input').fill(`${PROJECT_URL}/views/2`);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  // the saved board view brings its own search
  const before = '-label:nightly-failure';
  await expect(page.getByTestId('search')).toHaveValue(before, { timeout: 15_000 });

  // the recorded data really is the case: the PR carries the label, its issue does not, and they are linked
  const all = await items(page);
  const i9 = all.find((i) => i.key === K(9))!;
  const p16 = all.find((i) => i.key === K(16))!;
  const has = (i: Item) => i.labels.some((l) => l.name.toLowerCase() === 'pending/human');
  expect(has(p16)).toBe(true);
  expect(has(i9)).toBe(false);
  expect((i9.linkedPrs ?? []).map((l) => l.key)).toContain(K(16));

  await human(page).click();
  await expect(page.getByTestId('search')).toHaveValue('label:"pending/human"');
  // "等人处理" lists closed items too (GitHub#462): #9 and #16 are both closed
  await expect(page.getByTestId('show-closed')).toBeChecked();

  // #9: faded, dashed, says why, does not drag; #16 right under it in the same column
  await expect(card(page, 9)).toHaveAttribute('data-carried', '');
  await expect(card(page, 9)).toHaveAttribute('title', CARRIED_TITLE);
  await expect(card(page, 9)).toHaveAttribute('draggable', 'false');
  await expect(card(page, 9).getByTestId('carried-note')).toHaveText('随 PR 显示 · 不在筛选结果里');
  expect(Number(await card(page, 9).evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(1);
  const col = card(page, 9).locator('xpath=ancestor::*[@data-testid="column"]');
  const order = await col.locator('[data-testid="card"]').evaluateAll((cs) => cs.map((c) => [c.getAttribute('data-key'), c.getAttribute('data-under')]));
  const at = order.findIndex(([k]) => k === K(9));
  expect(order[at + 1]).toEqual([K(16), K(9)]);

  // the number and the matched cards are what carries the label (rule written out here); carried ones count apart
  const want = all.filter(has).map((i) => i.key).sort();
  const count = Number(await human(page).getByTestId('tally-count').textContent());
  expect(count).toBe(want.length);
  expect(await keysOf(page, '[data-testid="card"]:not([data-carried])')).toEqual(want);
  const carried = await keysOf(page, '[data-testid="card"][data-carried]');
  expect(carried).toContain(K(9));
  for (const k of carried) expect(want).not.toContain(k);
  await expect(human(page)).toHaveAttribute('title', new RegExp(`\\n另有 ${carried.length} 个 issue 随命中的 PR 显示$`));
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, 'carry-issue-01-human-lit.png') });

  // a second click: the search from before comes back, and #9 is no longer carried
  await human(page).click();
  await expect(page.getByTestId('search')).toHaveValue(before);
  await expect(page.locator(`[data-testid="card"][data-key="${K(9)}"][data-carried]`)).toHaveCount(0);
  await expect(human(page)).not.toHaveAttribute('title', /随命中的 PR 显示/);
});
