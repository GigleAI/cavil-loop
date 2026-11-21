// GigleAI/cavil-loop#634: the view bar folds some numbers into a "⋯ 折叠 N" button at its end — by each row's
// rule in Settings → 顶栏计数: never / at 0 / always (default: 运行中 never, 稍后处理 always, the rest at 0).
// The real window on the real back end, the fake GitHub serving the recorded board. Counts move by changing
// labels in the fake GitHub and syncing, as they do in use. Expected counts are written out here (open items
// carrying the label; "等人处理" open or closed), not computed with the app's functions.
//  - folding moves where a number is drawn, nothing else: a lit number that drops to 0 stays lit (the fold
//    button lights up), comes back lit, and a click still gives the search from before
//  - keyboard focus follows the number between the row and the fold
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
import { tally } from './tally';
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

  // Esc closes it, focus back on its button; a press elsewhere closes it too
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
