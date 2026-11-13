// GigleAI/cavil-loop#464: the search box starts empty and the view bar's "显示已关闭" switch decides
// whether closed / merged items are listed. One switch per view: the three layouts, and each flow number
// of the view bar while it is lit. In the real window (built with --test-bridge), the real back end
// behind the loopback bridge, the fake GitHub serving the board recorded from the real cavil project
// (it holds two closed issues carrying `pending/human`). The expected items are picked here straight
// from what the window holds, with the rule written out in this file — not with the app's functions.
// Screenshots land in test-results/screens/.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelationIssues, loadRelationPages, startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';
import type { Item } from '../../src/shared/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-closed-'));
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

const items = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).data.items as Item[]);
const viewState = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).state.view);
const human = (i: Item) => i.labels.some((l) => l.name.toLowerCase() === 'pending/human');
const rowKeys = (page: Page) => page.$$eval('[data-testid="row"]:not([data-pulled])', (rs) => rs.map((r) => r.getAttribute('data-key')!).sort());
const toggle = (page: Page) => page.getByTestId('show-closed-toggle');
const box = (page: Page) => page.getByTestId('show-closed');
const tally = (page: Page, kind: string) => page.locator(`[data-testid="tally"][data-kind="${kind}"]`);
const layout = (page: Page, l: string) => page.locator(`[data-testid="layout"] button[data-value="${l}"]`).click();

async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
}

async function ready(page: Page) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  // a new install: the box is empty, the switch is off
  await expect(page.getByTestId('search')).toHaveValue('');
  await expect(box(page)).not.toBeChecked();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill('https://github.com/orgs/GigleAI/projects/11');
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  // the saved web view is imported (table); its filter (-label:Done -status:Done) only hid finished items: left out
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('search')).toHaveValue('');
  await expect.poll(async () => (await viewState(page)).imported?.viewNumber).toBe(1);
}

test('GitHub#464: one "显示已关闭" switch per view — layouts and lit flow numbers each keep their own, a search naming the state wins, a restart keeps them', async () => {
  let app = await launchApp(env);
  let page = app.page;
  await ready(page);
  const all = await items(page);
  const open = all.filter((i) => i.state === 'open');
  const closedHuman = all.filter((i) => i.state !== 'open' && human(i)).map((i) => i.key).sort();
  // the recording really has closed items carrying the label, so "they are hidden" is not vacuous
  expect(closedHuman.length).toBeGreaterThan(0);
  expect(all.length).toBeGreaterThan(open.length);

  // ---- table, switch off: an empty search lists the open items only ----
  await expect(toggle(page)).toHaveAttribute('data-view', 'table');
  await expect(toggle(page)).toHaveText('显示已关闭');
  await expect.poll(() => rowKeys(page)).toEqual(open.map((i) => i.key).sort());
  await shot(page, 'show-closed-01-table-off');
  // a search without quotes is not the number's query: the table's own switch still decides
  await page.getByTestId('search').fill('label:pending/human');
  await expect(tally(page, 'human')).toHaveAttribute('aria-pressed', 'false');
  const openHuman = open.filter(human).map((i) => i.key).sort();
  await expect.poll(() => rowKeys(page)).toEqual(openHuman);

  // ---- switch on: the closed ones come too, and it is saved ----
  await box(page).check();
  await expect.poll(() => rowKeys(page)).toEqual([...openHuman, ...closedHuman].sort());
  await expect.poll(async () => (await viewState(page)).showClosed).toMatchObject({ table: true, board: false, graph: false, human: false });
  await shot(page, 'show-closed-02-table-on');

  // ---- the board has its own, still off: the closed ones are not there ----
  await layout(page, 'board');
  await expect(toggle(page)).toHaveAttribute('data-view', 'board');
  await expect(box(page)).not.toBeChecked();
  for (const k of closedHuman) await expect(page.locator(`[data-testid="card"][data-key="${k}"]`)).toHaveCount(0);
  await box(page).check();
  if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').first().click();
  for (const k of closedHuman) await expect(page.locator(`[data-testid="card"][data-key="${k}"]`)).toHaveCount(1);
  await shot(page, 'show-closed-03-board-on');
  await box(page).uncheck();
  for (const k of closedHuman) await expect(page.locator(`[data-testid="card"][data-key="${k}"]`)).toHaveCount(0);

  // ---- back to the table: its switch kept its state ----
  await layout(page, 'table');
  await expect(box(page)).toBeChecked();
  await page.getByTestId('search').fill('');

  // ---- "等人处理" lit: its own switch (off) — the list is exactly the counted items ----
  await tally(page, 'human').click();
  await expect(page.getByTestId('search')).toHaveValue('label:"pending/human"');
  await expect(toggle(page)).toHaveAttribute('data-view', 'human');
  await expect(toggle(page)).toHaveText('显示已关闭（等人处理）');
  await expect(box(page)).not.toBeChecked();
  await expect.poll(() => rowKeys(page)).toEqual(openHuman);
  await expect(tally(page, 'human').getByTestId('tally-count')).toHaveText(String(openHuman.length));
  await box(page).check();
  await expect.poll(() => rowKeys(page)).toEqual([...openHuman, ...closedHuman].sort());
  // the number itself still counts open items only
  await expect(tally(page, 'human').getByTestId('tally-count')).toHaveText(String(openHuman.length));
  await shot(page, 'show-closed-04-human-on');
  // the same lit number on the board uses the same switch
  await layout(page, 'board');
  await expect(toggle(page)).toHaveAttribute('data-view', 'human');
  await expect(box(page)).toBeChecked();
  await layout(page, 'table');

  // ---- another number lit: its own switch, off ----
  await tally(page, 'agent').click();
  await expect(toggle(page)).toHaveAttribute('data-view', 'agent');
  await expect(box(page)).not.toBeChecked();
  // unlit: back to the table's, which was on
  await tally(page, 'agent').click();
  await expect(page.getByTestId('search')).toHaveValue('');
  await expect(toggle(page)).toHaveAttribute('data-view', 'table');
  await expect(box(page)).toBeChecked();
  await expect.poll(() => rowKeys(page)).toEqual(all.map((i) => i.key).sort());

  // ---- a search that says open / closed itself decides; the switch is greyed out ----
  await page.getByTestId('search').fill('is:closed');
  await expect(box(page)).toBeDisabled();
  await expect(toggle(page)).toHaveAttribute('title', /搜索框已经指定了开 \/ 关状态/);
  await box(page).uncheck({ force: true });
  await expect.poll(() => rowKeys(page)).toEqual(all.filter((i) => i.state !== 'open').map((i) => i.key).sort());
  await page.getByTestId('search').fill('is:open');
  await expect(box(page)).toBeDisabled();
  await expect.poll(() => rowKeys(page)).toEqual(open.map((i) => i.key).sort());
  await shot(page, 'show-closed-05-search-decides');
  await page.getByTestId('search').fill('');
  await expect(box(page)).toBeEnabled();
  await expect(box(page)).toBeChecked();

  // ---- the graph has its own too ----
  await layout(page, 'graph');
  await expect(toggle(page)).toHaveAttribute('data-view', 'graph');
  await expect(box(page)).not.toBeChecked();

  // ---- a restart keeps every switch ----
  await expect.poll(async () => (await viewState(page)).showClosed).toEqual({ board: false, table: true, graph: false, running: false, agent: false, human: true, unlabeled: false });
  await page.waitForTimeout(500);
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('graph')).toBeVisible({ timeout: 15_000 });
  await expect(box(page)).not.toBeChecked();
  await layout(page, 'table');
  await expect(box(page)).toBeChecked();
  await tally(page, 'human').click();
  await expect(box(page)).toBeChecked();
  await app.close();
});
