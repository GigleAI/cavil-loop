// GigleAI/cavil-loop#404: the view bar's right end shows "运行中 / 等 agent / 等人处理" instead of
// "显示 N / M 条 · 另有 K 个子 issue 随父 issue 显示". In the real window (built with --test-bridge),
// the real back end behind the loopback bridge, the fake GitHub serving the board recorded from the
// real cavil project. The expected numbers are counted here straight from the items the window holds,
// with a rule written out in this file (open, whole label name, any case) — not with the app's function.
// GitHub#418: a fourth number, "未处理" — open items with no label at all; its click is `is:open no:label`.
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
/** GitHub#418: drop the labels of the items numbered in `unlabel`, wherever the recorded GitHub answers carry them */
function stripLabels<T>(data: T, unlabel: number[]): T {
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.number === 'number' && unlabel.includes(o.number) && o.labels) {
      if (Array.isArray(o.labels)) o.labels = [];
      else if (Array.isArray(o.labels.nodes)) {
        o.labels.nodes = [];
        if ('totalCount' in o.labels) o.labels.totalCount = 0;
      }
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(data);
  return data;
}
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-tally-'));
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
/** open items carrying the label (whole name, any case) — written out here, independent of the app; `anyState` = closed ones too ("等人处理", GitHub#462) */
const expected = async (page: Page, label: string, anyState = false) =>
  (await items(page)).filter((i) => (anyState || i.state === 'open') && i.labels.some((l) => l.name.toLowerCase() === label.toLowerCase())).length;
const tally = (page: Page, kind: string) => page.locator(`[data-testid="tally"][data-kind="${kind}"]`);
const countOf = async (page: Page, kind: string) => Number(await tally(page, kind).getByTestId('tally-count').textContent());
const shown = (page: Page) => page.locator('[data-testid="row"]:not([data-pulled])');

async function ready(page: Page) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill('https://github.com/orgs/GigleAI/projects/11');
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('search')).toHaveValue('-label:Done -status:Done', { timeout: 15_000 });
  await expect(page.getByTestId('table')).toBeVisible();
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
}

test('GitHub#404: three flow numbers replace "显示 N / M 条…"; the same with or without a search; a click filters, a second click gives the search back', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  const bar = page.locator('.vbar');

  // ---- the numbers: open items per label, counted from what the window holds ----
  await expect(page.getByTestId('tally')).toHaveCount(4);
  await expect(page.getByTestId('tally').last()).toHaveAttribute('data-kind', 'unlabeled');
  const want = { running: await expected(page, 'doing/agent'), agent: await expected(page, 'pending/agent'), human: await expected(page, 'pending/human', true) };
  // the recorded board really has items in flow, so equality is not 0 = 0
  expect(want.running).toBeGreaterThan(0);
  const now = async () => ({ running: await countOf(page, 'running'), agent: await countOf(page, 'agent'), human: await countOf(page, 'human') });
  expect(await now()).toEqual(want);
  await expect(tally(page, 'running')).toContainText(`运行中 ${want.running}`);
  await expect(tally(page, 'human')).toHaveAttribute('title', new RegExp(`^带 pending/human 标签的条目（开着的和已关闭的都算）有 ${want.human} 个 · 点一下只看这些\\n当前来源共 ${(await items(page)).length} 个条目\\n搜索命中 \\d+ 条`));
  // the old sentence is gone, with or without a search
  await expect(bar).not.toContainText('显示');
  // the total is kept only for screen readers (and as the hover's second line)
  await expect(page.getByTestId('item-total')).toHaveClass('sr-only');
  await shot(page, 'flow-tally-01-searching');

  // ---- a search does not change them ----
  await page.getByTestId('search').fill('新增依赖图视图');
  await expect(page.locator('[data-testid="row"][data-pulled]')).not.toHaveCount(0);
  expect(await now()).toEqual(want);
  await expect(bar).not.toContainText('随父 issue 显示');
  await page.getByTestId('search').fill('');
  expect(await now()).toEqual(want);
  // the total is kept only for screen readers (and as the hover's second line)
  await expect(page.getByTestId('item-total')).toHaveClass('sr-only');
  await shot(page, 'flow-tally-02-no-search');

  // ---- a search, click 运行中, click again: the search comes back whole ----
  await page.getByTestId('search').fill('新增依赖图视图');
  await tally(page, 'running').click();
  await expect(page.getByTestId('search')).toHaveValue('is:open label:"doing/agent"');
  await expect(tally(page, 'running')).toHaveAttribute('aria-pressed', 'true');
  await expect(tally(page, 'running')).toHaveAttribute('title', /再点一下回到之前的搜索/);
  await expect(shown(page)).toHaveCount(want.running);
  for (const k of await shown(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))) {
    const it = (await items(page)).find((i) => i.key === k)!;
    expect(it.state).toBe('open');
    expect(it.labels.map((l) => l.name.toLowerCase())).toContain('doing/agent');
  }
  await shot(page, 'flow-tally-03-running-on');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'flow-tally-03-running-on-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await tally(page, 'running').click();
  await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');
  await expect(tally(page, 'running')).toHaveAttribute('aria-pressed', 'false');

  // ---- switching numbers keeps the first search ----
  await tally(page, 'running').click();
  await tally(page, 'human').click();
  await expect(page.getByTestId('search')).toHaveValue('label:"pending/human"');
  await expect(tally(page, 'human')).toHaveAttribute('aria-pressed', 'true');
  await expect(tally(page, 'running')).toHaveAttribute('aria-pressed', 'false');
  await tally(page, 'human').click();
  await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');

  // ---- the settings page in between does not lose the remembered search ----
  await tally(page, 'running').click();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('back').click();
  await expect(tally(page, 'running')).toHaveAttribute('aria-pressed', 'true');
  await tally(page, 'running').click();
  await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');

  // ---- a hand edit voids it: typed back to a number's query, a click gives an empty box ----
  await tally(page, 'running').click();
  await page.getByTestId('search').fill('bug');
  await page.getByTestId('search').fill('is:open label:"doing/agent"');
  await expect(tally(page, 'running')).toHaveAttribute('aria-pressed', 'true');
  await tally(page, 'running').click();
  await expect(page.getByTestId('search')).toHaveValue('');

  // ---- an empty box: click, click again → empty ----
  await tally(page, 'agent').click();
  await expect(page.getByTestId('search')).toHaveValue('is:open label:"pending/agent"');
  await tally(page, 'agent').click();
  await expect(page.getByTestId('search')).toHaveValue('');

  // ---- the board layout shows them too; the graph keeps its own sentence ----
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  expect(await now()).toEqual(want);
  await page.locator('[data-testid="layout"] button[data-value="graph"]').click();
  await expect(page.getByTestId('tally')).toHaveCount(0);
  await expect(page.getByTestId('graph-count')).toBeVisible();
});

test('GitHub#404: Settings — the running label can be renamed or cleared (the number goes); the two hand-back labels cleared come back as defaults and keep counting', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  await page.getByTestId('open-settings').click();
  const section = page.getByTestId('hand-back-settings');
  await expect(section.locator('h3')).toHaveText('流程标签（顶栏的三个数、「交给 agent」「托管」、关系图的 loop 前置登记都用这几个）');
  await expect(page.getByTestId('hand-back-running')).toHaveValue('doing/agent');
  await section.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.getElementById('set-hand-back')!.scrollIntoView({ block: 'start' }));
  await shot(page, 'flow-tally-04-settings');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'flow-tally-04-settings-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // another running label: the number follows it
  await page.getByTestId('hand-back-running').fill('pending/blocked');
  await page.getByTestId('hand-back-running').blur();
  await page.getByTestId('back').click();
  const blocked = await expected(page, 'pending/blocked');
  expect(blocked).toBeGreaterThan(0);
  await expect(tally(page, 'running').getByTestId('tally-count')).toHaveText(String(blocked));

  // a label the search box cannot carry (a leading ">" is a comparison the filter drops): shown, not clickable
  await page.getByTestId('open-settings').click();
  await page.getByTestId('hand-back-running').fill('>待处理');
  await page.getByTestId('hand-back-running').blur();
  await page.getByTestId('back').click();
  const before = await page.getByTestId('search').inputValue();
  await expect(tally(page, 'running')).toBeDisabled();
  await expect(tally(page, 'running')).toHaveAttribute('title', /写不进搜索框/);
  await tally(page, 'running').click({ force: true });
  await expect(page.getByTestId('search')).toHaveValue(before);

  // cleared: no "运行中"; the other two stay
  await page.getByTestId('open-settings').click();
  await page.getByTestId('hand-back-running').fill('');
  await page.getByTestId('hand-back-running').blur();
  await page.getByTestId('back').click();
  await expect(tally(page, 'running')).toHaveCount(0);
  await expect(page.getByTestId('tally')).toHaveCount(3);
  await expect(tally(page, 'unlabeled')).toHaveCount(1);
  await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.handBack.running)).toBe('');

  // the two hand-back labels cleared: the boxes show the defaults again, the numbers still count them
  const pendingBefore = await page.evaluate(async () => (await (window as any).cavil.get()).state.pendingCount);
  await page.getByTestId('open-settings').click();
  for (const id of ['hand-back-human', 'hand-back-agent']) {
    await page.getByTestId(id).fill('');
    await page.getByTestId(id).blur();
  }
  await expect(page.getByTestId('hand-back-human')).toHaveValue('pending/human');
  await expect(page.getByTestId('hand-back-agent')).toHaveValue('pending/agent');
  await expect
    .poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.handBack))
    .toEqual({ human: 'pending/human', agent: 'pending/agent', autopilot: 'autopilot', running: '', blocked: 'pending/blocked' });
  expect(await page.evaluate(async () => (await (window as any).cavil.get()).state.pendingCount)).toBe(pendingBefore);
  await page.getByTestId('back').click();
  await expect(tally(page, 'agent').getByTestId('tally-count')).toHaveText(String(await expected(page, 'pending/agent')));
  await expect(tally(page, 'human').getByTestId('tally-count')).toHaveText(String(await expected(page, 'pending/human', true)));
});

test('GitHub#418: 未处理 counts open issues / PRs with no label; a click shows exactly them, a second click gives the search back', async () => {
  // the recorded board has no open item without labels: #350 (open, only pending/blocked — none of the three
  // flow labels) is served without its labels, so it is the one "未处理"
  await env.fake.close();
  env.fake = await startFakeGitHub({
    projects: new Map([['org/gigleai/11', stripLabels(loadRelationPages(), [350])]]),
    repos: new Map([['gigleai/cavil-loop', stripLabels(loadRelationIssues(), [350])]]),
  });
  const { page } = await launchApp(env);
  await ready(page);
  const u = tally(page, 'unlabeled');

  /** open items with no label — written out here, independent of the app */
  const bare = async () => (await items(page)).filter((i) => i.state === 'open' && i.labels.length === 0);
  const want = await bare();
  expect(want.map((i) => i.number)).toEqual([350]);
  await expect(u.getByTestId('tally-count')).toHaveText('1');
  await expect(u).toContainText('未处理 1');
  await expect(u).toHaveAttribute('title', new RegExp(`^开着的条目里一个标签都没有的有 1 个 · 点一下只看这些\\n当前来源共 ${(await items(page)).length} 个条目`));
  // the three flow numbers are unchanged by it
  const flow = { running: await expected(page, 'doing/agent'), agent: await expected(page, 'pending/agent'), human: await expected(page, 'pending/human', true) };
  for (const [k, v] of Object.entries(flow)) await expect(tally(page, k).getByTestId('tally-count')).toHaveText(String(v));
  // a search does not change it
  await page.getByTestId('search').fill('新增依赖图视图');
  await expect(u.getByTestId('tally-count')).toHaveText('1');
  await shot(page, 'flow-tally-05-unlabeled');

  // click: the box says `is:open no:label`, lit, and the list is exactly the counted items
  await u.click();
  await expect(page.getByTestId('search')).toHaveValue('is:open no:label');
  await expect(u).toHaveAttribute('aria-pressed', 'true');
  await expect(u).toHaveAttribute('title', /再点一下回到之前的搜索/);
  await expect(shown(page)).toHaveCount(want.length);
  expect((await shown(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))).sort()).toEqual(want.map((i) => i.key).sort());
  await shot(page, 'flow-tally-06-unlabeled-on');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'flow-tally-06-unlabeled-on-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // switching to another number and back keeps the first search; the lit one again gives it back
  await tally(page, 'running').click();
  await expect(page.getByTestId('search')).toHaveValue('is:open label:"doing/agent"');
  await expect(u).toHaveAttribute('aria-pressed', 'false');
  await u.click();
  await expect(page.getByTestId('search')).toHaveValue('is:open no:label');
  await u.click();
  await expect(page.getByTestId('search')).toHaveValue('新增依赖图视图');
  await expect(u).toHaveAttribute('aria-pressed', 'false');

  // the board layout shows it too
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await expect(u.getByTestId('tally-count')).toHaveText('1');
});
