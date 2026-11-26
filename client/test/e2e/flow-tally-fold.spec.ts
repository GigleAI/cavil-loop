// GigleAI/cavil-loop#634: the view bar folds some numbers into a "⋯ 折叠 N" button at its end — by each row's
// rule in Settings → 顶栏计数: never / at 0 / always (default: 运行中 never, 稍后处理 always, the rest at 0).
// The real window on the real back end, the fake GitHub serving the recorded board. Counts move by changing
// labels in the fake GitHub and syncing, as they do in use. Expected counts are written out here (open items
// carrying the label; "等人处理" open or closed), not computed with the app's functions.
//  - folding moves where a number is drawn, nothing else: a lit number that drops to 0 stays lit (the fold
//    button lights up), comes back lit, and a click still gives the search from before
//  - keyboard focus follows the number between the row and the fold
//  - GitHub#712: a mouse click works in the fold — also pressing as the macOS app does (a press gives a button no focus)
//  - the rule is kept per row across a restart; a table saved before folding existed keeps its names, colours
//    and order and folds by the defaults
// Screenshots land in test-results/screens/.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelationIssues, loadRelationPages, startFakeGitHub } from '../fake-github/server';
import { findCopies } from '../fake-github/writes';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { unfoldSettings } from './unfold';
import { press, tally } from './tally';
import type { Item } from '../../src/shared/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });
const REPO = 'GigleAI/cavil-loop';
const NAMES: Record<string, string> = { unlabeled: '未处理', human: '等人处理', agent: '等 agent', running: '运行中', later: '稍后处理' };

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-fold-'));
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
const has = (i: Item, label: string) => i.labels.some((l) => l.name.toLowerCase() === label.toLowerCase());
const toggle = (page: Page) => page.getByTestId('tally-fold-toggle');
const pop = (page: Page) => page.getByTestId('tally-fold-pop');
const rowKinds = (page: Page) => page.locator('[data-testid="tally"][data-at="row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
const foldKinds = (page: Page) => page.locator('[data-testid="tally"][data-at="fold"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
/** what has keyboard focus: a number (where it is drawn) or the fold button */
const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a) return null;
    if (a.dataset.testid === 'tally-fold-toggle') return 'toggle';
    return a.dataset.testid === 'tally' ? `${a.dataset.at}:${a.dataset.kind}` : `other:${a.tagName}`;
  });

/** put a label on / take it off an item in the fake GitHub (every copy it serves), as a label change on GitHub would */
function setLabel(it: Pick<Item, 'repo' | 'number'>, name: string, on: boolean) {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const c = findCopies(store as any, it.repo, it.number);
  if (!c) throw new Error(`the fake GitHub does not serve ${it.repo}#${it.number}`);
  const now = new Date().toISOString();
  for (const r of c.rest) {
    r.labels = r.labels.filter((l: any) => l.name !== name);
    if (on) r.labels.push({ name, color: 'ededed' });
    r.updated_at = now;
  }
  for (const g of c.gql) {
    g.labels.nodes = g.labels.nodes.filter((l: any) => l.name !== name);
    if (on) g.labels.nodes.push({ name, color: 'ededed' });
    if ('totalCount' in g.labels) g.labels.totalCount = g.labels.nodes.length;
    g.updatedAt = now;
  }
}
/** one sync round; then wait until the window holds what `ok` asks of its items */
async function sync(page: Page, ok: (all: Item[]) => boolean) {
  await page.evaluate(() => (window as any).cavil.syncNow());
  await expect.poll(async () => ok(await items(page)), { timeout: 20_000 }).toBe(true);
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
  await expect(page.getByTestId('search')).toHaveValue('');
}

/**
 * Leave exactly `keep` items carrying `label` (taken from the open ones that carry it now, then from other open
 * items), synced. Returns their numbers.
 */
async function only(page: Page, label: string, keep: number): Promise<Item[]> {
  const all = await items(page);
  const carrying = all.filter((i) => has(i, label));
  const open = all.filter((i) => i.state === 'open' && i.repo.toLowerCase() === REPO.toLowerCase());
  const kept = [...carrying.filter((i) => i.state === 'open'), ...open.filter((i) => !has(i, label))].slice(0, keep);
  expect(kept.length).toBe(keep);
  for (const i of carrying) if (!kept.some((k) => k.key === i.key)) setLabel(i, label, false);
  for (const i of kept) setLabel(i, label, true);
  const want = kept.map((i) => i.key).sort().join();
  await sync(page, (xs) => xs.filter((i) => has(i, label)).map((i) => i.key).sort().join() === want);
  return kept;
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
}

test('GitHub#634: the default rules over the recorded board; the fold opens, its numbers click as in the row; Esc and a press elsewhere close it', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  const all = await items(page);
  // written out here: what each default row counts
  const counts: Record<string, number> = {
    unlabeled: all.filter((i) => i.state === 'open' && i.labels.length === 0).length,
    human: all.filter((i) => has(i, 'pending/human')).length,
    agent: all.filter((i) => i.state === 'open' && has(i, 'pending/agent')).length,
    running: all.filter((i) => i.state === 'open' && has(i, 'doing/agent')).length,
    later: all.filter((i) => i.state === 'open' && has(i, 'pending/later')).length,
  };
  const rule: Record<string, 'never' | 'zero' | 'always'> = { unlabeled: 'zero', human: 'zero', agent: 'zero', running: 'never', later: 'always' };
  const order = ['unlabeled', 'human', 'agent', 'running', 'later'];
  const isFolded = (k: string) => rule[k] === 'always' || (rule[k] === 'zero' && counts[k] === 0);
  // the recorded board has numbers on both sides, so this is not all-in or all-out
  expect(order.filter(isFolded).length).toBeGreaterThan(0);
  expect(order.filter((k) => !isFolded(k)).length).toBeGreaterThan(0);
  await expect.poll(() => rowKinds(page)).toEqual(order.filter((k) => !isFolded(k)));
  await expect.poll(() => foldKinds(page)).toEqual(order.filter(isFolded));
  for (const k of order) await expect(tally(page, k).getByTestId('tally-count')).toHaveText(String(counts[k]));
  await expect(toggle(page)).toHaveAttribute('data-count', String(order.filter(isFolded).length));
  await expect(toggle(page)).toContainText(`⋯ 折叠 ${order.filter(isFolded).length}`);
  await expect(toggle(page)).toHaveAttribute('title', new RegExp(`^折叠区：${order.filter(isFolded).map((k) => `${NAMES[k]} ${counts[k]}`).join('、')}$`));
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(pop(page)).toBeHidden();
  await shot(page, 'flow-tally-fold-01-closed');

  // open: each folded number with why it is there
  await toggle(page).click();
  await expect(pop(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(tally(page, 'later').getByTestId('tally-fold-why')).toHaveText('总是折叠');
  await shot(page, 'flow-tally-fold-02-open');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'flow-tally-fold-02-open-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // a click on a folded number does what it does in the row; the fold closes and its button takes the focus
  await toggle(page).click();
  await expect(pop(page)).toBeHidden();
  await page.getByTestId('search').fill('新增依赖图视图');
  await toggle(page).click();
  await tally(page, 'later').click();
  await expect(page.getByTestId('search')).toHaveValue('label:"pending/later"');
  await expect(pop(page)).toBeHidden();
  await expect.poll(() => focused(page)).toBe('toggle');
  await expect(toggle(page)).toHaveClass(/\bon\b/);
  await expect(toggle(page)).toHaveAttribute('title', /^正在看：稍后处理\n/);
  await toggle(page).click();
  await expect(tally(page, 'later')).toHaveAttribute('aria-pressed', 'true');
  await shot(page, 'flow-tally-fold-03-lit-in-fold');
  await tally(page, 'later').click();
  await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');
  await expect(toggle(page)).not.toHaveClass(/\bon\b/);

  // Esc and a press elsewhere close it (every Esc case is in the next test)
  await toggle(page).click();
  await expect(pop(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop(page)).toBeHidden();
  await toggle(page).click();
  await expect(pop(page)).toBeVisible();
  await page.getByTestId('table').click({ position: { x: 5, y: 5 } });
  await expect(pop(page)).toBeHidden();
});

test('GitHub#634 (PR #640 review rounds 1–3): Esc belongs to the fold only when pressed on it — every way of opening it, moving inside it and leaving it', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  await page.getByTestId('search').fill('新增依赖图视图');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // round 3: opened with the mouse by a press that gives the button no focus (WebKit's buttons, or a press whose
  // default was stopped): opening puts the focus on the fold's button, so Esc closes the panel and stays there
  await page.evaluate(() =>
    document.querySelector('[data-testid="tally-fold-toggle"]')!.addEventListener('mousedown', (e) => e.preventDefault(), { once: true, capture: true }),
  );
  await toggle(page).click();
  await expect(pop(page)).toBeVisible();
  await expect.poll(() => focused(page)).toBe('toggle');
  await page.keyboard.press('Escape');
  await expect(pop(page)).toBeHidden();
  await expect.poll(() => focused(page)).toBe('toggle');
  await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');
  // the same with focus somewhere else first (the search box): the panel opens with focus in it, Esc closes it, and
  // the search box keeps its text
  await page.getByTestId('search').focus();
  await page.evaluate(() =>
    document.querySelector('[data-testid="tally-fold-toggle"]')!.addEventListener('mousedown', (e) => e.preventDefault(), { once: true, capture: true }),
  );
  await toggle(page).click();
  await expect(pop(page)).toBeVisible();
  await expect.poll(() => focused(page)).toBe('toggle');
  await page.keyboard.press('Escape');
  await expect(pop(page)).toBeHidden();
  await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');

  // an ordinary click: Esc closes it, focus back on its button; a press elsewhere closes it too
  await toggle(page).click();
  await expect(pop(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop(page)).toBeHidden();
  await expect.poll(() => focused(page)).toBe('toggle');
  await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');
  await toggle(page).click();
  await expect(pop(page)).toBeVisible();
  await page.getByTestId('table').click({ position: { x: 5, y: 5 } });
  await expect(pop(page)).toBeHidden();

  // PR #640 review round 1: once the focus has left the fold, Esc belongs to where it is now. Opened with the
  // keyboard, then the focus moves to the search box: the fold closes behind it, and the box's own Esc (put the
  // box away, keep the text) runs — the focus does not jump back to the fold button.
  await toggle(page).focus();
  await page.keyboard.press('Enter');
  await expect(pop(page)).toBeVisible();
  await page.getByTestId('search').focus();
  await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)).toBe('search');
  await expect(pop(page)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null)).not.toBe('search');
  expect(await focused(page)).not.toBe('toggle');
  await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');
  // Shift+Tab out of the open fold closes it too; Esc inside it still closes it and comes back to its button
  await toggle(page).focus();
  await page.keyboard.press('Enter');
  await expect(pop(page)).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(pop(page)).toBeHidden();
  expect(await focused(page)).not.toBe('toggle');
  await toggle(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  expect(await focused(page)).toMatch(/^fold:/);
  await page.keyboard.press('Escape');
  await expect(pop(page)).toBeHidden();
  await expect.poll(() => focused(page)).toBe('toggle');

  // PR #640 review round 2: the board stays mounted behind a detail tab. Fold opened with the keyboard, then a
  // detail tab brought to the front with the keyboard: the first Esc is the detail page's own (back to the board),
  // never eaten by the hidden fold.
  await page.locator('[data-testid="row"] [data-testid="title-cell"]').first().click({ button: 'middle' });
  await expect(page.getByTestId('tab')).toHaveCount(1);
  await expect(page.getByTestId('tab-home')).toHaveAttribute('data-front', 'yes');
  await toggle(page).focus();
  await page.keyboard.press('Enter');
  await expect(pop(page)).toBeVisible();
  await page.keyboard.press('Control+2');
  await expect(page.getByTestId('tab')).toHaveAttribute('data-front', 'yes');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tab-home')).toHaveAttribute('data-front', 'yes');
  // back on the board: the fold closed when the board went behind, its button still works
  await expect(pop(page)).toBeHidden();
  await toggle(page).click();
  await expect(pop(page)).toBeVisible();
  // the window losing focus closes it too
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(pop(page)).toBeHidden();
});

test('GitHub#634: a lit number goes 1 → 0 → 1 — it moves into the fold and back, stays lit, and a click still gives the search from before', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  const [one] = await only(page, 'pending/human', 1);
  await expect(tally(page, 'human')).toHaveAttribute('data-at', 'row');
  await expect(tally(page, 'human').getByTestId('tally-count')).toHaveText('1');

  await page.getByTestId('search').fill('新增依赖图视图');
  await tally(page, 'human').click();
  await expect(page.getByTestId('search')).toHaveValue('label:"pending/human"');
  await expect(tally(page, 'human')).toHaveAttribute('aria-pressed', 'true');

  // → 0: into the fold, still lit, the search untouched; the fold button lights up and says which
  setLabel(one, 'pending/human', false);
  await sync(page, (xs) => !xs.some((i) => has(i, 'pending/human')));
  await expect(tally(page, 'human')).toHaveAttribute('data-at', 'fold');
  await expect(tally(page, 'human').getByTestId('tally-count')).toHaveText('0');
  await expect(page.getByTestId('search')).toHaveValue('label:"pending/human"');
  await expect(toggle(page)).toHaveClass(/\bon\b/);
  await expect(toggle(page)).toHaveAttribute('title', /^正在看：等人处理\n/);
  await toggle(page).click();
  await expect(tally(page, 'human')).toHaveAttribute('aria-pressed', 'true');
  await expect(tally(page, 'human').getByTestId('tally-fold-why')).toHaveText('为 0 时折叠');
  await page.keyboard.press('Escape');

  // → 1: back in the row, still lit; the fold button no longer lit
  setLabel(one, 'pending/human', true);
  await sync(page, (xs) => xs.filter((i) => has(i, 'pending/human')).length === 1);
  await expect(tally(page, 'human')).toHaveAttribute('data-at', 'row');
  await expect(tally(page, 'human')).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle(page)).not.toHaveClass(/\bon\b/);
  await expect(page.getByTestId('search')).toHaveValue('label:"pending/human"');
  // a click gives back the search from before the first click
  await tally(page, 'human').click();
  await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');
  await expect(tally(page, 'human')).toHaveAttribute('aria-pressed', 'false');
});

/**
 * GitHub#712: make a mouse press behave as in the macOS app's engine (WebKit on macOS), whatever engine the test
 * runs on: a press on a button does not give the button focus — the element holding focus just loses it, to
 * nowhere. Only a press whose default the page did not prevent moves focus, as in a real engine: the listener sits
 * on the window, after the page's own handlers, and leaves a prevented press alone.
 */
async function macPresses(page: Page) {
  await page.evaluate(() =>
    window.addEventListener('mousedown', (ev) => {
      if (ev.defaultPrevented || !(ev.target instanceof Element) || !ev.target.closest('button')) return;
      ev.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
    }),
  );
}

for (const mac of [false, true]) {
  test(`GitHub#712: with the mouse${mac ? ', pressing as the macOS app does' : ''} — a lit number in the fold is undone, an unlit one picked, the fold button closes the fold`, async () => {
    const { page } = await launchApp(env);
    await ready(page);
    if (mac) await macPresses(page);
    const [one] = await only(page, 'pending/human', 1);

    // a lit number drops to 0 and goes into the fold; a click on it there gives back the search from before
    await page.getByTestId('search').fill('新增依赖图视图');
    await tally(page, 'human').click();
    await expect(page.getByTestId('search')).toHaveValue('label:"pending/human"');
    setLabel(one, 'pending/human', false);
    await sync(page, (xs) => !xs.some((i) => has(i, 'pending/human')));
    await expect(tally(page, 'human')).toHaveAttribute('data-at', 'fold');
    await expect(tally(page, 'human')).toHaveAttribute('aria-pressed', 'true');
    await toggle(page).click();
    await expect(pop(page)).toBeVisible();
    await tally(page, 'human').click();
    await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');
    await expect(tally(page, 'human')).toHaveAttribute('aria-pressed', 'false');
    await expect(pop(page)).toBeHidden();

    // an unlit number in the fold is picked as in the row
    await toggle(page).click();
    await expect(pop(page)).toBeVisible();
    await tally(page, 'later').click();
    await expect(page.getByTestId('search')).toHaveValue('label:"pending/later"');
    await expect(tally(page, 'later')).toHaveAttribute('aria-pressed', 'true');
    await expect(pop(page)).toBeHidden();
    await expect(toggle(page)).toHaveClass(/\bon\b/);

    // the open fold's own button closes it, and it stays closed
    await toggle(page).click();
    await expect(pop(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await toggle(page).click();
    await expect(pop(page)).toBeHidden();
    await page.waitForTimeout(300);
    await expect(pop(page)).toBeHidden();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });
}

test('GitHub#634: keyboard focus follows the number between the row and the fold', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  const [h] = await only(page, 'pending/human', 1);
  setLabel(h, 'pending/human', false);
  await sync(page, (xs) => !xs.some((i) => has(i, 'pending/human')));
  await expect(tally(page, 'human')).toHaveAttribute('data-at', 'fold');
  await expect(tally(page, 'later')).toHaveAttribute('data-at', 'fold');
  await page.getByTestId('search').fill('新增依赖图视图');

  // ① with the keyboard: open the fold, Tab to "等人处理"; it becomes 1 → focus on it in the row, the fold closes,
  //    "稍后处理" is still folded behind the button
  await toggle(page).focus();
  await page.keyboard.press('Enter');
  await expect(pop(page)).toBeVisible();
  for (let i = 0; i < 6 && (await focused(page)) !== 'fold:human'; i++) await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('fold:human');
  setLabel(h, 'pending/human', true);
  await sync(page, (xs) => xs.some((i) => has(i, 'pending/human')));
  await expect(tally(page, 'human')).toHaveAttribute('data-at', 'row');
  await expect.poll(() => focused(page)).toBe('row:human');
  await expect(pop(page)).toBeHidden();
  await expect(tally(page, 'later')).toHaveAttribute('data-at', 'fold');
  await expect(toggle(page)).toBeVisible();
  await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');
  // the keyboard carries on from there: Enter = a click, Tab = the next thing in the bar
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('search')).toHaveValue('label:"pending/human"');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');
  const next = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement;
    const all = [...document.querySelectorAll<HTMLElement>('[data-testid="flow-tally"] button')].filter((b) => b.offsetParent !== null && !(b as HTMLButtonElement).disabled);
    const nb = all[all.indexOf(a) + 1];
    return nb ? (nb.dataset.testid === 'tally' ? `${nb.dataset.at}:${nb.dataset.kind}` : 'toggle') : null;
  });
  expect(next).not.toBeNull();
  await page.keyboard.press('Tab');
  expect(await focused(page)).toBe(next);

  // ② focus on "稍后处理" in the fold while "等人处理" goes 1 → 0 → 1: focus stays put, the fold stays open
  await toggle(page).click();
  await tally(page, 'later').focus();
  setLabel(h, 'pending/human', false);
  await sync(page, (xs) => !xs.some((i) => has(i, 'pending/human')));
  await expect(tally(page, 'human')).toHaveAttribute('data-at', 'fold');
  setLabel(h, 'pending/human', true);
  await sync(page, (xs) => xs.some((i) => has(i, 'pending/human')));
  await expect(tally(page, 'human')).toHaveAttribute('data-at', 'row');
  expect(await focused(page)).toBe('fold:later');
  await expect(pop(page)).toBeVisible();
  await page.keyboard.press('Escape');

  // ③ a focused number in the row that drops to 0 goes into the fold: focus on the fold button
  await tally(page, 'human').focus();
  setLabel(h, 'pending/human', false);
  await sync(page, (xs) => !xs.some((i) => has(i, 'pending/human')));
  await expect(tally(page, 'human')).toHaveAttribute('data-at', 'fold');
  await expect.poll(() => focused(page)).toBe('toggle');

  // ④ the last number leaves the fold: the fold closes, its button goes, focus on the number that left.
  //    Only "等人处理" folds now: every other row set to "不折叠" in Settings.
  await page.getByTestId('open-settings').click();
  await unfoldSettings(page);
  for (const id of ['unlabeled', 'agent', 'running', 'later']) {
    await page.locator(`[data-testid="tally-row"][data-id="${id}"]`).getByTestId('tally-fold').selectOption('never');
  }
  await page.getByTestId('back').click();
  await expect.poll(() => foldKinds(page)).toEqual(['human']);
  await toggle(page).click();
  await tally(page, 'human').focus();
  setLabel(h, 'pending/human', true);
  await sync(page, (xs) => xs.some((i) => has(i, 'pending/human')));
  await expect(tally(page, 'human')).toHaveAttribute('data-at', 'row');
  await expect(toggle(page)).toHaveCount(0);
  await expect(pop(page)).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe('row:human');
});

const stored = async (app: RunningApp) => ((await app.backend.call('init')) as { settings: Record<string, unknown> }).settings;

test('GitHub#634: Settings → 顶栏计数 sets each row\'s rule; the preview shows the fold; kept across a restart; an older saved table folds by the defaults', async () => {
  let app = await launchApp(env);
  let page = app.page;
  await ready(page);
  await only(page, 'doing/agent', 2);
  await page.getByTestId('open-settings').click();
  await unfoldSettings(page);
  await page.evaluate(() => document.getElementById('set-tallies')!.scrollIntoView({ block: 'start' }));
  const sel = (id: string) => page.locator(`[data-testid="tally-row"][data-id="${id}"]`).getByTestId('tally-fold');
  // the defaults, as the selects show them
  for (const [id, f] of [['unlabeled', 'zero'], ['human', 'zero'], ['agent', 'zero'], ['running', 'never'], ['later', 'always']]) await expect(sel(id)).toHaveValue(f);
  const previewFold = page.getByTestId('tally-preview-fold');
  await expect(previewFold.locator('[data-kind="later"]')).toHaveCount(1);
  await expect(previewFold.locator('[data-kind="running"]')).toHaveCount(0);
  await shot(page, 'flow-tally-fold-04-settings');

  // 运行中 → 总是折叠: the preview moves it at once, then the bar
  await sel('running').selectOption('always');
  await expect(previewFold.locator('[data-kind="running"]')).toHaveCount(1);
  await expect.poll(async () => ((await page.evaluate(async () => (await (window as any).cavil.get()).state.tallies)) ?? []).find((d: any) => d.id === 'running')?.fold).toBe('always');
  await page.getByTestId('back').click();
  await expect(tally(page, 'running')).toHaveAttribute('data-at', 'fold');

  // restart: the rule is still there, the bar folds it
  await expect.poll(async () => (((await stored(app)).tallies as any[] | undefined) ?? []).find((d) => d.id === 'running')?.fold).toBe('always');
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await expect(tally(page, 'running')).toHaveAttribute('data-at', 'fold', { timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await unfoldSettings(page);
  await expect(sel('running')).toHaveValue('always');
  await page.getByTestId('back').click();

  // a table as saved before folding existed: renamed, recoloured, reordered, one row of its own, no rules
  const old = [
    { id: 'later', name: '以后再说', color: 'red', source: { kind: 'flow', flow: 'later' } },
    { id: 'running', name: '在跑', color: 'blue', source: { kind: 'flow', flow: 'running' } },
    { id: 't-mine', name: '我的', color: 'gray', source: { kind: 'query', query: 'label:"no-such-label"' } },
    { id: 'human', name: '等人处理', color: 'orange', source: { kind: 'flow', flow: 'human' } },
  ];
  await page.evaluate((t) => (window as any).cavil.setTallies(t), old);
  await expect.poll(async () => (await stored(app)).tallies).toEqual(old);
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.talliesBroken)).toBe(false);
  // names, colours and the table's order as saved; 稍后处理 always folded, 运行中 (2) never, the row of its own (0) at 0
  await expect
    .poll(() =>
      page.getByTestId('tally').evaluateAll((els) =>
        els
          .slice()
          .sort((a, b) => Number(a.getAttribute('data-order')) - Number(b.getAttribute('data-order')))
          .map((e) => [e.getAttribute('data-kind'), e.getAttribute('data-color'), e.getAttribute('data-at')]),
      ),
      { timeout: 15_000 },
    )
    .toEqual([
      ['later', 'red', 'fold'],
      ['running', 'blue', 'row'],
      ['t-mine', 'gray', 'fold'],
      ['human', 'orange', (await items(page)).some((i) => has(i, 'pending/human')) ? 'row' : 'fold'],
    ]);
  await expect(tally(page, 'later')).toContainText('以后再说');
  await expect(tally(page, 'running')).toContainText('在跑 2');
  await page.getByTestId('open-settings').click();
  await unfoldSettings(page);
  for (const [id, f] of [['later', 'always'], ['running', 'never'], ['t-mine', 'zero'], ['human', 'zero']]) await expect(sel(id)).toHaveValue(f);
  // changing one row saves the rule on that row and moves nothing else
  await sel('t-mine').selectOption('never');
  await expect
    .poll(async () => (await stored(app)).tallies)
    .toEqual(old.map((d) => (d.id === 't-mine' ? { ...d, fold: 'never' } : d)));
  await app.close();
});

// GitHub#643: a "稍后处理" number written by hand — a condition of one's own that picks just the parked label, as
// a table saved before 稍后处理 joined the default table has it — folds always by default, whatever its count.
const WRITTEN = [
  { id: 'unlabeled', name: '未处理', color: 'ring', source: { kind: 'query', query: 'no:label' } },
  { id: 'human', name: '等人处理', color: 'orange', source: { kind: 'flow', flow: 'human' } },
  { id: 'agent', name: '等 agent', color: 'blue', source: { kind: 'flow', flow: 'agent' } },
  { id: 'running', name: '运行中', color: 'green', source: { kind: 'flow', flow: 'running' } },
];
const writtenRow = (query: string) => ({ id: 't-mine', name: '稍后处理', color: 'purple', source: { kind: 'query', query } });
const foldSel = (page: Page) => page.locator('[data-testid="tally-row"][data-id="t-mine"]').getByTestId('tally-fold');
async function toSettings(page: Page) {
  await page.getByTestId('open-settings').click();
  await unfoldSettings(page);
  await page.evaluate(() => document.getElementById('set-tallies')!.scrollIntoView({ block: 'start' }));
}
const savedFold = async (app: RunningApp) => (((await stored(app)).tallies as any[] | undefined) ?? []).find((d) => d.id === 't-mine')?.fold;

test('GitHub#643: a written 稍后处理 number folds always by default — a click works from the fold, a rule picked in Settings wins and is kept, no source ticked still folds', async () => {
  let app = await launchApp(env);
  let page = app.page;
  await ready(page);
  await only(page, 'pending/later', 3);
  await page.evaluate((t) => (window as any).cavil.setTallies(t), [...WRITTEN, writtenRow('label:"pending/later"')]);

  // 1. default: in the fold with 3, "总是折叠"; Settings' picker and preview agree; the same after a restart
  await expect(tally(page, 't-mine')).toHaveAttribute('data-at', 'fold');
  await expect(tally(page, 't-mine').getByTestId('tally-count')).toHaveText('3');
  await toggle(page).click();
  await expect(tally(page, 't-mine').getByTestId('tally-fold-why')).toHaveText('总是折叠');
  await page.keyboard.press('Escape');
  await toSettings(page);
  await expect(foldSel(page)).toHaveValue('always');
  await expect(page.getByTestId('tally-preview-fold').locator('[data-kind="t-mine"]')).toHaveCount(1);
  await shot(page, 'flow-tally-fold-643-settings');
  await page.getByTestId('back').click();
  expect(await savedFold(app)).toBeUndefined();
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await expect(tally(page, 't-mine')).toHaveAttribute('data-at', 'fold', { timeout: 15_000 });

  // 2. a click from the fold: the search becomes its condition and lists what it counts; again: the old search; it stays folded
  await page.getByTestId('search').fill('bug');
  await page.getByTestId('search').press('Enter');
  await toggle(page).click();
  await tally(page, 't-mine').click();
  await expect(page.getByTestId('search')).toHaveValue('label:"pending/later"');
  await expect(tally(page, 't-mine')).toHaveAttribute('aria-pressed', 'true');
  await expect(tally(page, 't-mine')).toHaveAttribute('data-at', 'fold');
  await shot(page, 'flow-tally-fold-643-lit');
  await press(page, 't-mine');
  await expect(page.getByTestId('search')).toHaveValue('bug');
  await expect(tally(page, 't-mine')).toHaveAttribute('data-at', 'fold');

  // 3. a rule picked in Settings wins: 不折叠 → in the bar at once, saved, kept after a restart; 总是折叠 → back in the fold
  await toSettings(page);
  await foldSel(page).selectOption('never');
  await expect(foldSel(page)).toHaveValue('never');
  await expect(page.getByTestId('tally-preview-fold').locator('[data-kind="t-mine"]')).toHaveCount(0);
  await expect.poll(() => savedFold(app)).toBe('never');
  await page.getByTestId('back').click();
  await expect(tally(page, 't-mine')).toHaveAttribute('data-at', 'row');
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await expect(tally(page, 't-mine')).toHaveAttribute('data-at', 'row', { timeout: 15_000 });
  await toSettings(page);
  await expect(foldSel(page)).toHaveValue('never');
  await foldSel(page).selectOption('always');
  await expect.poll(() => savedFold(app)).toBe('always');
  await page.getByTestId('back').click();
  await expect(tally(page, 't-mine')).toHaveAttribute('data-at', 'fold');

  // 5. no source ticked: every number 0; the written row is still judged against the shared name and folds always
  await page.evaluate((t) => (window as any).cavil.setTallies(t), [...WRITTEN, writtenRow('label:"pending/later"')]);
  await page.evaluate(() => (window as any).cavil.setView({ selected: [] }));
  await expect(tally(page, 't-mine').getByTestId('tally-count')).toHaveText('0');
  await expect(tally(page, 't-mine')).toHaveAttribute('data-at', 'fold');
  await toSettings(page);
  await expect(foldSel(page)).toHaveValue('always');
  await app.close();
});

// GitHub#643 (PR #645 review round 1): two real repository sources. alpha calls its parked label 待排期 and parks two
// items with it; beta uses 待排期 as an ordinary label on one item. Ticked: alpha → alpha + beta → alpha.
const issue = (repo: string, n: number, labels: string[]) => ({
  number: n,
  node_id: `I_fixture_${repo}${n}`,
  title: `${repo} issue ${n}`,
  state: 'open',
  html_url: `https://github.com/GigleAI/${repo}/issues/${n}`,
  updated_at: '2026-11-04T00:00:00Z',
  labels: labels.map((name) => ({ name, color: 'ededed' })),
  assignees: [],
  milestone: null,
  user: { login: 'user-1' },
  parent_issue_url: null,
  sub_issues_summary: null,
});

test('GitHub#643: the ticked repositories decide — only the one that renamed its parked label folds the written row; a repository using that name as an ordinary label puts it in the bar; a Project too; unticked, it folds again — also mid-sync', async () => {
  env.fake.state.repos.set('gigleai/alpha', [issue('alpha', 1, ['待排期']), issue('alpha', 2, ['待排期']), issue('alpha', 3, ['bug'])]);
  env.fake.state.repos.set('gigleai/beta', [issue('beta', 1, ['待排期']), issue('beta', 2, ['bug'])]);
  let app = await launchApp(env);
  let page = app.page;
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await unfoldSettings(page);
  for (const r of ['GigleAI/alpha', 'GigleAI/beta']) {
    await page.getByTestId('source-input').fill(r);
    await page.getByTestId('source-add').click();
  }
  await page.getByTestId('back').click();
  await expect.poll(async () => (await items(page)).length, { timeout: 15_000 }).toBe(5);
  // alpha alone renamed its parked label (a rename done for that repository only)
  await app.backend.call('setSetting', { key: 'repoLabels', value: { 'gigleai/alpha': { hand: { later: '待排期' } } } });
  await page.evaluate((t) => (window as any).cavil.setTallies(t), [...WRITTEN, writtenRow('label:"待排期"')]);
  await expect.poll(async () => (((await stored(app)).tallies as any[] | undefined) ?? []).map((d) => d.id)).toContain('t-mine');
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => (window as any).cavil.setView({ layout: 'table' }));
  const keys: string[] = (await page.evaluate(async () => (await (window as any).cavil.get()).state.sources)).map((s: any) => s.key);
  expect(keys).toEqual(['repo:gigleai/alpha', 'repo:gigleai/beta']);
  const [alpha, beta] = keys;
  const at = async () => [await tally(page, 't-mine').getAttribute('data-at'), await tally(page, 't-mine').getByTestId('tally-count').textContent()];
  const listed = () => page.locator('[data-testid="row"]:not([data-pulled]):not([data-carried])').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')).sort());
  /** click the number: its condition goes into the search box and the table lists exactly what it counts; click again: the search before */
  const clickLists = async (want: string[]) => {
    await page.getByTestId('search').fill('bug');
    await page.getByTestId('search').press('Enter');
    await press(page, 't-mine');
    await expect(page.getByTestId('search')).toHaveValue('label:"待排期"');
    await expect.poll(listed).toEqual(want);
    await press(page, 't-mine');
    await expect(page.getByTestId('search')).toHaveValue('bug');
  };
  const A = ['gigleai/alpha#1', 'gigleai/alpha#2'];
  const AB = [...A, 'gigleai/beta#1'].sort();

  // ① only alpha: 2, folded
  await page.evaluate((k) => (window as any).cavil.setView({ selected: [k] }), alpha);
  await expect.poll(at, { timeout: 15_000 }).toEqual(['fold', '2']);
  await clickLists(A);
  await shot(page, 'flow-tally-fold-643-alpha');
  // ② alpha + beta (beta's 待排期 is an ordinary label): 3, in the bar; Settings' picker says 为 0 时折叠
  await page.evaluate((k) => (window as any).cavil.setView({ selected: k }), [alpha, beta]);
  await expect.poll(at, { timeout: 15_000 }).toEqual(['row', '3']);
  await clickLists(AB);
  await toSettings(page);
  await expect(foldSel(page)).toHaveValue('zero');
  await page.getByTestId('back').click();
  // ③ alpha alone again: 2, folded
  await page.evaluate((k) => (window as any).cavil.setView({ selected: [k] }), alpha);
  await expect.poll(at, { timeout: 15_000 }).toEqual(['fold', '2']);
  await clickLists(A);

  // mid-sync: every request held, the client really syncing — the row stays where it was, and after
  const release = env.fake.holdWhen(() => true);
  await page.evaluate(() => {
    void (window as any).cavil.syncNow();
  });
  await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.sync.syncing), { timeout: 15_000 }).toBe(true);
  expect(await at()).toEqual(['fold', '2']);
  await page.evaluate((k) => (window as any).cavil.setView({ selected: k }), [alpha, beta]);
  await expect.poll(at).toEqual(['row', '3']);
  expect(await page.evaluate(async () => (await (window as any).cavil.get()).state.sync.syncing)).toBe(true);
  release();
  await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.sync.syncing), { timeout: 15_000 }).toBe(false);
  expect(await at()).toEqual(['row', '3']);
  await app.close();
});

test('GitHub#643: a Project ticked (which repositories it holds cannot be told) and one repository renamed its parked label: the written row stays in the bar', async () => {
  let app = await launchApp(env);
  let page = app.page;
  await ready(page);
  await page.getByTestId('open-settings').click();
  await unfoldSettings(page);
  await page.getByTestId('source-input').fill('https://github.com/GigleAI/cavil-loop');
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  const all = await items(page);
  const parked = all.filter((i) => i.state === 'open' && i.repo.toLowerCase() === REPO.toLowerCase()).slice(0, 2);
  for (const i of parked) setLabel(i, '待排期', true);
  await sync(page, (xs) => xs.filter((i) => has(i, '待排期')).length >= 2);
  await app.backend.call('setSetting', { key: 'repoLabels', value: { 'gigleai/cavil-loop': { hand: { later: '待排期' } } } });
  await page.evaluate((t) => (window as any).cavil.setTallies(t), [...WRITTEN, writtenRow('label:"待排期"')]);
  await expect.poll(async () => (((await stored(app)).tallies as any[] | undefined) ?? []).map((d) => d.id)).toContain('t-mine');
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  const keys: string[] = (await page.evaluate(async () => (await (window as any).cavil.get()).state.sources)).map((s: any) => s.key);
  const repoKey = keys.find((k) => k.startsWith('repo:'))!;
  const at = async () => [await tally(page, 't-mine').getAttribute('data-at'), await tally(page, 't-mine').getByTestId('tally-count').textContent()];
  // only the repository: folded
  await page.evaluate((k) => (window as any).cavil.setView({ selected: [k] }), repoKey);
  await expect.poll(at, { timeout: 15_000 }).toEqual(['fold', '2']);
  // the Project too: in the bar, the picker says 为 0 时折叠
  await page.evaluate((k) => (window as any).cavil.setView({ selected: k }), keys);
  await expect.poll(at, { timeout: 15_000 }).toEqual(['row', '2']);
  await toSettings(page);
  await expect(foldSel(page)).toHaveValue('zero');
  await page.getByTestId('back').click();
  // the Project unticked again: folded
  await page.evaluate((k) => (window as any).cavil.setView({ selected: [k] }), repoKey);
  await expect.poll(at, { timeout: 15_000 }).toEqual(['fold', '2']);
  await app.close();
});
