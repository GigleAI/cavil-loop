// GigleAI/cavil-loop#689: the view bar's 「只看我的」 — one switch for the whole window, two boxes (我提出的 /
// 指派给我, either matching). In the real window (built with --test-bridge), the real back end behind the
// loopback bridge, the fake GitHub serving the board recorded from the real cavil project, signed in as
// user-6 (the author of most of its items). The recording has no item assigned to someone other than its
// author, so one open issue opened by user-1 is assigned to user-6 here — the case that only 指派给我 picks.
// The expected items are picked here straight from what the window holds, with the rule written out in
// this file (author or assignee, any case) — not with the app's functions.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCavilProjectPages, startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { unfoldSettings } from './unfold';
import { press, tally } from './tally';
import type { Item } from '../../src/shared/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const ME = 'user-6';
/** an open issue opened by user-1, assigned to ME below */
const ASSIGNED = 135;

/** the recorded pages, with issue #ASSIGNED assigned to ME */
function pages() {
  const data = loadCavilProjectPages();
  let done = 0;
  const walk = (v: any): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (v.content && typeof v.content === 'object' && v.content.number === ASSIGNED && v.content.assignees) {
      v.content.assignees = { ...v.content.assignees, nodes: [{ login: ME }] };
      done++;
    }
    Object.values(v).forEach(walk);
  };
  walk(data);
  if (done === 0) throw new Error(`the recording no longer holds #${ASSIGNED} with an assignee list`);
  return data;
}

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-mine-'));
  env = {
    fake: await startFakeGitHub({ viewer: ME, projects: new Map([['org/gigleai/11', pages()]]) }),
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

const lc = (s: string | null) => (s ?? '').toLowerCase();
const byMe = (i: Item) => lc(i.author) === ME;
const toMe = (i: Item) => i.assignees.some((a) => lc(a) === ME);
const items = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).data.items as Item[]);
const mineState = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).state.mineFilter);
/** what the back end has stored (its own read) */
const stored = async (app: RunningApp) => (((await app.backend.call('init')) as { settings: Record<string, any> }).settings.mineFilter ?? null) as Record<string, boolean> | null;
const rowKeys = (page: Page) => page.$$eval('[data-testid="row"]:not([data-pulled]):not([data-carried])', (rs) => rs.map((r) => r.getAttribute('data-key')!).sort());
const cardKeys = (page: Page) => page.$$eval('[data-testid="card"]:not([data-carried])', (cs) => [...new Set(cs.map((c) => c.getAttribute('data-key')!))].sort());
const layout = (page: Page, l: string) => page.locator(`[data-testid="layout"] button[data-value="${l}"]`).click();
const button = (page: Page) => page.getByTestId('mine-filter-toggle');
const keys = (xs: Item[]) => xs.map((i) => i.key).sort();
const human = (i: Item) => i.labels.some((l) => l.name.toLowerCase() === 'pending/human');
const running = (i: Item) => i.state === 'open' && i.labels.some((l) => l.name.toLowerCase() === 'doing/agent');

async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
}

async function open(page: Page) {
  if ((await page.getByTestId('mine-filter-pop').count()) === 0) await button(page).click();
  await expect(page.getByTestId('mine-filter-pop')).toBeVisible();
}

async function ready(page: Page) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await unfoldSettings(page);
  await page.getByTestId('source-input').fill('https://github.com/orgs/GigleAI/projects/11');
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await items(page)).length).toBeGreaterThan(0);
}

test('GitHub#689: 「只看我的」 narrows every layout and the view-bar numbers, survives a number click, a layout switch and a restart', async () => {
  let app = await launchApp(env);
  let page = app.page;
  await ready(page);
  const all = await items(page);
  const open_ = all.filter((i) => i.state === 'open');
  const mineAny = open_.filter((i) => byMe(i) || toMe(i));
  const mineAuthor = open_.filter(byMe);
  // not vacuous: some open items are not mine, and one is mine only by assignment
  expect(mineAny.length).toBeGreaterThan(0);
  expect(mineAny.length).toBeLessThan(open_.length);
  expect(mineAny.length).toBeGreaterThan(mineAuthor.length);
  expect(mineAny.map((i) => i.number)).toContain(ASSIGNED);

  // ---- off at first: everything open is listed, the numbers count everything ----
  await expect(button(page)).toHaveAttribute('data-on', 'no');
  await expect.poll(() => rowKeys(page)).toEqual(keys(open_));
  await expect(tally(page, 'running').getByTestId('tally-count')).toHaveText(String(all.filter(running).length));

  // ---- on, both boxes: author or assignee ----
  await open(page);
  await expect(page.getByTestId('mine-author')).toBeDisabled(); // the switch is off: the boxes wait
  await page.getByTestId('mine-on').check();
  await expect(button(page)).toHaveAttribute('data-on', 'yes');
  await expect.poll(() => rowKeys(page)).toEqual(keys(mineAny));
  await expect(page.getByTestId('mine-empty')).toHaveCount(0); // items listed: no empty note
  const mineAll = all.filter((i) => byMe(i) || toMe(i));
  await expect(tally(page, 'running').getByTestId('tally-count')).toHaveText(String(mineAll.filter(running).length));
  await expect(tally(page, 'human').getByTestId('tally-count')).toHaveText(String(mineAll.filter(human).length));
  await shot(page, 'mine-01-table-on');

  // ---- 指派给我 off: what I opened only; the last box cannot be unticked ----
  await page.getByTestId('mine-assignee').uncheck();
  await expect.poll(() => rowKeys(page)).toEqual(keys(mineAuthor));
  await expect(page.getByTestId('mine-author')).toBeDisabled();
  await expect.poll(() => mineState(page)).toEqual({ on: true, author: true, assignee: false });
  await page.getByTestId('mine-assignee').check();
  await expect.poll(() => rowKeys(page)).toEqual(keys(mineAny));

  // ---- the panel closes on Esc; the switch stays ----
  await page.getByTestId('mine-on').press('Escape');
  await expect(page.getByTestId('mine-filter-pop')).toHaveCount(0);
  await expect(button(page)).toHaveAttribute('data-on', 'yes');

  // ---- the board and the graph: the same switch, the same items ----
  await layout(page, 'board');
  await expect(button(page)).toHaveAttribute('data-on', 'yes');
  if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').first().click();
  await expect.poll(() => cardKeys(page)).toEqual(keys(mineAny));
  await shot(page, 'mine-02-board-on');
  await layout(page, 'graph');
  await expect(button(page)).toHaveAttribute('data-on', 'yes');
  const mineKeys = new Set(mineAny.map((i) => i.key));
  // every box drawn at full strength is one of mine; the rest are context, faded
  const strong = await page.$$eval('[data-testid="graph-box"]', (bs) => bs.filter((b) => !b.classList.contains('dim') && !b.classList.contains('outside')).map((b) => b.getAttribute('data-key')!));
  expect(strong.length).toBeGreaterThan(0);
  for (const k of strong) expect(mineKeys.has(k), k).toBe(true);
  await layout(page, 'table');

  // ---- a number clicked: the search box changes, the switch does not; the list is both ----
  await press(page, 'human');
  await expect(page.getByTestId('search')).toHaveValue('label:"pending/human"');
  await expect(button(page)).toHaveAttribute('data-on', 'yes');
  await expect.poll(() => rowKeys(page)).toEqual(keys(mineAll.filter(human))); // its "显示已关闭" starts on
  await press(page, 'human');
  await expect(page.getByTestId('search')).toHaveValue('');

  // ---- a restart keeps it ----
  await expect.poll(() => stored(app)).toEqual({ on: true, author: true, assignee: true });
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await expect(button(page)).toHaveAttribute('data-on', 'yes');
  await expect.poll(() => rowKeys(page)).toEqual(keys(mineAny));

  // ---- off again: everything is back ----
  await open(page);
  await page.getByTestId('mine-on').uncheck();
  await expect(button(page)).toHaveAttribute('data-on', 'no');
  await expect.poll(() => rowKeys(page)).toEqual(keys(open_));
  await expect(tally(page, 'running').getByTestId('tally-count')).toHaveText(String(all.filter(running).length));
  await app.close();
});

test('GitHub#689 (PR #698 review round 1): an account with nothing of its own — every layout says 「只看我的」 is why the list is empty, and one click turns it off', async () => {
  env.fake.state.viewer = 'nobody-with-items';
  const app = await launchApp(env);
  const page = app.page;
  await ready(page);
  const all = await items(page);
  const open_ = all.filter((i) => i.state === 'open');
  // not vacuous: the account really has nothing, and there is something to hide
  expect(all.filter((i) => lc(i.author) === 'nobody-with-items' || i.assignees.some((a) => lc(a) === 'nobody-with-items'))).toEqual([]);
  expect(open_.length).toBeGreaterThan(0);

  // off: rows, no note
  await expect.poll(() => rowKeys(page)).toEqual(keys(open_));
  await expect(page.getByTestId('mine-empty')).toHaveCount(0);

  await open(page);
  await page.getByTestId('mine-on').check();
  await page.getByTestId('mine-on').press('Escape');
  await expect.poll(() => rowKeys(page)).toEqual([]);
  for (const l of ['table', 'board', 'graph']) {
    await layout(page, l);
    await expect(page.getByTestId('mine-empty'), l).toBeVisible();
    await expect(page.getByTestId('mine-empty'), l).toContainText('已开「只看我的」');
  }
  await shot(page, 'mine-03-empty-graph');

  // the note's own button: off, everything back, the note gone
  await layout(page, 'table');
  await page.getByTestId('mine-empty-off').click();
  await expect(button(page)).toHaveAttribute('data-on', 'no');
  await expect.poll(() => rowKeys(page)).toEqual(keys(open_));
  await expect(page.getByTestId('mine-empty')).toHaveCount(0);
  await expect.poll(() => mineState(page)).toEqual({ on: false, author: true, assignee: true });
  await app.close();
});
