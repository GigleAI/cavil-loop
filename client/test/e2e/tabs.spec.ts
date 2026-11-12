// GigleAI/cavil-loop#397: detail tabs. The board is the fixed home tab; every opened issue / PR is
// a tab with a status icon that follows the sync rounds. The real window (built with --test-bridge),
// the real back end behind the loopback bridge, the local fake GitHub.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { findCopies } from '../fake-github/writes';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';

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
/** three recorded open issues */
const A = 139;
const B = 142;
const C = 144;

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  for (const n of [A, B, C]) change(n, { state: 'open', labels: [] });
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(closeEngine);

/** change an item on GitHub (the fake: every copy it holds); its update time moves like GitHub's */
let tick = 0;
function change(n: number, p: { state?: 'open' | 'closed'; labels?: string[]; title?: string }) {
  const c = findCopies(env.fake.state, REPO, n)!;
  const when = new Date(Date.now() + ++tick * 1000).toISOString();
  for (const r of c.rest) {
    if (p.state) {
      r.state = p.state;
      r.state_reason = p.state === 'closed' ? 'completed' : null;
    }
    if (p.labels) r.labels = p.labels.map((name) => ({ name, color: 'ededed' }));
    if (p.title) r.title = p.title;
    r.updated_at = when;
  }
  for (const g of c.gql) {
    if (p.state) {
      g.state = p.state === 'open' ? 'OPEN' : 'CLOSED';
      g.stateReason = p.state === 'closed' ? 'COMPLETED' : null;
    }
    if (p.labels) g.labels = { nodes: p.labels.map((name) => ({ name, color: 'ededed' })) };
    if (p.title) g.title = p.title;
    g.updatedAt = when;
  }
}

async function signIn(page: Page, sources: string[] = [PROJECT_URL, REPO]) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  for (const s of sources) {
    await page.getByTestId('source-input').fill(s);
    await page.getByTestId('source-add').click();
  }
  await page.getByTestId('back').click();
  // one layout for every test: the table, every item of the repository a row
  await page.keyboard.press('Control+2');
  await expect(row(page, A)).toBeVisible({ timeout: 20_000 });
}

const row = (page: Page, n: number) => page.locator(`[data-testid="row"][data-key="${K(n)}"] [data-testid="title-cell"]`).first();
const tab = (page: Page, n: number) => page.locator(`[data-testid="tab"][data-key="${K(n)}"]`);
const tabs = (page: Page) => page.getByTestId('tab');
const home = (page: Page) => page.getByTestId('tab-home');
const detail = (page: Page) => page.getByTestId('detail');
const order = (page: Page) => page.$$eval('[data-testid="tab"]', (els) => els.map((e) => Number(e.getAttribute('data-key')!.split('#')[1])));
/** the detail reads of one item that reached the fake */
const detailReads = (n: number) => env.fake.log.filter((l) => l.operation === 'CavilItemDetail' && l.variables?.number === n).length;
const itemReads = (n: number) => env.fake.log.filter((l) => l.operation === 'CavilItemRefresh' && l.variables?.number === n).length;
/** one sync round, the way the shell's beat starts it */
const beat = (app: RunningApp) => app.desktop.push({ kind: 'tick' });

test('the board is the fixed home tab; an item opens in its own tab — once, in front or in the background; tabs close by ×, the key and the shell', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);

  // only the home tab at first: in front, and it cannot be closed
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  await expect(home(page).getByTestId('tab-close')).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(0);
  await shot(page, '397-01-home-no-tabs');

  // a click opens the item's tab and brings it to the front: the detail fills the window, the board is behind it
  await row(page, A).click();
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await expect(page.getByTestId('board')).not.toBeVisible();
  await expect(home(page)).toHaveAttribute('data-front', 'no');
  const box = (await detail(page).boundingBox())!;
  const win = page.viewportSize()!;
  expect(box.width).toBeGreaterThan(win.width - 2);
  await shot(page, '397-02-detail-tab');

  // back to the home tab: the tab stays, the board is there again (the table as it was)
  await home(page).click();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(detail(page)).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
  // the same item again: its tab, not a second one
  await row(page, A).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');

  // ⌘ / Ctrl + click and the middle button open in the background: home stays in front
  await home(page).click();
  await row(page, B).click({ modifiers: ['Control'] });
  await expect(tab(page, B)).toHaveAttribute('data-front', 'no');
  await row(page, C).click({ button: 'middle' });
  await expect(tab(page, C)).toHaveAttribute('data-front', 'no');
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  expect(await order(page)).toEqual([A, B, C]);
  await shot(page, '397-03-home-with-tabs');

  // a click on a tab brings it to the front; the keys go round, home included
  await tab(page, B).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(B));
  await page.keyboard.press('Control+Shift+BracketRight');
  await expect(tab(page, C)).toHaveAttribute('data-front', 'yes');
  await page.keyboard.press('Control+Shift+BracketRight');
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  await page.keyboard.press('Control+Shift+BracketLeft');
  await expect(tab(page, C)).toHaveAttribute('data-front', 'yes');
  await page.keyboard.press('Control+Shift+BracketLeft');
  await expect(tab(page, B)).toHaveAttribute('data-front', 'yes');

  // a tab dragged onto another's place takes it
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await tab(page, C).dispatchEvent('dragstart', { dataTransfer: dt });
  await tab(page, A).dispatchEvent('dragover', { dataTransfer: dt });
  await tab(page, A).dispatchEvent('drop', { dataTransfer: dt });
  await expect.poll(() => order(page)).toEqual([C, A, B]);

  // the key closes the tab in front; its neighbour comes forward
  await page.keyboard.press('Control+w');
  await expect(tab(page, B)).toHaveCount(0);
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');
  // the × of a tab that is not in front closes that one; the one in front stays
  await tab(page, C).getByTestId('tab-close').click();
  await expect(tab(page, C)).toHaveCount(0);
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');
  await expect(detail(page)).toHaveAttribute('data-key', K(A));

  // Esc: back home, the tab stays
  await detail(page).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  await expect(tabs(page)).toHaveCount(1);
  // on the home tab the key closes nothing
  await page.keyboard.press('Control+w');
  await expect(tabs(page)).toHaveCount(1);
  expect(app.desktop.records.filter((r) => r.op === 'closeWindow')).toHaveLength(0);

  // the shell's close key (macOS: the menu's ⌘W): the tab in front — or, none in front, the window as before
  await tab(page, A).click();
  app.desktop.push({ kind: 'closeTab' });
  await expect(tabs(page)).toHaveCount(0);
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  expect(app.desktop.records.filter((r) => r.op === 'closeWindow')).toHaveLength(0);
  app.desktop.push({ kind: 'closeTab' });
  await expect.poll(() => app.desktop.records.filter((r) => r.op === 'closeWindow').length).toBe(1);

  // a clicked notification opens that item's tab, in front
  app.desktop.push({ kind: 'open', key: K(B), url: `https://github.com/${REPO}/issues/${B}` });
  await expect(tab(page, B)).toHaveAttribute('data-front', 'yes');
  await expect(detail(page)).toHaveAttribute('data-key', K(B));

  // the board's cards open tabs the same way: the middle button, in the background
  await home(page).click();
  await page.keyboard.press('Control+1');
  await expect(page.locator('[data-testid="column"]').first()).toBeVisible({ timeout: 15_000 });
  if ((await page.locator('[data-testid="card"]').count()) === 0) await page.getByTestId('ended-group').click();
  const card = page.locator('[data-testid="card"]').first();
  const cardKey = (await card.getAttribute('data-key'))!;
  const had = await tabs(page).count();
  const wasOpen = (await page.locator(`[data-testid="tab"][data-key="${cardKey}"]`).count()) > 0;
  await card.click({ button: 'middle', position: { x: 6, y: 6 } });
  await expect(page.locator(`[data-testid="tab"][data-key="${cardKey}"]`)).toHaveCount(1);
  await expect(tabs(page)).toHaveCount(wasOpen ? had : had + 1);
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  await app.close();
});

test('more tabs than fit: the strip scrolls sideways, the home tab stays put, and the tab in front is brought into view', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  for (const n of [A, B, C]) await row(page, n).click({ modifiers: ['Control'] });
  await expect(tabs(page)).toHaveCount(3);
  await page.setViewportSize({ width: 340, height: 700 });
  const strip = page.getByTestId('tab-strip');
  expect(await strip.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  // the bar itself stays as wide as the window: only the strip inside it scrolls
  expect(await page.getByTestId('tabs').evaluate((e) => e.scrollWidth <= e.clientWidth && e.getBoundingClientRect().right <= window.innerWidth + 0.5)).toBe(true);
  const inStrip = async (n: number) => {
    const s = (await strip.boundingBox())!;
    const t = (await tab(page, n).boundingBox())!;
    return t.x >= s.x - 0.5 && t.x + t.width <= s.x + s.width + 0.5;
  };
  expect(await inStrip(C)).toBe(false);
  // the keys go to the last tab: it is scrolled into view; home has not moved
  const homeBox = await home(page).boundingBox();
  await page.keyboard.press('Control+Shift+BracketLeft');
  await expect(tab(page, C)).toHaveAttribute('data-front', 'yes');
  await expect.poll(() => inStrip(C)).toBe(true);
  expect(await home(page).boundingBox()).toEqual(homeBox);
  await page.keyboard.press('Control+Shift+BracketRight');
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  await page.keyboard.press('Control+Shift+BracketRight');
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');
  await expect.poll(() => inStrip(A)).toBe(true);
  await shot(page, '397-08-many-tabs-narrow');
  await app.close();
});

test('text that was not sent stays with its tab; closing such a tab asks first', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  await row(page, A).click();
  await detail(page).getByTestId('reply-input').fill('half a reply');
  await home(page).click();
  await row(page, B).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(B));
  await expect(detail(page).getByTestId('reply-input')).toHaveValue('');
  await tab(page, A).click();
  await expect(detail(page).getByTestId('reply-input')).toHaveValue('half a reply');

  // the × (from another tab, too) asks; "cancel" keeps tab and text
  await tab(page, B).click();
  await tab(page, A).getByTestId('tab-close').click();
  await expect(page.getByTestId('tab-close-question')).toBeVisible();
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');
  await page.getByTestId('confirm-cancel').click();
  await expect(tab(page, A)).toHaveCount(1);
  await expect(detail(page).getByTestId('reply-input')).toHaveValue('half a reply');
  // the key asks as well; confirming closes
  await detail(page).getByTestId('reply-input').blur();
  await page.keyboard.press('Control+w');
  await expect(page.getByTestId('tab-close-question')).toBeVisible();
  await page.getByTestId('confirm-ok').click();
  await expect(tab(page, A)).toHaveCount(0);
  // opened again: a fresh tab, the dropped text does not come back
  await home(page).click();
  await row(page, A).click();
  await expect(detail(page).getByTestId('reply-input')).toHaveValue('');
  // a tab with nothing typed closes at once
  await tab(page, B).getByTestId('tab-close').click();
  await expect(tab(page, B)).toHaveCount(0);
  await expect(page.getByTestId('tab-close-question')).toHaveCount(0);
  await app.close();
});

test('the status icon follows the sync rounds; a tab behind shows a dot when its item changed, and reads its detail only when it comes forward', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  await row(page, A).click();
  await expect(detail(page).getByTestId('reply-input')).toBeVisible();
  await home(page).click();
  await row(page, B).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(B));
  // A was looked at and is behind now; B is in front
  await expect(tab(page, A)).toHaveAttribute('data-status', 'open');
  await expect(tab(page, A)).toHaveAttribute('data-unread', 'no');
  const readsA = detailReads(A);
  expect(readsA).toBeGreaterThan(0);

  change(A, { labels: ['doing/agent'] });
  beat(app);
  await expect(tab(page, A)).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
  await expect(tab(page, A)).toHaveAttribute('data-unread', 'yes');
  await expect(tab(page, A).getByTestId('tab-dot')).toBeVisible();
  await shot(page, '397-04-running-and-dot');
  // the round changed the icon, and the detail of a tab that is behind was not read
  await page.waitForTimeout(400);
  expect(detailReads(A)).toBe(readsA);
  change(A, { labels: ['pending/human'] });
  beat(app);
  await expect(tab(page, A)).toHaveAttribute('data-status', 'waiting', { timeout: 15_000 });
  await shot(page, '397-05-waiting');
  // (a new "waiting for a human" is a notification, and the app reads that item's detail ahead of the click — GitHub#328;
  // that read is the reminder's, counted apart)
  await page.waitForTimeout(400);
  const readsA2 = detailReads(A);
  change(A, { state: 'closed', title: 'closed while its tab was behind' });
  beat(app);
  await expect(tab(page, A)).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await expect(tab(page, A).getByTestId('tab-title')).toHaveText('closed while its tab was behind');
  await shot(page, '397-06-closed');
  await page.waitForTimeout(400);
  expect(detailReads(A)).toBe(readsA2);
  // the rounds brought the icon: the item's own check was never needed
  expect(itemReads(A)).toBe(0);
  // the tab in front never shows the dot, whatever changes
  change(B, { labels: ['doing/agent'] });
  beat(app);
  await expect(tab(page, B)).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
  await expect(tab(page, B)).toHaveAttribute('data-unread', 'no');

  // forward: the detail is read now, and the dot goes
  await tab(page, A).click();
  await expect(tab(page, A)).toHaveAttribute('data-unread', 'no');
  await expect.poll(() => detailReads(A)).toBeGreaterThan(readsA2);
  await expect(detail(page).getByTestId('detail-title')).toContainText('closed while its tab was behind');
  await app.close();
});

test('an item no source lists any more: its tab still follows GitHub (closed, reopened), and its detail still opens', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page, [REPO]);
  await row(page, A).click();
  await expect(detail(page).getByTestId('reply-input')).toBeVisible();
  await home(page).click();
  await expect(tab(page, A)).toHaveAttribute('data-listed', 'yes');

  // the repository's list cannot be read any more: the board keeps its copy, which is no news of the item
  env.fake.state.failRepoPage.set('gigleai/cavil-loop', 1);
  change(A, { state: 'closed' });
  beat(app);
  await expect(tab(page, A)).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  await expect(tab(page, A)).toHaveAttribute('data-listed', 'no');
  expect(itemReads(A)).toBeGreaterThan(0);
  // the board's own copy is still the open one: only the tab knows
  await expect(page.locator(`[data-testid="row"][data-key="${K(A)}"] [data-testid="row-state"]`).first()).toHaveAttribute('data-tone', 'open');

  // reopened and handed to an agent on GitHub: coming forward checks it at once (no ten minutes to wait)
  change(A, { state: 'open', labels: ['doing/agent'] });
  await tab(page, A).click();
  await expect(tab(page, A)).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await expect(detail(page).getByTestId('reply-input')).toBeVisible();
  await app.close();
});

test('settings: the "running" label (GitHub#404) is the one a tab\'s status reads — changed or emptied there, the tabs follow', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  change(A, { labels: ['wip'] });
  change(B, { labels: ['doing/agent'] });
  await row(page, A).click({ modifiers: ['Control'] });
  await row(page, B).click({ modifiers: ['Control'] });
  beat(app);
  await expect(tab(page, B)).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
  await expect(tab(page, A)).toHaveAttribute('data-status', 'open');

  await page.getByTestId('open-settings').click();
  // the tab bar stays above the settings page
  await expect(tabs(page)).toHaveCount(2);
  const field = page.getByTestId('hand-back-running');
  await expect(field).toHaveValue('doing/agent');
  await field.scrollIntoViewIfNeeded();
  await shot(page, '397-07-settings-running-label');
  await field.fill('wip');
  await field.blur();
  await expect(tab(page, A)).toHaveAttribute('data-status', 'running');
  await expect(tab(page, B)).toHaveAttribute('data-status', 'open');
  await field.fill('');
  await field.blur();
  await expect(tab(page, A)).toHaveAttribute('data-status', 'open');
  await expect(tab(page, B)).toHaveAttribute('data-status', 'open');
  await app.close();
});

test('the tabs are kept on this machine: a restart brings them back behind the home tab; signing out drops them', async () => {
  let app = await launchApp(env);
  let page = app.page;
  await signIn(page);
  await row(page, B).click({ modifiers: ['Control'] });
  await row(page, A).click();
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');
  expect(await order(page)).toEqual([B, A]);
  // (the list is written to the back end right after the click; the test's "quit" kills the back end outright)
  await page.waitForTimeout(500);
  await app.close();

  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await expect(tabs(page)).toHaveCount(2);
  expect(await order(page)).toEqual([B, A]);
  // it starts on the home tab; a tab reads its detail when it is clicked
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  await expect(detail(page)).toHaveCount(0);
  const before = detailReads(B);
  await tab(page, B).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(B));
  await expect.poll(() => detailReads(B)).toBeGreaterThan(before);

  // signing out: the tabs were that account's
  await page.keyboard.press('Control+,');
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('start-login')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('tabs')).toHaveCount(0);
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  // signed in again (the window is still on the settings page it was signed out from)
  await page.getByTestId('back').click();
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  await expect(tabs(page)).toHaveCount(0);
  await app.close();
});
