// GigleAI/cavil-loop#522: opening an item takes back its own notifications (never another item's), and the
// board / table brings the item the floating panel shows into view — once per opening — and marks it.
// The real window (built with --test-bridge), the real back end behind the loopback bridge, the local fake
// GitHub; the shell's side is the bridge's record of what the window asked of it.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { findCopies } from '../fake-github/writes';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';

const screens = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-results', 'screens');
mkdirSync(screens, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
/** three recorded open issues */
const A = 139;
const B = 142;
const C = 144;

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  for (const n of [A, B, C]) {
    const c = findCopies(env.fake.state, REPO, n)!;
    for (const r of c.rest) r.state = 'open';
    for (const g of c.gql) g.state = 'OPEN';
  }
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(closeEngine);

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
const tab = (page: Page, n: number) => page.locator(`[data-testid="tab"][data-key="${K(n)}"]`);
const detail = (page: Page) => page.getByTestId('detail');
const marked = (page: Page) => page.locator('[data-open-item="yes"]');
/** the keys whose notifications the window asked the shell to take back, in order */
const cleared = (app: RunningApp) => app.desktop.records.filter((r) => r.op === 'clearItemNotifications').map((r) => r.key as string);
const clearedAll = (app: RunningApp) => app.desktop.records.filter((r) => r.op === 'clearNotifications').length;

/** the board by status (the recorded iterations have ended), with every card shown */
async function boardByStatus(page: Page) {
  await page.keyboard.press('Control+Shift+1');
  await page.getByTestId('mode').selectOption('status');
  await expect(page.locator('[data-testid="card"]').first()).toBeVisible({ timeout: 15_000 });
}

/** inside the board's visible part, left of the floating panel (`gap` px of slack) */
async function inViewBesidePanel(page: Page, el: Locator) {
  const box = (await el.boundingBox())!;
  const board = (await page.locator('.board').boundingBox())!;
  const panel = (await detail(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(board.x - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(panel.x + 1);
  expect(box.y).toBeGreaterThanOrEqual(board.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(board.y + board.height + 1);
}

test('GitHub#522: opening an item takes back its own notifications only — panel, notification, tab in front; a tab opened behind only once in front; never while the window is behind', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  // the window behind: an opening is not a look
  app.desktop.push({ kind: 'inactive' });
  await row(page, A).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await page.waitForTimeout(300);
  expect(cleared(app)).toEqual([]);
  // the window comes to the front with A in the panel: A's are taken back, nothing else
  app.desktop.push({ kind: 'active' });
  await expect.poll(() => cleared(app)).toEqual([K(A)]);

  // a plain click on another row: the panel shows B — B's, only
  await row(page, B).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(B));
  await expect.poll(() => cleared(app)).toEqual([K(A), K(B)]);

  // a tab opened in the background (the middle button) is not looked at yet …
  await row(page, C).click({ button: 'middle' });
  await expect(tab(page, C)).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(cleared(app)).toEqual([K(A), K(B)]);
  // … until it comes to the front
  await tab(page, C).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(C));
  await expect.poll(() => cleared(app)).toEqual([K(A), K(B), K(C)]);

  // a clicked notification about A (C's tab in front): the panel over the board shows A — A's again
  app.desktop.push({ kind: 'open', key: K(A), url: url(A) });
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await expect(detail(page)).toHaveAttribute('data-mode', 'float');
  await expect.poll(() => cleared(app)).toEqual([K(A), K(B), K(C), K(A)]);
  // the same item's notification once more: a new opening, taken back again
  app.desktop.push({ kind: 'open', key: K(A), url: url(A) });
  await expect.poll(() => cleared(app)).toEqual([K(A), K(B), K(C), K(A), K(A)]);
  // never all of them ("切到 App 时收起全部系统通知" is not ticked)
  expect(clearedAll(app)).toBe(0);
  await app.close();
});

test('GitHub#522: the item the floating panel shows is marked and brought into view left of the panel — once per opening, also when opened from a notification; the mark follows the panel', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await page.setViewportSize({ width: 1100, height: 640 });
  await signIn(page);
  await boardByStatus(page);
  const cards = page.locator('[data-testid="card"]');
  // the board scrolled away from the first column's top card: right and down as far as it goes
  const first = cards.first();
  const firstKey = (await first.getAttribute('data-key'))!;
  const away = () => page.evaluate(() => {
    const b = document.querySelector('.board')!;
    b.scrollLeft = b.scrollWidth;
    b.scrollTop = b.scrollHeight;
    return b.scrollLeft;
  });
  expect(await away()).toBeGreaterThan(0);
  // its notification is clicked: the panel opens on it, the card is marked and in view beside the panel
  app.desktop.push({ kind: 'open', key: firstKey, url: `https://github.com/${firstKey.replace('#', '/issues/')}` });
  await expect(detail(page)).toHaveAttribute('data-key', firstKey);
  await expect(marked(page)).toHaveCount(1);
  await expect(marked(page)).toHaveAttribute('data-key', firstKey);
  await expect(marked(page)).toHaveClass(/open-item/);
  await inViewBesidePanel(page, marked(page));
  await shot(page, '522-01-board-from-notification');

  // the user scrolls away; a sync round comes and goes: the board is not pulled back
  const left = await away();
  await expect(page.getByTestId('refresh')).toHaveAttribute('data-syncing', 'no', { timeout: 30_000 });
  app.desktop.push({ kind: 'tick' });
  await expect(page.getByTestId('refresh')).toHaveAttribute('data-syncing', 'no', { timeout: 30_000 });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.querySelector('.board')!.scrollLeft)).toBe(left);
  await expect(marked(page)).toHaveAttribute('data-key', firstKey);

  // the last card of the board (right, under the panel): a click on it would not reach it — its notification
  // does, and it comes out from under the panel
  await page.evaluate(() => {
    const b = document.querySelector('.board')!;
    b.scrollLeft = 0;
    b.scrollTop = 0;
  });
  const last = cards.last();
  const lastKey = (await last.getAttribute('data-key'))!;
  app.desktop.push({ kind: 'open', key: lastKey, url: `https://github.com/${lastKey.replace('#', '/issues/')}` });
  await expect(detail(page)).toHaveAttribute('data-key', lastKey);
  await expect(marked(page)).toHaveCount(1);
  await expect(marked(page)).toHaveAttribute('data-key', lastKey);
  await inViewBesidePanel(page, marked(page));

  // a plain click on another visible card: the mark moves, nothing scrolls (it is in view already)
  const other = page.locator(`[data-testid="card"]:not([data-key="${lastKey}"])`).first();
  await other.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => [document.querySelector('.board')!.scrollLeft, document.querySelector('.board')!.scrollTop]);
  const otherKey = (await other.getAttribute('data-key'))!;
  await other.click({ position: { x: 6, y: 6 } });
  await expect(detail(page)).toHaveAttribute('data-key', otherKey);
  await expect(marked(page)).toHaveAttribute('data-key', otherKey);
  expect(await page.evaluate(() => [document.querySelector('.board')!.scrollLeft, document.querySelector('.board')!.scrollTop])).toEqual(before);

  // the table shows the same item's row marked
  await page.keyboard.press('Control+Shift+2');
  await expect(page.locator(`[data-testid="row"][data-key="${otherKey}"]`).first()).toHaveAttribute('data-open-item', 'yes');
  await expect(page.locator('tr[data-open-item="yes"]')).toHaveCount(1);
  await shot(page, '522-02-table');
  // the panel put away: no mark anywhere
  await page.keyboard.press('Escape');
  await expect(detail(page)).toHaveCount(0);
  await expect(marked(page)).toHaveCount(0);
  await app.close();
});

test('GitHub#522: in the table, a row out of view is scrolled to; in a folded group nothing unfolds — it is brought into view once it is drawn (here: on the board); a PR shown under its issue is the only one marked', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await page.setViewportSize({ width: 1100, height: 520 });
  await signIn(page);
  const rows = page.locator('[data-testid="row"]');
  const scroller = () => page.evaluate(() => {
    let el: HTMLElement | null = document.querySelector('[data-testid="row"]');
    while (el && !(el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    return el ? { top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom } : null;
  });
  // the last row, out of view below: its notification scrolls the table to it
  const last = rows.last();
  const lastKey = (await last.getAttribute('data-key'))!;
  const box0 = (await last.boundingBox())!;
  const area = (await scroller())!;
  expect(box0.y).toBeGreaterThan(area.bottom);
  app.desktop.push({ kind: 'open', key: lastKey, url: `https://github.com/${lastKey.replace('#', '/issues/')}` });
  await expect(detail(page)).toHaveAttribute('data-key', lastKey);
  await expect(marked(page)).toHaveAttribute('data-key', lastKey);
  const box1 = (await marked(page).boundingBox())!;
  expect(box1.y).toBeGreaterThanOrEqual(area.top - 1);
  expect(box1.y + box1.height).toBeLessThanOrEqual(area.bottom + 1);
  await page.keyboard.press('Escape');
  await expect(detail(page)).toHaveCount(0);

  // a PR shown under its issue (the recording links some): opened, only its own row is marked
  const nested = page.locator('[data-testid="row"][data-under]').first();
  if ((await nested.count()) > 0) {
    const prKey = (await nested.getAttribute('data-key'))!;
    await nested.locator('[data-testid="title-cell"]').click();
    await expect(detail(page)).toHaveAttribute('data-key', prKey);
    await expect(marked(page)).toHaveCount(1);
    await expect(marked(page)).toHaveAttribute('data-key', prKey);
    await page.keyboard.press('Escape');
    await expect(detail(page)).toHaveCount(0);
  }

  // A's group folded: its notification opens the panel, nothing unfolds, nothing is marked …
  const groupKey = (await page.locator('tbody[data-testid="group"]', { has: page.locator(`[data-testid="row"][data-key="${K(A)}"]`) }).first().getAttribute('data-key'))!;
  const groupOfA = page.locator(`tbody[data-testid="group"][data-key="${groupKey}"] [data-testid="group-head"]`);
  await groupOfA.click();
  await expect(page.locator(`[data-testid="row"][data-key="${K(A)}"]`)).toHaveCount(0);
  app.desktop.push({ kind: 'open', key: K(A), url: url(A) });
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await page.waitForTimeout(300);
  await expect(page.locator(`[data-testid="row"][data-key="${K(A)}"]`)).toHaveCount(0);
  await expect(marked(page)).toHaveCount(0);
  // … the board (the panel stays open): A's card is drawn there — marked and brought into view beside the panel
  // (an opening whose item was not drawn yet is brought into view the first time it is)
  await page.keyboard.press('Control+Shift+1');
  await expect(page.locator(`[data-testid="card"][data-key="${K(A)}"]`)).toHaveAttribute('data-open-item', 'yes', { timeout: 15_000 });
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await inViewBesidePanel(page, marked(page));
  await app.close();
});
