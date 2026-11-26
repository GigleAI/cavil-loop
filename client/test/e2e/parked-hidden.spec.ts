// GigleAI/cavil-loop#708: while the search box is empty the board, the table and the graph leave out items carrying
// their repository's parked label ("稍后处理", default pending/later) — and the board and the table no longer bring
// them back as related items (a sub-issue under its parent, an issue under its PR). The graph still draws a parked
// item that is the other end of an ordinary item's relation, faded, so "被 N 项挡住" stays true. Any condition in
// the search box (a lit number included) shows everything as before; the parked label left empty hides nothing.
// The rows of the acceptance matrix on the issue, in the real window (built with --test-bridge), the real back end
// behind the loopback bridge, the fake GitHub serving recorded boards. The relations recording: #346 ⊃ #349 #350,
// #349 blocks #350, all open, nothing else open is related to them. Labels move by changing them in the fake GitHub
// and syncing. Expected items and numbers are written out here from what the window holds, not with the app's
// functions. Screenshots land in test-results/screens/.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCavilProjectPages, loadRelationIssues, loadRelationPages, startFakeGitHub } from '../fake-github/server';
import { findCopies } from '../fake-github/writes';
import { launchApp, closeEngine, type AppEnv } from './bridge';
import { unfoldSettings } from './unfold';
import { press, tally } from './tally';
import type { Item } from '../../src/shared/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const LATER = 'pending/later';
const K = (n: number) => `gigleai/cavil-loop#${n}`;

let env: AppEnv;
function start(projects: () => any, repo: boolean, viewer?: string) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-parked-'));
    env = {
      fake: await startFakeGitHub({
        ...(viewer ? { viewer } : {}),
        projects: new Map([['org/gigleai/11', projects()]]),
        ...(repo ? { repos: new Map([['gigleai/cavil-loop', loadRelationIssues()]]) } : {}),
      }),
      userData: join(dir, 'userData'),
      cred: join(dir, 'cred'),
      opened: join(dir, 'opened.txt'),
      requests: join(dir, 'requests.txt'),
    };
  };
}
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

const items = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).data.items as Item[]);
const has = (i: Item, label: string) => i.labels.some((l) => l.name.toLowerCase() === label.toLowerCase());
const parked = (i: Item) => has(i, LATER);
const keys = (xs: Item[]) => xs.map((i) => i.key).sort();
/** the table's own rows (not pulled under a parent, not carried by a PR) */
const rowKeys = (page: Page) => page.$$eval('[data-testid="row"]:not([data-pulled]):not([data-carried])', (rs) => [...new Set(rs.map((r) => r.getAttribute('data-key')!))].sort());
/** every row the table draws, pulled and carried ones included */
const allRowKeys = (page: Page) => page.$$eval('[data-testid="row"]', (rs) => [...new Set(rs.map((r) => r.getAttribute('data-key')!))].sort());
const cardKeys = (page: Page) => page.$$eval('[data-testid="card"]', (cs) => [...new Set(cs.map((c) => c.getAttribute('data-key')!))].sort());
const node = (page: Page, n: number) => page.locator(`[data-testid="graph-node"][data-key="${K(n)}"]`);
const box = (page: Page, n: number) => page.locator(`[data-testid="graph-box"][data-key="${K(n)}"]`);
/** the graph's drawn items at full strength (its entries): every item it draws has one node (a box has it as its head) */
const strongKeys = (page: Page) =>
  page.$$eval('[data-testid="graph-node"][data-dim="no"][data-outside="no"]', (els) => [...new Set(els.map((e) => e.getAttribute('data-key')!))]);
const allCount = (page: Page) => page.locator('[data-testid="slice"][data-value=""] .count');
const layout = async (page: Page, l: 'table' | 'board' | 'graph') => {
  await page.locator(`[data-testid="layout"] button[data-value="${l}"]`).click();
  await expect(page.getByTestId(l === 'graph' ? 'graph' : l === 'table' ? 'table' : 'board')).toBeVisible();
};
const tip = (page: Page) => tally(page, 'human');
const HIDDEN_TIP = (n: number) => new RegExp(`\\n另有 ${n} 个稍后处理的条目没显示（点「稍后处理」查看）(\\n|$)`);

/** put labels on / take them off items in the fake GitHub (every copy it serves), as a label change on GitHub would */
function setLabel(n: number, name: string, on: boolean) {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const c = findCopies(store as any, REPO, n);
  if (!c) throw new Error(`the fake GitHub does not serve #${n}`);
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
async function park(page: Page, ns: number[]) {
  for (const n of ns) setLabel(n, LATER, true);
  await sync(page, (all) => ns.every((n) => all.some((i) => i.key === K(n) && parked(i))));
}

async function signIn(page: Page, sources: string[]) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await unfoldSettings(page);
  for (const s of sources) {
    await page.getByTestId('source-input').fill(s);
    await page.getByTestId('source-add').click();
  }
  await expect(page.getByTestId('source-row')).toHaveCount(sources.length);
  await page.getByTestId('back').click();
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('search').fill('');
  // every source read whole (both of them, not just the first one in), and the item list settled
  await expect
    .poll(async () => {
      const ss = (await page.evaluate(async () => (await (window as any).cavil.get()).state.sync.sources)) as { ok: boolean }[];
      return ss.length === sources.length && ss.every((x) => x.ok);
    }, { timeout: 20_000 })
    .toBe(true);
  let last = -1;
  await expect
    .poll(async () => {
      const n = (await items(page)).length;
      const same = n === last;
      last = n;
      return same && n > 0;
    }, { timeout: 20_000, intervals: [500] })
    .toBe(true);
  // the graph lists closed items too, so it has ordinary entries (the recorded closed families) besides #346's
  await page.evaluate(() => (window as any).cavil.setView({ showClosed: { graph: true } }));
}
async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
}
const setHierarchy = (page: Page, on: boolean) => page.evaluate((h) => (window as any).cavil.setView({ table: { hierarchy: h } }), on);

test.describe('relations board', () => {
  test.beforeEach(start(loadRelationPages, true));

  test('GitHub#708 rows 1–5: #346 ⊃ #349 #350 all parked — left out of every layout, back on 「稍后处理」, a search or an empty parked label', async () => {
    const { page } = await launchApp(env);
    await signIn(page, [PROJECT_URL, REPO]);
    await setHierarchy(page, true);
    const before = await items(page);
    const openBefore = before.filter((i) => i.state === 'open');
    const family = [346, 349, 350];
    // not vacuous: the family is open and listed, and there is more to list than the family
    for (const n of family) expect(openBefore.some((i) => i.key === K(n))).toBe(true);
    expect(openBefore.length).toBeGreaterThan(family.length);
    await expect.poll(() => rowKeys(page)).toEqual(keys(openBefore));
    await expect(allCount(page)).toHaveText(String(openBefore.length));
    const listedBefore = openBefore.length;
    await layout(page, 'graph');
    for (const n of family) await expect(node(page, n)).toBeVisible();
    await layout(page, 'table');

    await park(page, family);
    const all = await items(page);
    const ordinaryOpen = all.filter((i) => i.state === 'open' && !parked(i));
    expect(ordinaryOpen.length).toBeGreaterThan(0);

    // ---- row 1: search empty — the table and the board list none of the three, hierarchy on or off ----
    await expect.poll(() => allRowKeys(page)).toEqual(keys(ordinaryOpen));
    await expect(allCount(page)).toHaveText(String(listedBefore - 3));
    await setHierarchy(page, false);
    await expect.poll(() => allRowKeys(page)).toEqual(keys(ordinaryOpen));
    await setHierarchy(page, true);
    await expect(tally(page, 'later').getByTestId('tally-count')).toHaveText('3');
    await expect(tip(page)).toHaveAttribute('title', HIDDEN_TIP(3));
    await shot(page, 'parked-hidden-01-table');
    await layout(page, 'board');
    if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').first().click();
    await expect.poll(() => cardKeys(page)).toEqual(keys(ordinaryOpen));
    // the graph: none of the three anywhere (nothing ordinary relates to them); its ordinary entries are drawn
    await layout(page, 'graph');
    for (const n of family) await expect(node(page, n)).toHaveCount(0);
    const strong = await strongKeys(page);
    expect(strong.length).toBeGreaterThan(0);
    for (const n of family) expect(strong).not.toContain(K(n));
    await shot(page, 'parked-hidden-02-graph');

    // ---- row 2: 「稍后处理」 clicked (the graph has no view-bar numbers: from the table) — the three listed, solid in the graph; no hidden line ----
    await layout(page, 'table');
    await press(page, 'later');
    await expect(page.getByTestId('search')).toHaveValue(`label:"${LATER}"`);
    await expect.poll(() => rowKeys(page)).toEqual(family.map(K).sort());
    await expect(allCount(page)).toHaveText('3');
    await expect(tip(page)).not.toHaveAttribute('title', /稍后处理的条目没显示/);
    await layout(page, 'graph');
    for (const n of family) await expect(node(page, n)).toHaveAttribute('data-dim', 'no');
    await layout(page, 'board');
    await expect.poll(() => cardKeys(page)).toEqual(family.map(K).sort());

    // ---- row 3: clicked again — back to row 1 ----
    await press(page, 'later');
    await expect(page.getByTestId('search')).toHaveValue('');
    await expect.poll(() => cardKeys(page)).toEqual(keys(ordinaryOpen));
    await layout(page, 'table');
    await expect.poll(() => allRowKeys(page)).toEqual(keys(ordinaryOpen));
    await expect(tip(page)).toHaveAttribute('title', HIDDEN_TIP(3));

    // ---- row 4: #346's title searched — #346 listed (its sub-issues pulled under it, as any search does), solid in the graph ----
    await page.getByTestId('search').fill('新增依赖图视图');
    await expect.poll(() => rowKeys(page)).toEqual([K(346)]);
    await expect.poll(() => allRowKeys(page)).toEqual(family.map(K).sort());
    await expect(tip(page)).not.toHaveAttribute('title', /稍后处理的条目没显示/);
    await layout(page, 'graph');
    await expect(node(page, 346)).toHaveAttribute('data-dim', 'no');
    for (const n of [349, 350]) await expect(node(page, n)).toHaveAttribute('data-dim', 'yes');
    await page.getByTestId('search').fill('');
    await layout(page, 'table');
    await expect.poll(() => allRowKeys(page)).toEqual(keys(ordinaryOpen));

    // ---- row 5: the parked label left empty — nothing hidden, no 「稍后处理」 number ----
    await page.evaluate(() => (window as any).cavil.setHandBack({ later: '' }));
    await expect.poll(() => rowKeys(page)).toEqual(keys(all.filter((i) => i.state === 'open')));
    await expect(allCount(page)).toHaveText(String(listedBefore));
    await expect(tally(page, 'later')).toHaveCount(0);
    await expect(tip(page)).not.toHaveAttribute('title', /稍后处理的条目没显示/);
    await layout(page, 'graph');
    for (const n of family) await expect(node(page, n)).toHaveAttribute('data-dim', 'no');
  });

  test('GitHub#708 rows 8 / 8b: an ordinary parent #346 with a parked sub-issue #350 — not listed, not pulled; faded in the graph; listed when searched', async () => {
    const { page } = await launchApp(env);
    await signIn(page, [PROJECT_URL, REPO]);
    await setHierarchy(page, true);
    const openBefore = (await items(page)).filter((i) => i.state === 'open');
    await expect(allCount(page)).toHaveText(String(openBefore.length));
    const listedBefore = openBefore.length;
    await park(page, [350]);
    const all = await items(page);
    const ordinaryOpen = all.filter((i) => i.state === 'open' && !parked(i));
    expect(ordinaryOpen.map((i) => i.key)).toContain(K(346));
    expect(ordinaryOpen.map((i) => i.key)).toContain(K(349));

    for (const h of [true, false]) {
      await setHierarchy(page, h);
      await expect.poll(() => allRowKeys(page)).toEqual(keys(ordinaryOpen));
    }
    await setHierarchy(page, true);
    await expect(allCount(page)).toHaveText(String(listedBefore - 1));
    await expect(tally(page, 'later').getByTestId('tally-count')).toHaveText('1');
    await expect(tip(page)).toHaveAttribute('title', HIDDEN_TIP(1));
    await layout(page, 'board');
    if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').first().click();
    await expect.poll(() => cardKeys(page)).toEqual(keys(ordinaryOpen));
    await layout(page, 'graph');
    // #350 drawn faded inside #346's box, not one of the graph's entries; #346 and #349 at full strength
    await expect(node(page, 350)).toHaveAttribute('data-dim', 'yes');
    await expect(node(page, 346)).toHaveAttribute('data-dim', 'no');
    await expect(node(page, 349)).toHaveAttribute('data-dim', 'no');
    const b = (await box(page, 346).boundingBox())!;
    const c = (await node(page, 350).boundingBox())!;
    expect(c.x >= b.x && c.y >= b.y && c.x + c.width <= b.x + b.width + 0.5 && c.y + c.height <= b.y + b.height + 0.5).toBe(true);
    await shot(page, 'parked-hidden-03-graph-child');

    // ---- 8b: #350's title searched — listed, solid ----
    await page.getByTestId('search').fill('父子框、阻塞箭头');
    await expect(node(page, 350)).toHaveAttribute('data-dim', 'no');
    await layout(page, 'table');
    await expect.poll(() => rowKeys(page)).toEqual([K(350)]);
    await layout(page, 'board');
    await expect.poll(() => cardKeys(page)).toContain(K(350));
  });

  test('GitHub#708 rows 9 / 9b: #350 blocked by a parked #349 — #349 not listed; faded in the graph and #350 still blocked by 1; listed when searched', async () => {
    const { page } = await launchApp(env);
    await signIn(page, [PROJECT_URL, REPO]);
    await park(page, [349]);
    const all = await items(page);
    const ordinaryOpen = all.filter((i) => i.state === 'open' && !parked(i));
    await expect.poll(() => allRowKeys(page)).toEqual(keys(ordinaryOpen));
    expect(ordinaryOpen.map((i) => i.key)).toContain(K(350));
    await expect(tally(page, 'later').getByTestId('tally-count')).toHaveText('1');
    await expect(tip(page)).toHaveAttribute('title', HIDDEN_TIP(1));
    await layout(page, 'board');
    if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').first().click();
    await expect.poll(() => cardKeys(page)).toEqual(keys(ordinaryOpen));
    await layout(page, 'graph');
    await expect(node(page, 349)).toHaveAttribute('data-dim', 'yes');
    await expect(page.locator(`[data-testid="graph-edge"][data-from="${K(349)}"][data-to="${K(350)}"]`)).toHaveCount(1);
    await expect(node(page, 350).getByTestId('graph-blocked-by')).toHaveText('被 1 项挡住');
    await expect(node(page, 350)).toHaveAttribute('data-dim', 'no');

    // ---- 9b: #349's title searched — listed, solid ----
    await page.getByTestId('search').fill('读取子 issue 列表');
    await expect(node(page, 349)).toHaveAttribute('data-dim', 'no');
    await layout(page, 'table');
    await expect.poll(() => rowKeys(page)).toEqual([K(349)]);
  });

  test('GitHub#708 row 7: a closed parked item stays out with 「显示已关闭」 on; the number counts open items only', async () => {
    const { page } = await launchApp(env);
    await signIn(page, [PROJECT_URL, REPO]);
    await page.evaluate(() => (window as any).cavil.setView({ showClosed: { table: true } }));
    await expect(page.getByTestId('show-closed')).toBeChecked();
    const before = await items(page);
    // a closed issue the window holds (the recording's closed families)
    const closed = before.find((i) => i.state !== 'open' && i.kind === 'issue' && !parked(i))!;
    expect(closed).toBeTruthy();
    await expect.poll(() => rowKeys(page)).toEqual(keys(before));
    await expect(allCount(page)).toHaveText(String(before.length));
    const listedBefore = before.length;
    setLabel(closed.number, LATER, true);
    await sync(page, (all) => all.some((i) => i.key === closed.key && parked(i)));
    await expect.poll(() => rowKeys(page)).toEqual(keys(before.filter((i) => i.key !== closed.key)));
    await expect(allCount(page)).toHaveText(String(listedBefore - 1));
    await expect(tally(page, 'later').getByTestId('tally-count')).toHaveText('0');
    await expect(tip(page)).toHaveAttribute('title', HIDDEN_TIP(1));
  });
});

test.describe('only mine', () => {
  const ME = 'user-6';
  test.beforeEach(start(loadCavilProjectPages, false, ME));

  test('GitHub#708 rows 10 / 10b: 「只看我的」 on, my open PR and its parked issue by someone else — the PR alone; the issue carried again when the PR is searched', async () => {
    const { page } = await launchApp(env);
    await signIn(page, [PROJECT_URL]);
    await page.evaluate(() => (window as any).cavil.setView({ prsUnderIssues: true }));
    const all0 = await items(page);
    // an open issue linked to an open PR of mine
    const pair = all0
      .filter((i) => i.kind === 'issue' && i.state === 'open')
      .flatMap((i) => (i.linkedPrs ?? []).map((l) => ({ issue: i, pr: all0.find((p) => p.key === l.key) })))
      .find((x) => x.pr && x.pr.state === 'open' && (x.pr.author ?? '').toLowerCase() === ME);
    test.skip(!pair, 'the recording no longer holds an open issue linked to an open PR of user-6');
    const { issue, pr } = pair!;
    // the issue is someone else's (and nobody assigns it to me), parked
    const c = findCopies({ projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w } as any, REPO, issue.number)!;
    for (const g of c.gql) {
      g.author = { ...(g.author ?? {}), login: 'user-1' };
      if (g.assignees) g.assignees = { ...g.assignees, nodes: [] };
    }
    for (const r of c.rest) {
      r.user = { ...(r.user ?? {}), login: 'user-1' };
      r.assignees = [];
    }
    setLabel(issue.number, LATER, true);
    await sync(page, (all) => all.some((i) => i.key === issue.key && parked(i) && (i.author ?? '').toLowerCase() === 'user-1'));
    await page.evaluate(() => (window as any).cavil.setMineFilter({ on: true, author: true, assignee: true }));

    for (const l of ['table', 'board'] as const) {
      await layout(page, l);
      if (l === 'board' && (await page.getByTestId('ended-group').count())) await page.getByTestId('ended-group').first().click();
      const drawn = l === 'table' ? allRowKeys : cardKeys;
      await expect.poll(() => drawn(page)).toContain(pr!.key);
      await expect.poll(() => drawn(page)).not.toContain(issue.key);
    }
    // the issue is not mine: the number counts nothing of it, and nothing of mine is hidden
    await expect(tally(page, 'later').getByTestId('tally-count')).toHaveText('0');
    await expect(tip(page)).not.toHaveAttribute('title', /稍后处理的条目没显示/);
    await layout(page, 'graph');
    await expect.poll(() => strongKeys(page)).not.toContain(issue.key);

    // ---- 10b: the PR searched — its issue carried, faded, as before ----
    await page.getByTestId('search').fill(pr!.title);
    await layout(page, 'table');
    await expect.poll(() => page.$$eval(`[data-testid="row"][data-carried][data-key="${issue.key}"]`, (rs) => rs.length)).toBeGreaterThan(0);
    await layout(page, 'board');
    await expect.poll(() => page.$$eval(`[data-testid="card"][data-carried][data-key="${issue.key}"]`, (cs) => cs.length)).toBeGreaterThan(0);
  });
});
