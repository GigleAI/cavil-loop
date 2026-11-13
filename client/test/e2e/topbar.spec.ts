// GigleAI/cavil-loop#467: the window's one top row — logo, the tabs (or the app's name), the board's
// tools (search, sync state, refresh, new issue, settings, the account). It belongs to the whole
// window: a detail tab in front keeps the tools. The search box is small until it is used; new issue
// is a ➕ only; the source check boxes moved to Settings. On macOS the row is the title bar (room for
// the window buttons, pressing an empty part moves the window, a double click zooms it) — the shell's
// answer is played by the bridge's fake desktop here. The real window (built with --test-bridge), the
// real back end behind the loopback bridge, the local fake GitHub.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
const A = 139;

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
  await page.keyboard.press('Control+Shift+2');
  await expect(row(page, A)).toBeVisible({ timeout: 20_000 });
}

const row = (page: Page, n: number) => page.locator(`[data-testid="row"][data-key="${K(n)}"] [data-testid="title-cell"]`).first();
const B = 142;
/** the board's "N 个条目" once the sync round has settled */
async function settledTotal(page: Page): Promise<string> {
  await expect(page.getByTestId('refresh')).toHaveAttribute('data-syncing', 'no', { timeout: 20_000 });
  return (await page.getByTestId('item-total').textContent()) ?? '';
}
const topbar = (page: Page) => page.getByTestId('topbar');
const width = (page: Page, testid: string) => page.getByTestId(testid).evaluate((e) => e.getBoundingClientRect().width);
/** what the window asked of the shell's desktop side, by op */
const asked = (app: RunningApp, op: string) => app.desktop.records.filter((r) => r.op === op).length;

test('one top row: logo and name, the tools, no source check boxes; new issue is a ➕ with its name; the search box is small until used and keeps its text', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  // one row above the view bar: the tab strip is not there while no tab is open
  await expect(topbar(page)).toHaveCount(1);
  await expect(page.getByTestId('topbar-name')).toHaveText('Cavil Loop');
  await expect(page.getByTestId('tabs')).toHaveCount(0);
  for (const id of ['search', 'sync-status', 'refresh', 'write-entry', 'open-settings']) await expect(topbar(page).getByTestId(id)).toBeVisible();
  await expect(page.locator('.src-chip, [data-testid="board"] input[type="checkbox"][data-key]')).toHaveCount(0);
  // the system's title bar (as on Linux): the row leaves no room for window buttons
  await expect(topbar(page)).toHaveAttribute('data-frame', 'system');
  expect(await topbar(page).evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft))).toBe(16);
  // ➕ only, still named and with its key in the hover
  const add = page.getByTestId('write-entry');
  await expect(add).toHaveText('');
  await expect(add).toHaveAccessibleName('新建 issue');
  await expect(add).toHaveAttribute('title', /新建 issue/);
  await add.click();
  await expect(page.getByTestId('new-issue-title')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-issue-title')).toHaveCount(0);

  // small, until clicked (on its icon too); wide while used; small again after, the search kept and applied
  const box = page.getByTestId('search-box');
  await expect(box).toHaveAttribute('data-open', 'no');
  const small = await width(page, 'search-box');
  expect(small).toBeLessThanOrEqual(160);
  await expect(row(page, B)).toBeVisible();
  // a piece of #A's own title that #B's does not have
  const words = findCopies(env.fake.state, REPO, A)!.rest[0].title as string;
  await box.locator('svg').click();
  await expect(box).toHaveAttribute('data-open', 'yes');
  await expect(page.getByTestId('search')).toBeFocused();
  await expect.poll(() => width(page, 'search-box')).toBeGreaterThan(400);
  await page.getByTestId('search').fill(words);
  await expect(row(page, B)).toHaveCount(0);
  await expect(row(page, A)).toBeVisible();
  await shot(page, '467-01-search-open');
  await page.keyboard.press('Escape');
  await expect(box).toHaveAttribute('data-open', 'no');
  await expect.poll(() => width(page, 'search-box')).toBeLessThanOrEqual(160);
  await expect(page.getByTestId('search')).toHaveValue(words);
  await expect(row(page, A)).toBeVisible();
  await expect(row(page, B)).toHaveCount(0);
  // the "jump to search" key opens it too; clicking elsewhere closes it, the text stays
  await page.keyboard.press('/');
  await expect(box).toHaveAttribute('data-open', 'yes');
  await page.getByTestId('topbar-name').click();
  await expect(box).toHaveAttribute('data-open', 'no');
  await expect(page.getByTestId('search')).toHaveValue(words);
  await shot(page, '467-02-home');
  await app.close();
});

test('a detail tab in front keeps the tools: typing a search or ➕ brings the board forward; settings opens over it', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  await row(page, A).click({ modifiers: ['Control'] });
  await expect(page.getByTestId('tab-page-detail')).toBeVisible();
  // the tabs and the tools share the one row
  await expect(topbar(page).getByTestId('tabs')).toBeVisible();
  await expect(page.getByTestId('topbar-name')).toHaveCount(0);
  for (const id of ['search', 'refresh', 'write-entry', 'open-settings']) await expect(topbar(page).getByTestId(id)).toBeVisible();
  await shot(page, '467-03-detail');

  // typing in the search box: the board comes forward with the result, and every key lands in the box
  // (PR #484 code review round 1: the switch to the board used to take the focus after the first key)
  const search = page.getByTestId('search');
  const box = page.getByTestId('search-box');
  const words = findCopies(env.fake.state, REPO, A)!.rest[0].title as string;
  await search.click();
  await expect(page.getByTestId('tab-home')).toHaveAttribute('data-front', 'no');
  await page.keyboard.press('ControlOrMeta+A');
  let typed = '';
  for (const ch of words) {
    await page.keyboard.type(ch);
    typed += ch;
    await expect(search).toHaveValue(typed);
    await expect(search).toBeFocused();
    await expect(box).toHaveAttribute('data-open', 'yes');
    await expect(page.getByTestId('tab-home')).toHaveAttribute('data-front', 'yes');
  }
  await expect(row(page, A)).toBeVisible();
  await expect(row(page, B)).toHaveCount(0);
  // the shortcut way back (switching tabs) still leaves the keys to the page, as before
  await page.locator(`[data-testid="tab"][data-key="${K(A)}"]`).click();
  await expect(search).not.toBeFocused();
  await expect(box).toHaveAttribute('data-open', 'no');
  await expect(search).toHaveValue(words);
  await page.getByTestId('tab-home').click();
  await page.getByTestId('search').fill('');

  // ➕ from a detail tab: the board and its dialog
  await page.locator(`[data-testid="tab"][data-key="${K(A)}"]`).click();
  await expect(page.getByTestId('tab-page-detail')).toBeVisible();
  await page.getByTestId('write-entry').click();
  await expect(page.getByTestId('tab-home')).toHaveAttribute('data-front', 'yes');
  await expect(page.getByTestId('new-issue-title')).toBeVisible();
  await page.keyboard.press('Escape');

  // settings from a detail tab: the settings page in front
  await page.locator(`[data-testid="tab"][data-key="${K(A)}"]`).click();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await expect(page.getByTestId('tab-home')).toHaveAttribute('data-front', 'yes');
  await app.close();
});

test('a source switched off in Settings leaves the board, stays listed and keeps that choice across a restart', async () => {
  let app = await launchApp(env);
  let page = app.page;
  await signIn(page);
  const total = await settledTotal(page);
  await page.getByTestId('open-settings').click();
  const sw = page.locator('[data-testid="source-shown"][data-key^="project:"]');
  await expect(sw).toBeChecked();
  await sw.uncheck();
  const r = page.locator('[data-testid="source-row"][data-key^="project:"]');
  await expect(r).toHaveAttribute('data-shown', 'no');
  await expect(r.getByTestId('source-hidden-note')).toHaveText(' · 看板上暂不显示');
  await shot(page, '467-04-settings-source-off');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('item-total')).not.toHaveText(total);
  const fewer = await page.getByTestId('item-total').textContent();
  expect(parseInt(fewer!)).toBeLessThan(parseInt(total));
  await page.waitForTimeout(500);
  await app.close();

  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await expect(page.locator('[data-testid="source-shown"][data-key^="project:"]')).not.toBeChecked();
  await page.locator('[data-testid="source-shown"][data-key^="project:"]').check();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('item-total')).toHaveText(total, { timeout: 20_000 });
  await app.close();
});

test('where the row is the title bar (macOS): room for the window buttons (none in full screen); an empty part moves the window, a double click zooms it; controls never do', async () => {
  const app = await launchApp(env);
  const page = app.page;
  // signed out: only the empty row the window is moved by
  app.desktop.frame = { overlay: true, fullscreen: false };
  await page.setViewportSize({ width: 1280, height: 801 });
  await expect(topbar(page)).toHaveAttribute('data-frame', 'overlay');
  await expect(topbar(page)).toHaveClass(/plain/);
  await signIn(page);
  await expect(topbar(page)).toHaveAttribute('data-frame', 'overlay');
  expect(await topbar(page).evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft))).toBe(84);
  await shot(page, '467-05-mac-frame');

  // an empty part: one press moves, a double click zooms
  const name = await page.getByTestId('topbar-name').boundingBox();
  const empty = { x: name!.x + name!.width - 20, y: name!.y + name!.height / 2 };
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(() => asked(app, 'startDrag')).toBe(1);
  await page.mouse.dblclick(empty.x, empty.y);
  await expect.poll(() => asked(app, 'toggleZoom')).toBe(1);
  // the room left for the window buttons is empty too
  await page.mouse.click(40, 26);
  await expect.poll(() => asked(app, 'startDrag')).toBeGreaterThanOrEqual(3);
  // a control is a control: no move, no zoom
  const before = asked(app, 'startDrag');
  await page.getByTestId('refresh').click();
  await page.getByTestId('search').dblclick();
  await page.keyboard.press('Escape');
  await row(page, A).click({ modifiers: ['Control'] });
  await page.locator(`[data-testid="tab"][data-key="${K(A)}"]`).click();
  await page.waitForTimeout(200);
  expect(asked(app, 'startDrag')).toBe(before);
  expect(asked(app, 'toggleZoom')).toBe(1);

  // full screen: the window buttons are hidden, so is their room
  app.desktop.frame = { overlay: true, fullscreen: true };
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(topbar(page)).toHaveAttribute('data-frame', 'fullscreen');
  expect(await topbar(page).evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft))).toBe(16);

  // not the title bar (Windows / Linux): an empty part is just empty
  app.desktop.frame = { overlay: false, fullscreen: false };
  await page.setViewportSize({ width: 1280, height: 801 });
  await expect(topbar(page)).toHaveAttribute('data-frame', 'system');
  const n = asked(app, 'startDrag');
  await page.mouse.click(40, 26);
  await page.waitForTimeout(200);
  expect(asked(app, 'startDrag')).toBe(n);
  await app.close();
});
