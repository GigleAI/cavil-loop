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

// GitHub#721: while off, 「只看我的」 read as the label of the "显示已关闭" switch after it — grey text with no border
// and no fill. It is now an ordinary bordered button with a down arrow, and a thin line keeps it apart from that
// switch. Checked on the drawn window: the computed style (a ghost button of the same bar, 视图设置, is the old look
// it is compared with), the arrow, the line sitting between the two, the button, line and switch on one row, in
// the board and table layouts, in Chinese and in English. In Chinese the whole bar still fits one line at 1280
// wide (its last control, 快捷键, on the same row); the English board bar already took two lines before this change.
test('GitHub#721: 「只看我的」 looks like a button while off, with a down arrow, and a line keeps it apart from 「显示已关闭」', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await ready(page);
  const TRANSPARENT = 'rgba(0, 0, 0, 0)';
  const look = (testid: string) =>
    page.getByTestId(testid).evaluate((b) => {
      const s = getComputedStyle(b);
      return { bg: s.backgroundColor, border: s.borderTopColor, borderWidth: parseFloat(s.borderTopWidth), color: s.color, cls: b.className };
    });
  const box = async (testid: string) => (await page.getByTestId(testid).boundingBox())!;
  const mid = (r: { y: number; height: number }) => r.y + r.height / 2;
  const separated = async (where: string, wholeBar: boolean) => {
    const b = await box('mine-filter-toggle');
    const sep = await box('mine-filter-sep');
    const closed = await box('show-closed-toggle');
    // the line is drawn, and sits between the button and the switch
    expect(sep.width, where).toBeGreaterThan(0);
    expect(sep.height, where).toBeGreaterThan(10);
    expect(sep.x, where).toBeGreaterThanOrEqual(b.x + b.width);
    expect(sep.x + sep.width, where).toBeLessThanOrEqual(closed.x);
    expect(Math.abs(mid(sep) - mid(b)), where).toBeLessThan(4);
    expect(Math.abs(mid(closed) - mid(b)), where).toBeLessThan(4);
    if (wholeBar) expect(Math.abs(mid(await box('open-shortcuts')) - mid(b)), where).toBeLessThan(4);
  };
  const offLook = async (where: string) => {
    await expect(button(page)).toHaveAttribute('data-on', 'no');
    const mine = await look('mine-filter-toggle');
    const ghost = await look('open-view-panel'); // a ghost button of the same bar: the old look
    expect(ghost.bg, where).toBe(TRANSPARENT); // not vacuous: the comparison really is the borderless look
    expect(mine.cls, where).not.toContain('ghost');
    expect(mine.bg, where).not.toBe(TRANSPARENT);
    expect(mine.borderWidth, where).toBeGreaterThan(0);
    expect(mine.border, where).not.toBe(TRANSPARENT);
    expect(mine.border, where).not.toBe(ghost.border);
    expect(mine.color, where).not.toBe(ghost.color); // the text is the normal colour, not the muted grey
    await expect(button(page).locator('svg.icon'), where).toHaveCount(1); // the down arrow
  };

  for (const l of ['table', 'board']) {
    await layout(page, l);
    await offLook(l);
    await separated(l, true);
  }
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, 'mine-721-board-off.png'), clip: { x: 0, y: 0, width: 1280, height: 130 } });

  // on: still the highlighted look, still the arrow, still apart
  await open(page);
  await page.getByTestId('mine-on').check();
  await expect(button(page)).toHaveAttribute('data-on', 'yes');
  expect((await look('mine-filter-toggle')).cls).toBe('on');
  await expect(button(page).locator('svg.icon')).toHaveCount(1);
  await page.getByTestId('mine-on').press('Escape');
  await expect(page.getByTestId('mine-filter-pop')).toHaveCount(0);
  await separated('board, on', true);
  await open(page);
  await page.getByTestId('mine-on').uncheck();
  await page.getByTestId('mine-on').press('Escape');

  // English: the same look; the button, the line and the switch on one row
  await page.getByTestId('open-settings').click();
  await page.getByTestId('lang-en').check();
  await expect(page.getByTestId('back')).toContainText('Back to board');
  await page.getByTestId('back').click();
  await expect(button(page)).toContainText('Only mine');
  for (const l of ['table', 'board']) {
    await layout(page, l);
    await offLook(`${l}, English`);
    await separated(`${l}, English`, false);
  }
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, 'mine-721-board-off-en.png'), clip: { x: 0, y: 0, width: 1280, height: 130 } });
  await app.close();
});

// GitHub#728: with a mouse the panel opens by itself while the pointer rests on 「只看我的」 and closes once the
// pointer has left the button and the panel — whether the button was clicked in between or not. Touch and the
// keyboard keep opening it by a tap / Enter. (Signed out the window shows the sign-in page, not this bar; the
// greyed button and its tip are covered by test/unit/mine-filter.test.ts.) Real mouse moves in the real window; the waits below are the
// component's own (about 0.15 s to open, 0.3 s to close), so each "still closed / still open" check waits past them
// and sits next to a check that the same move really did open or close it.
test('GitHub#728: 「只看我的」 opens on mouse hover and closes when the mouse leaves the button and the panel', async () => {
  const app = await launchApp(env);
  const page = app.page;
  const pop = () => page.getByTestId('mine-filter-pop');
  const center = async (testid: string) => {
    const b = (await page.getByTestId(testid).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  /** a point of the view bar away from the button and the panel: the layout switch */
  const away = () => center('layout');
  const moveTo = async (p: { x: number; y: number }) => page.mouse.move(p.x, p.y, { steps: 4 });

  await ready(page);
  const open_ = (await items(page)).filter((i) => i.state === 'open');
  const mineAny = open_.filter((i) => byMe(i) || toMe(i));
  const mineAuthor = open_.filter(byMe);
  expect(mineAny.length).toBeGreaterThan(mineAuthor.length); // not vacuous: unticking 指派给我 changes the list

  // ---- hovering opens it, and the button drops its own tip (it would cover the panel) ----
  await expect(button(page)).toHaveAttribute('title', '只看我的：关');
  await moveTo(await center('mine-filter-toggle'));
  await expect(pop()).toBeVisible();
  await expect(button(page)).not.toHaveAttribute('title', /.+/);

  // ---- from the button down into the panel: it stays; a box ticked there works as before ----
  await moveTo(await center('mine-on'));
  await page.waitForTimeout(600);
  await expect(pop()).toBeVisible();
  await page.getByTestId('mine-on').click();
  await expect.poll(() => rowKeys(page)).toEqual(keys(mineAny));
  await page.getByTestId('mine-assignee').click();
  await expect.poll(() => rowKeys(page)).toEqual(keys(mineAuthor));
  await expect(pop()).toBeVisible();
  await page.getByTestId('mine-assignee').click();
  await expect.poll(() => rowKeys(page)).toEqual(keys(mineAny));

  // ---- leaving both: it closes; the switch stays on ----
  await moveTo(await away());
  await expect(pop()).toHaveCount(0);
  await expect(button(page)).toHaveAttribute('data-on', 'yes');
  await expect(button(page)).toHaveAttribute('title', /只看我的：/);

  // ---- leaving and coming back before the close wait is over: it stays open ----
  await moveTo(await center('mine-filter-toggle'));
  await expect(pop()).toBeVisible();
  const b = await center('mine-filter-toggle');
  await page.mouse.move(b.x, b.y - 40); // just above the button, out of it
  await page.mouse.move(b.x, b.y); // back within the wait
  await page.waitForTimeout(600);
  await expect(pop()).toBeVisible();

  // ---- a mouse click while it is open leaves it open, and leaving still closes it ----
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(300);
  await expect(pop()).toBeVisible();
  await moveTo(await away());
  await expect(pop()).toHaveCount(0);

  // ---- Esc closes it under a resting pointer, and it does not come back until the pointer leaves and returns ----
  await moveTo(b);
  await expect(pop()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop()).toHaveCount(0);
  await page.waitForTimeout(600);
  await expect(pop()).toHaveCount(0);
  // a mouse click on the closed panel opens it; leaving closes it
  await page.mouse.click(b.x, b.y);
  await expect(pop()).toBeVisible();
  await moveTo(await away());
  await expect(pop()).toHaveCount(0);

  // ---- Esc while the open wait is still running: it does not open ----
  await page.mouse.move(b.x, b.y);
  await button(page).press('Escape');
  await page.waitForTimeout(600);
  await expect(pop()).toHaveCount(0);
  await moveTo(await away());
  // the same move without Esc does open it (so the check above is not vacuous)
  await page.mouse.move(b.x, b.y);
  await expect(pop()).toBeVisible();
  await moveTo(await away());
  await expect(pop()).toHaveCount(0);

  // ---- the window losing focus while the open wait runs: it does not open ----
  await page.mouse.move(b.x, b.y);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(600);
  await expect(pop()).toHaveCount(0);
  await moveTo(await away());

  // ---- the keyboard: Enter opens it, it stays with the pointer elsewhere, Esc closes it and gives the focus back ----
  await button(page).focus();
  await page.keyboard.press('Enter');
  await expect(pop()).toBeVisible();
  await page.waitForTimeout(600);
  await expect(pop()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop()).toHaveCount(0);
  await expect(button(page)).toBeFocused();

  // ---- touch: a tap opens it and nothing closes it until a tap elsewhere (no hover rules) ----
  await button(page).dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
  await button(page).dispatchEvent('click');
  await expect(pop()).toBeVisible();
  await page.getByTestId('layout').dispatchEvent('pointerleave', { pointerType: 'touch' });
  await page.waitForTimeout(600);
  await expect(pop()).toBeVisible();
  await page.getByTestId('search').dispatchEvent('pointerdown', { pointerType: 'touch', bubbles: true });
  await expect(pop()).toHaveCount(0);
  await app.close();
});
