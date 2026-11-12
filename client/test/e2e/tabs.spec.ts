// GigleAI/cavil-loop#397: detail tabs (GitHub#442: a plain click opens the floating panel, ⌘ / Ctrl + click a tab). The board is the fixed home tab; every opened issue / PR is
// a tab with a status icon that follows the sync rounds. The real window (built with --test-bridge),
// the real back end behind the loopback bridge, the local fake GitHub.

import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { findCopies, pullOf } from '../fake-github/writes';
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
  await page.keyboard.press('Control+Shift+2');
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
/** the addresses the window asked the system to open */
const readOpened = () => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '');
/** one sync round, the way the shell's beat starts it */
const beat = (app: RunningApp) => app.desktop.push({ kind: 'tick' });

test('GitHub#442: a click opens the floating panel, ⌘ / Ctrl + click or the right-click menu a tab; the tab bar shows only once a tab is open; ⌘1 … ⌘9 pick a tab; tabs close by ×, the key and the shell', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  const bar = page.getByTestId('tabs');
  const menu = page.getByTestId('open-menu');

  // no tab open: no tab bar at all
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId('board')).toBeVisible();
  await shot(page, '442-01-no-tabs-no-bar');

  // a plain click: the floating panel over the board, still no tab bar
  await row(page, A).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await expect(detail(page)).toHaveAttribute('data-mode', 'float');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(bar).toHaveCount(0);
  const fbox = (await detail(page).boundingBox())!;
  expect(fbox.width).toBeLessThan(page.viewportSize()!.width - 100);
  await shot(page, '442-02-float');
  // another row switches the panel to that item
  await row(page, B).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(B));
  await expect(detail(page)).toHaveAttribute('data-mode', 'float');
  // Esc puts it away
  await detail(page).click({ position: { x: 20, y: 5 } });
  await page.keyboard.press('Escape');
  await expect(detail(page)).toHaveCount(0);

  // ⌘ / Ctrl + click: the item's tab, in front — the bar appears, the detail fills the window
  await row(page, A).click({ modifiers: ['Control'] });
  await expect(bar).toBeVisible();
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await expect(detail(page)).toHaveAttribute('data-mode', 'tab');
  await expect(page.getByTestId('board')).not.toBeVisible();
  await expect(home(page)).toHaveAttribute('data-front', 'no');
  await expect(home(page).getByTestId('tab-close')).toHaveCount(0);
  const box = (await detail(page).boundingBox())!;
  expect(box.width).toBeGreaterThan(page.viewportSize()!.width - 2);
  await shot(page, '442-03-detail-tab');

  // back home: the tab stays; a plain click on an item that has a tab goes to that tab (no panel)
  await home(page).click();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(detail(page)).toHaveCount(0);
  await row(page, A).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');
  await expect(detail(page)).toHaveAttribute('data-mode', 'tab');

  // the middle button: a tab behind; the right-click menu: in the background too — home stays in front
  await home(page).click();
  await row(page, B).click({ button: 'middle' });
  await expect(tab(page, B)).toHaveAttribute('data-front', 'no');
  await row(page, C).click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('data-key', K(C));
  await shot(page, '442-04-menu');
  await menu.getByTestId('open-menu-back').click();
  await expect(menu).toHaveCount(0);
  await expect(tab(page, C)).toHaveAttribute('data-front', 'no');
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  expect(await order(page)).toEqual([A, B, C]);
  // the menu's other entries: the panel, and GitHub
  await row(page, C).click({ button: 'right' });
  await menu.getByTestId('open-menu-web').click();
  await expect.poll(() => readOpened()).toContain(`https://github.com/${REPO}/issues/${C}`);
  await row(page, B).click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // the running icon is a still one (GitHub#442: a spinner read as "still loading")
  change(A, { labels: ['doing/agent'] });
  beat(app);
  await expect(tab(page, A)).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
  const icon = tab(page, A).locator('.tab-icon.running');
  await expect(icon).toHaveAttribute('data-icon', 'robot');
  expect(await icon.evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
  await shot(page, '442-05-home-with-tabs');

  // ⌘1 … ⌘9: ⌘1 is home, ⌘N the (N-1)th tab, ⌘9 the last one; past the last tab nothing moves
  await page.keyboard.press('Control+3');
  await expect(tab(page, B)).toHaveAttribute('data-front', 'yes');
  await page.keyboard.press('Control+1');
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  await page.keyboard.press('Control+9');
  await expect(tab(page, C)).toHaveAttribute('data-front', 'yes');
  await page.keyboard.press('Control+2');
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');
  await page.keyboard.press('Control+6');
  await page.waitForTimeout(200);
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');
  // ⌘1 … ⌘9 no longer switch the layout: the table stays the home tab's layout
  await page.keyboard.press('Control+1');
  await expect(page.getByTestId('table')).toBeVisible();

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

  // Esc in a tab: back home, the tab stays
  await detail(page).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  await expect(tabs(page)).toHaveCount(1);
  // on the home tab with no panel the key closes nothing
  await page.keyboard.press('Control+w');
  await expect(tabs(page)).toHaveCount(1);
  // with the panel open over the board, the key puts the panel away (the tab stays)
  await row(page, B).click();
  await expect(detail(page)).toHaveAttribute('data-mode', 'float');
  await page.keyboard.press('Control+w');
  await expect(detail(page)).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
  expect(app.desktop.records.filter((r) => r.op === 'closeWindow')).toHaveLength(0);

  // the shell's close key (macOS: the menu's ⌘W): the tab in front — the last one gone, the bar goes;
  // then the panel; then, nothing in front, the window as before
  await tab(page, A).click();
  app.desktop.push({ kind: 'closeTab' });
  await expect(tabs(page)).toHaveCount(0);
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId('board')).toBeVisible();
  await row(page, B).click();
  await expect(detail(page)).toHaveAttribute('data-mode', 'float');
  app.desktop.push({ kind: 'closeTab' });
  await expect(detail(page)).toHaveCount(0);
  expect(app.desktop.records.filter((r) => r.op === 'closeWindow')).toHaveLength(0);
  app.desktop.push({ kind: 'closeTab' });
  await expect.poll(() => app.desktop.records.filter((r) => r.op === 'closeWindow').length).toBe(1);

  // a clicked notification opens that item the way a click does: the panel, no tab
  app.desktop.push({ kind: 'open', key: K(B), url: `https://github.com/${REPO}/issues/${B}` });
  await expect(detail(page)).toHaveAttribute('data-key', K(B));
  await expect(detail(page)).toHaveAttribute('data-mode', 'float');
  await expect(bar).toHaveCount(0);

  // the board's cards: a click, the panel; the middle button, a tab in the background
  await page.keyboard.press('Control+Shift+1');
  await expect(page.locator('[data-testid="column"]').first()).toBeVisible({ timeout: 15_000 });
  if ((await page.locator('[data-testid="card"]').count()) === 0) await page.getByTestId('ended-group').click();
  const card = page.locator('[data-testid="card"]').first();
  const cardKey = (await card.getAttribute('data-key'))!;
  await card.click({ position: { x: 6, y: 6 } });
  await expect(detail(page)).toHaveAttribute('data-key', cardKey);
  await expect(detail(page)).toHaveAttribute('data-mode', 'float');
  await card.click({ button: 'middle', position: { x: 6, y: 6 } });
  await expect(page.locator(`[data-testid="tab"][data-key="${cardKey}"]`)).toHaveCount(1);
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  // the panel showed that item: it moved into the tab
  await expect(detail(page)).toHaveCount(0);
  await app.close();
});

test('GitHub#442: the floating panel belongs to the home tab — a tab and back finds it with its text; ⌘ + click moves it into a tab with its text; a click outside puts it away, never with text typed', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  await row(page, B).click({ button: 'middle' });
  await expect(tabs(page)).toHaveCount(1);
  await row(page, A).click();
  await expect(detail(page)).toHaveAttribute('data-mode', 'float');
  await detail(page).getByTestId('reply-input').fill('浮窗里的半句话');

  // a click outside (on the board) leaves a panel holding text
  await page.mouse.click(30, page.viewportSize()!.height - 20);
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  // Esc neither: it says why
  await detail(page).click({ position: { x: 20, y: 5 } });
  await page.keyboard.press('Escape');
  await expect(detail(page).getByTestId('draft-esc-hint')).toBeVisible();
  await expect(detail(page)).toHaveAttribute('data-key', K(A));

  // to a tab and back: the panel is there again, with its text
  await tab(page, B).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(B));
  await expect(detail(page)).toHaveAttribute('data-mode', 'tab');
  await home(page).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await expect(detail(page)).toHaveAttribute('data-mode', 'float');
  await expect(detail(page).getByTestId('reply-input')).toHaveValue('浮窗里的半句话');

  // ⌘W asks before dropping the text; cancelled, the panel stays
  await detail(page).click({ position: { x: 20, y: 5 } });
  await page.keyboard.press('Control+w');
  await expect(page.getByTestId('tab-close-question')).toBeVisible();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: '取消' }).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(A));

  // ⌘ + click on the item the panel shows: the panel goes, the tab has the text
  await row(page, A).click({ modifiers: ['Control'] });
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');
  await expect(detail(page)).toHaveAttribute('data-mode', 'tab');
  await expect(detail(page).getByTestId('reply-input')).toHaveValue('浮窗里的半句话');
  await home(page).click();
  await expect(detail(page)).toHaveCount(0);

  // with no text, a click outside the panel puts it away; a click on the tab bar does not
  await row(page, C).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(C));
  await home(page).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(C));
  await page.mouse.click(30, page.viewportSize()!.height - 20);
  await expect(detail(page)).toHaveCount(0);
  await app.close();
});

test('GitHub#442: ⌘R in a detail tab reads that item again — from the detail, the reply box and the discussion; a digit in the discussion goes by its key position, as in the window', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  await row(page, B).click({ button: 'middle' });
  await row(page, A).click({ modifiers: ['Control'] });
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  const frameEl = page.getByTestId('timeline-frame');
  await expect(frameEl).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  // nothing changed on GitHub: a sync round alone would not read the detail again (its update time did not move)
  const settle = async () => {
    await expect(detail(page).getByTestId('detail-refresh')).toHaveAttribute('data-loading', 'no');
    await page.waitForTimeout(300);
  };
  await settle();

  // the detail's own blank space
  let before = detailReads(A);
  await detail(page).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+r');
  await expect.poll(() => detailReads(A)).toBeGreaterThan(before);
  await settle();
  // the reply box (a ⌘ key is never typing)
  before = detailReads(A);
  await detail(page).getByTestId('reply-input').click();
  await page.keyboard.press('Control+r');
  await expect.poll(() => detailReads(A)).toBeGreaterThan(before);
  await settle();
  // the isolated discussion: its script passes ⌘R on
  before = detailReads(A);
  await frame.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+r');
  await expect.poll(() => detailReads(A)).toBeGreaterThan(before);
  await settle();
  expect(await tabs(page).count()).toBe(2);

  // the home tab keeps "sync now": no detail is mounted, no detail is read
  await home(page).click();
  before = detailReads(A);
  await page.keyboard.press('Control+r');
  await page.waitForTimeout(800);
  expect(detailReads(A)).toBe(before);

  // ⌘1 as a French layout reports it ("&", the Digit1 key): the window and the discussion agree
  const french = { key: '&', code: 'Digit1', ctrlKey: true, shiftKey: false, bubbles: true, cancelable: true };
  await tab(page, A).click();
  await expect(frameEl).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  await page.evaluate((ev) => window.dispatchEvent(new KeyboardEvent('keydown', ev)), french);
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  await tab(page, A).click();
  await expect(frameEl).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  await frame.locator('body').evaluate((b, ev) => b.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', ev)), french);
  await expect(home(page)).toHaveAttribute('data-front', 'yes');
  // a digit that needs Shift on that layout (⌘⇧3 reported as "3" with Digit3) still is not a tab key: ⌘⇧3 is the graph
  await tab(page, A).click();
  await expect(frameEl).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  await frame.locator('body').evaluate(
    (b, ev) => b.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', ev)),
    { key: '3', code: 'Digit3', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true },
  );
  await page.waitForTimeout(300);
  await expect(tab(page, A)).toHaveAttribute('data-front', 'yes');
  // the US shape of ⌘2 in the discussion: the first tab (B; the tabs are B, A)
  await frame.locator('body').evaluate(
    (b, ev) => b.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', ev)),
    { key: '2', code: 'Digit2', ctrlKey: true, shiftKey: false, bubbles: true, cancelable: true },
  );
  await expect(tab(page, B)).toHaveAttribute('data-front', 'yes');
  await app.close();
});

test('more tabs than fit: the strip scrolls sideways, the home tab stays put, and the tab in front is brought into view', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  for (const n of [A, B, C]) await row(page, n).click({ button: 'middle' });
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
  await row(page, A).click({ modifiers: ['Control'] });
  await detail(page).getByTestId('reply-input').fill('half a reply');
  await home(page).click();
  await row(page, B).click({ modifiers: ['Control'] });
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
  await row(page, A).click({ modifiers: ['Control'] });
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
  await row(page, A).click({ modifiers: ['Control'] });
  await expect(detail(page).getByTestId('reply-input')).toBeVisible();
  await home(page).click();
  await row(page, B).click({ modifiers: ['Control'] });
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
  await row(page, A).click({ modifiers: ['Control'] });
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

  // its detail agrees with its tab, not with the board's cached copy (code review round 1): badge, close button, labels
  await tab(page, A).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await expect(detail(page).getByTestId('detail-kind')).toHaveAttribute('data-tone', 'done', { timeout: 15_000 });
  await expect(detail(page).getByTestId('close-issue')).toHaveCount(0);
  await home(page).click();

  // reopened and handed to an agent on GitHub: coming forward checks it at once (no ten minutes to wait);
  // the detail's labels and badge follow that check too
  change(A, { state: 'open', labels: ['doing/agent'] });
  await tab(page, A).click();
  await expect(tab(page, A)).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await expect(detail(page).getByTestId('detail-kind')).toHaveAttribute('data-tone', 'open', { timeout: 15_000 });
  await expect(detail(page).locator('[data-testid="detail-label"][data-label="doing/agent"]')).toBeVisible();
  await expect(detail(page).getByTestId('reply-input')).toBeVisible();

  // the list reads again: board, tab and detail say the same, from the board's copy
  env.fake.state.failRepoPage.clear();
  change(A, { state: 'closed', labels: [] });
  // "sync now" (past the failed source's wait): the home tab's ⌘R — in a detail tab ⌘R reads only that item (GitHub#442)
  await home(page).click();
  await page.keyboard.press('Control+r');
  await tab(page, A).click();
  await expect(tab(page, A)).toHaveAttribute('data-listed', 'yes', { timeout: 15_000 });
  await expect(tab(page, A)).toHaveAttribute('data-status', 'done');
  await expect(detail(page).getByTestId('detail-kind')).toHaveAttribute('data-tone', 'done', { timeout: 15_000 });
  await expect(detail(page).locator('[data-testid="detail-label"][data-label="doing/agent"]')).toHaveCount(0);
  await home(page).click();
  await expect(page.locator(`[data-testid="row"][data-key="${K(A)}"] [data-testid="row-state"]`).first()).toHaveAttribute('data-tone', 'done');
  await app.close();
});

test('an unlisted PR whose checks are still running: each own check is a round for its detail — read again until they finish, even though the PR\'s update time never moves', async () => {
  const PR = 146;
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const c = findCopies(store, REPO, PR)!;
  for (const g of c.gql) Object.assign(g, { state: 'OPEN', merged: false });
  for (const r of c.rest) Object.assign(r, { state: 'open', pull_request: { ...(r.pull_request ?? {}), merged_at: null } });
  const pull = pullOf(store, c);
  pull.checks = 'PENDING';
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page, [REPO]);
  await row(page, PR).click({ modifiers: ['Control'] });
  const d = detail(page);
  await expect(d).toHaveAttribute('data-key', K(PR));
  await expect(d.getByTestId('pr-status')).toContainText('检查：进行中', { timeout: 15_000 });
  // the repository's list cannot be read: the PR is checked by itself from now on
  env.fake.state.failRepoPage.set('gigleai/cavil-loop', 1);
  // a sync round (GitHub#442: ⌘R in a detail tab reads only that item now)
  beat(app);
  await expect(tab(page, PR)).toHaveAttribute('data-listed', 'no', { timeout: 15_000 });
  await expect.poll(() => itemReads(PR), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  // still running, nothing on GitHub moved: each check reads the detail again (the GitHub#226 rule)
  const d0 = detailReads(PR);
  const i0 = itemReads(PR);
  // a sync round (GitHub#442: ⌘R in a detail tab reads only that item now)
  beat(app);
  await expect.poll(() => itemReads(PR), { timeout: 15_000 }).toBeGreaterThan(i0);
  await expect.poll(() => detailReads(PR), { timeout: 15_000 }).toBeGreaterThan(d0);
  // the checks finish — the PR's update time stays the same — and the next check shows it, nothing clicked
  pull.checks = 'SUCCESS';
  const i1 = itemReads(PR);
  // a sync round (GitHub#442: ⌘R in a detail tab reads only that item now)
  beat(app);
  await expect.poll(() => itemReads(PR), { timeout: 15_000 }).toBeGreaterThan(i1);
  await expect(d.getByTestId('pr-status')).toContainText('检查：全部通过', { timeout: 15_000 });
  // finished: checks no longer read the detail while nothing changes
  await page.waitForTimeout(500);
  const d2 = detailReads(PR);
  const i2 = itemReads(PR);
  // a sync round (GitHub#442: ⌘R in a detail tab reads only that item now)
  beat(app);
  await expect.poll(() => itemReads(PR), { timeout: 15_000 }).toBeGreaterThan(i2);
  await page.waitForTimeout(800);
  expect(detailReads(PR)).toBe(d2);
  // behind another tab, a check never reads the detail
  await home(page).click();
  pull.checks = 'PENDING';
  const i3 = itemReads(PR);
  // a sync round (GitHub#442: ⌘R in a detail tab reads only that item now)
  beat(app);
  await expect.poll(() => itemReads(PR), { timeout: 15_000 }).toBeGreaterThan(i3);
  await page.waitForTimeout(800);
  expect(detailReads(PR)).toBe(d2);
  await app.close();
});

test('settings: the "running" label (GitHub#404) is the one a tab\'s status reads — changed or emptied there, the tabs follow', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  change(A, { labels: ['wip'] });
  change(B, { labels: ['doing/agent'] });
  await row(page, A).click({ button: 'middle' });
  await row(page, B).click({ button: 'middle' });
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

test('an item waiting for a prerequisite (GitHub#443): its tab shows a pause, follows the rounds, and the waiting label is the one Settings holds', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  change(A, { labels: ['doing/agent'] });
  change(B, { labels: ['pending/human'] });
  change(C, { labels: ['pending/blocked'] });
  // in the background (GitHub#442: ⌘ / Ctrl + click brings the tab forward; the middle button keeps home in front)
  for (const n of [A, B, C]) await row(page, n).click({ button: 'middle' });
  beat(app);
  await expect(tab(page, C)).toHaveAttribute('data-status', 'blocked', { timeout: 15_000 });
  await expect(tab(page, A)).toHaveAttribute('data-status', 'running');
  await expect(tab(page, B)).toHaveAttribute('data-status', 'waiting');
  // the pause is drawn, and its words are what a pointer and a screen reader get
  await expect(tab(page, C).locator('svg.tab-icon.blocked')).toHaveCount(1);
  await expect(tab(page, C).getByTestId('tab-status')).toHaveAttribute('aria-label', '等前置完成');
  expect(await tab(page, C).getAttribute('title')).toContain('等前置完成');
  await shot(page, '443-01-blocked-pause');

  // the prerequisite is done: the daemon swaps the waiting label for the dispatch label, the next round shows it
  change(C, { labels: ['pending/agent'] });
  beat(app);
  await expect(tab(page, C)).toHaveAttribute('data-status', 'open', { timeout: 15_000 });
  await expect(tab(page, C).locator('svg.tab-icon.blocked')).toHaveCount(0);

  // another waiting label in Settings: the tabs follow it; emptied, there is no pause at all
  change(C, { labels: ['on-hold'] });
  beat(app);
  await page.getByTestId('open-settings').click();
  const field = page.getByTestId('hand-back-blocked');
  await expect(field).toHaveValue('pending/blocked');
  await field.fill('on-hold');
  await field.blur();
  await expect(tab(page, C)).toHaveAttribute('data-status', 'blocked', { timeout: 15_000 });
  await field.fill('');
  await field.blur();
  await expect(tab(page, C)).toHaveAttribute('data-status', 'open');
  await app.close();
});

test('unsent text belongs to the account it was typed under: signing out and in again — the same account or another — never brings it back; within one account it stays', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  const reply = () => detail(page).getByTestId('reply-input');
  const signOutAndIn = async (viewer: string) => {
    await page.keyboard.press('Control+,');
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('start-login')).toBeVisible({ timeout: 15_000 });
    env.fake.state.viewer = viewer;
    await page.getByTestId('start-login').click();
    await expect(page.getByTestId('user-code')).toBeVisible();
    env.fake.resolveGrant('approved');
    await expect(page.getByTestId('viewer')).toHaveText(viewer, { timeout: 15_000 });
    await page.getByTestId('back').click();
    await page.keyboard.press('Control+Shift+2');
    await expect(row(page, A)).toBeVisible({ timeout: 20_000 });
  };
  // within one account: kept across tabs
  await row(page, A).click({ modifiers: ['Control'] });
  await reply().fill('typed as user-1');
  await home(page).click();
  await tab(page, A).click();
  await expect(reply()).toHaveValue('typed as user-1');

  // the same account again: gone (and no tab is left in front)
  await signOutAndIn('user-1');
  await expect(page.getByTestId('tabs')).toHaveCount(0);
  await row(page, A).click({ modifiers: ['Control'] });
  await expect(reply()).toHaveValue('');

  // A → B → A: B never sees A's text, and A's does not come back either
  await reply().fill('typed as user-1 again');
  await signOutAndIn('user-2');
  await row(page, A).click({ modifiers: ['Control'] });
  await expect(reply()).toHaveValue('');
  await reply().fill('typed as user-2');
  await signOutAndIn('user-1');
  await row(page, A).click({ modifiers: ['Control'] });
  await expect(reply()).toHaveValue('');
  await app.close();
});

test('the tabs are kept on this machine: a restart brings them back behind the home tab; signing out drops them', async () => {
  let app = await launchApp(env);
  let page = app.page;
  await signIn(page);
  await row(page, B).click({ button: 'middle' });
  await row(page, A).click({ modifiers: ['Control'] });
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
  // no tab left: no tab bar either (GitHub#442)
  await expect(tabs(page)).toHaveCount(0);
  await expect(page.getByTestId('tabs')).toHaveCount(0);
  await app.close();
});
