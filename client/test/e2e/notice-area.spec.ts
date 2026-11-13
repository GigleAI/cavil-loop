// GigleAI/cavil-loop#488: the window's one notice area. Every result the controller holds — an operation
// (close, merge, 托管, 交给 agent, 等前置), a new issue, a change not saved — is said there, under the tab
// bar and above every page, and nowhere else: started in the floating panel, in a tab or on the board, it
// shows exactly once, and it is still there after the panel closed, the tab changed or the settings page
// came up. Newest on top; three at most, the rest behind 「还有 N 条」. The real window (built with
// --test-bridge), the real back end behind the loopback bridge, the local fake GitHub.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { findCopies } from '../fake-github/writes';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
/** recorded open issues */
const A = 139;
const B = 142;
const C = 144;
const D = 137;

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  for (const n of [A, B, C, D]) open(n);
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(closeEngine);

/** the item is open with no labels on GitHub (the fake: every copy it holds) */
function open(n: number) {
  const c = findCopies(env.fake.state, REPO, n)!;
  for (const r of c.rest) Object.assign(r, { state: 'open', state_reason: null, labels: [] });
  for (const g of c.gql) Object.assign(g, { state: 'OPEN', stateReason: null, labels: { nodes: [] } });
}

async function signIn(page: Page) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  for (const s of [PROJECT_URL, REPO]) {
    await page.getByTestId('source-input').fill(s);
    await page.getByTestId('source-add').click();
  }
  await page.getByTestId('back').click();
  await page.keyboard.press('Control+Shift+2');
  await expect(row(page, A)).toBeVisible({ timeout: 20_000 });
}

const row = (page: Page, n: number) => page.locator(`[data-testid="row"][data-key="${K(n)}"] [data-testid="title-cell"]`).first();
const detail = (page: Page) => page.getByTestId('detail');
const area = (page: Page) => page.getByTestId('notice-area');
/** an item's operation notice in the notice area */
const inArea = (page: Page, n: number) => page.locator(`[data-testid="notice-area"] [data-testid="op-notice"][data-key="${K(n)}"]`);
/** the same notice anywhere in the window */
const anywhere = (page: Page, n: number) => page.locator(`[data-testid="op-notice"][data-key="${K(n)}"]`);
const closes = (n: number) => env.fake.log.filter((l) => l.method === 'PATCH' && l.path.endsWith(`/repos/${REPO}/issues/${n}`)).map((l) => l.status);

/** close the issue the detail in front shows; GitHub refuses it (the repository is read-only for the account) */
async function refusedClose(page: Page, n: number) {
  const d = detail(page);
  await expect(d).toHaveAttribute('data-key', K(n));
  await expect(d.getByTestId('close-issue')).toBeEnabled({ timeout: 15_000 });
  env.fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
  await d.getByTestId('close-issue').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect.poll(() => closes(n), { timeout: 15_000 }).toEqual([403]);
  env.fake.state.w.readOnlyRepos.delete('gigleai/cavil-loop');
}

test('GitHub#488: results of operations, a new issue and unsaved changes show once, in the notice area above every page — from the floating panel, a tab and the board; newest first, three at most', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  await expect(area(page)).toHaveCount(0);

  // ---- 1. the floating panel: the refused close is said in the area, not in the panel ----
  await row(page, A).click();
  await refusedClose(page, A);
  await expect(inArea(page, A)).toHaveAttribute('data-kind', 'error');
  await expect(anywhere(page, A)).toHaveCount(1);
  await expect(detail(page).getByTestId('op-notice')).toHaveCount(0);
  // the panel's ⚠ N has nothing of it (it keeps only the panel's own matters)
  await expect(detail(page).getByTestId('detail-notices-toggle')).toHaveCount(0);
  await shot(page, '488-01-float-refused');
  // a click in the area is no click outside the panel: the panel stays (its buttons act on that very item)
  await inArea(page, A).getByTestId('op-notice-text').click();
  await page.waitForTimeout(300);
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  // the panel put away: the notice stays where it was, still once
  await detail(page).click({ position: { x: 20, y: 5 } });
  await page.keyboard.press('Escape');
  await expect(detail(page)).toHaveCount(0);
  await expect(inArea(page, A)).toBeVisible();
  await expect(anywhere(page, A)).toHaveCount(1);
  // the item opened again: still only the one in the area
  await row(page, A).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await expect(anywhere(page, A)).toHaveCount(1);
  await page.keyboard.press('Escape');

  // ---- 2. a tab: the same; going home and to the settings page, it stays ----
  await row(page, B).click({ modifiers: ['Control'] });
  await expect(detail(page)).toHaveAttribute('data-mode', 'tab');
  await refusedClose(page, B);
  await expect(inArea(page, B)).toHaveAttribute('data-kind', 'error');
  await expect(anywhere(page, B)).toHaveCount(1);
  await expect(page.getByTestId('tab')).toHaveCount(1);
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('board-bars').getByTestId('op-notice')).toHaveCount(0);
  await expect(anywhere(page, A)).toHaveCount(1);
  await expect(anywhere(page, B)).toHaveCount(1);
  await page.getByTestId('open-settings').click();
  await expect(inArea(page, A)).toBeVisible();
  await expect(inArea(page, B)).toBeVisible();
  await page.getByTestId('back').click();
  // newest on top
  await expect(area(page).getByTestId('op-notice').first()).toHaveAttribute('data-key', K(B));

  // ---- 3. a change not saved (a label refused): the bar and the item's own list, in the area only ----
  await row(page, C).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(C));
  env.fake.state.w.failLabel = 'pending/PR';
  await detail(page).getByTestId('label-add').click();
  await detail(page).locator('[data-testid="label-picker"] [data-testid="picker-item"][data-name="pending/PR"]').click();
  await page.keyboard.press('Escape');
  const issue = area(page).locator('[data-testid="edit-issue"][data-field="label"]');
  await expect(issue).toHaveAttribute('data-edit', 'failed', { timeout: 15_000 });
  await expect(page.getByTestId('edit-issue')).toHaveCount(1);
  await expect(page.getByTestId('edits-bar')).toHaveCount(1);
  await expect(area(page).getByTestId('edit-issues-item')).toHaveAttribute('data-key', K(C));
  await expect(detail(page).getByTestId('edit-issues')).toHaveCount(0);
  env.fake.state.w.failLabel = null;
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('edit-issue')).toHaveCount(1);
  // three notices: all shown, nothing folded
  await expect(area(page)).toHaveAttribute('data-count', '3');
  await expect(area(page).getByTestId('notice-more')).toHaveCount(0);

  // ---- 4. a fourth: the newest three show, the oldest folds behind 「还有 1 条」 ----
  await row(page, D).click();
  await refusedClose(page, D);
  await page.keyboard.press('Escape');
  await expect(area(page)).toHaveAttribute('data-count', '4');
  await expect(area(page).getByTestId('op-notice').first()).toHaveAttribute('data-key', K(D));
  await expect(area(page).getByTestId('notice-more')).toHaveText('还有 1 条');
  await expect(inArea(page, A)).toHaveCount(0);
  await shot(page, '488-02-folded');
  await area(page).getByTestId('notice-more').click();
  await expect(inArea(page, A)).toBeVisible();
  await expect(anywhere(page, A)).toHaveCount(1);
  await shot(page, '488-03-all');
  await area(page).getByTestId('notice-more').click();
  await expect(inArea(page, A)).toHaveCount(0);

  // ---- 5. the existing buttons are the same ones: × puts a notice away for good ----
  await inArea(page, D).getByTestId('op-dismiss').click();
  await expect(anywhere(page, D)).toHaveCount(0);
  await expect(area(page)).toHaveAttribute('data-count', '3');
  await expect(inArea(page, A)).toBeVisible();
  await app.close();
});

test('GitHub#488: a new issue GitHub refuses is said in the notice area; 重新打开草稿 brings the dialog back on the board with the draft', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  env.fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
  await page.getByTestId('write-entry').click();
  await page.getByTestId('new-issue-title').fill('被拒的新 issue');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  const refused = area(page).locator('[data-testid="create-bar"][data-status="failed"]');
  await expect(refused).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('create-bar')).toHaveCount(1);
  await expect(page.getByTestId('board-bars').getByTestId('create-bar')).toHaveCount(0);
  env.fake.state.w.readOnlyRepos.delete('gigleai/cavil-loop');
  // from a tab in front: the draft goes back to the board's dialog
  await row(page, A).click({ modifiers: ['Control'] });
  await expect(detail(page)).toHaveAttribute('data-mode', 'tab');
  await expect(refused).toBeVisible();
  await refused.getByTestId('create-fallback').click();
  await expect(page.getByTestId('new-issue-title')).toHaveValue('被拒的新 issue');
  await expect(page.getByTestId('create-bar')).toHaveCount(0);
  await app.close();
});
