// GigleAI/cavil-loop#708 / #741: while the 「显示稍后处理」 switch is off (it is on by default since #741) the board,
// the table and the graph leave out items carrying their repository's parked label ("稍后处理", default
// pending/later) — and the board and the table do not bring them back as related items (a sub-issue under its
// parent, an issue under its PR). The graph still draws a parked item that is the other end of an ordinary item's
// relation, faded, so "被 N 项挡住" stays true. With the switch off any other search leaves them out too; a search
// that names the parked label itself (the lit 「稍后处理」 number included) decides instead and greys the switch
// out; the parked label left empty hides nothing and shows no switch.
// The rows of the acceptance matrix on #708 (run with the switch off), plus #741's switch, in the real window (built with --test-bridge), the real back end
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
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
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
const HIDDEN_TIP = (n: number) => new RegExp(`\\n另有 ${n} 个稍后处理的条目没显示（打开「显示稍后处理」查看）(\\n|$)`);
const parkedBox = (page: Page) => page.getByTestId('show-parked');
const parkedToggle = (page: Page) => page.getByTestId('show-parked-toggle');
/** GitHub#741: switch 「显示稍后处理」 by clicking it, as a person does */
async function showParked(page: Page, on: boolean) {
  await expect(parkedBox(page)).toBeEnabled();
  if ((await parkedBox(page).isChecked()) !== on) await parkedToggle(page).click();
  await expect(parkedBox(page)).toBeChecked({ checked: on });
  await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.view.showParked)).toBe(on);
}

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

  test('GitHub#708 rows 1–5 (switch off): #346 ⊃ #349 #350 all parked — left out of every layout and of another search, back on 「稍后处理」, the switch or an empty parked label', async () => {
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
    // GitHub#741: on by default — the three are listed until the switch is turned off
    await expect(parkedBox(page)).toBeChecked();
    await expect.poll(() => allRowKeys(page)).toEqual(keys(openBefore));
    await showParked(page, false);

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

    // ---- row 4 (GitHub#741): #346's title searched — with the switch off it stays out (the search names another
    // thing, not the parked label); a search that hits ordinary items too lists exactly those ----
    await page.getByTestId('search').fill('新增依赖图视图');
    await expect.poll(() => allRowKeys(page)).toEqual([]);
    await expect(parkedBox(page)).toBeEnabled();
    await page.getByTestId('search').fill('is:open');
    await expect.poll(() => allRowKeys(page)).toEqual(keys(ordinaryOpen));
    await expect(tip(page)).toHaveAttribute('title', HIDDEN_TIP(3));
    // switched on: #346 listed (its sub-issues pulled under it, as any search does), solid in the graph
    await page.getByTestId('search').fill('新增依赖图视图');
    await showParked(page, true);
    await expect.poll(() => rowKeys(page)).toEqual([K(346)]);
    await expect.poll(() => allRowKeys(page)).toEqual(family.map(K).sort());
    await expect(tip(page)).not.toHaveAttribute('title', /稍后处理的条目没显示/);
    await layout(page, 'graph');
    await expect(node(page, 346)).toHaveAttribute('data-dim', 'no');
    for (const n of [349, 350]) await expect(node(page, n)).toHaveAttribute('data-dim', 'yes');
    await page.getByTestId('search').fill('');
    await layout(page, 'table');
    await expect.poll(() => allRowKeys(page)).toEqual(keys(all.filter((i) => i.state === 'open')));
    await showParked(page, false);
    await expect.poll(() => allRowKeys(page)).toEqual(keys(ordinaryOpen));

    // ---- row 5: the parked label left empty — nothing hidden although the switch is off, no 「稍后处理」 number, no switch ----
    await page.evaluate(() => (window as any).cavil.setHandBack({ later: '' }));
    await expect.poll(() => rowKeys(page)).toEqual(keys(all.filter((i) => i.state === 'open')));
    await expect(allCount(page)).toHaveText(String(listedBefore));
    await expect(tally(page, 'later')).toHaveCount(0);
    await expect(parkedToggle(page)).toHaveCount(0);
    await expect(page.getByTestId('show-closed-toggle')).toBeVisible();
    await expect(tip(page)).not.toHaveAttribute('title', /稍后处理的条目没显示/);
    await layout(page, 'graph');
    for (const n of family) await expect(node(page, n)).toHaveAttribute('data-dim', 'no');
  });

  test('GitHub#741: 「显示稍后处理」 — on by default between 「显示已关闭」 and 「视图设置」, one switch for every layout, greyed out by a search naming the parked label, kept across a restart', async () => {
    let app: RunningApp = await launchApp(env);
    let page = app.page;
    await signIn(page, [PROJECT_URL, REPO]);
    await setHierarchy(page, true);
    const family = [346, 349, 350];
    await park(page, family);
    const all = await items(page);
    const open = all.filter((i) => i.state === 'open');
    const ordinaryOpen = open.filter((i) => !parked(i));
    expect(ordinaryOpen.length).toBeGreaterThan(0);
    for (const n of family) expect(open.some((i) => i.key === K(n) && parked(i))).toBe(true);

    // on by default: the three listed in the table and the board, solid in the graph; no hidden line
    await expect(parkedBox(page)).toBeChecked();
    await expect(parkedBox(page)).toBeEnabled();
    await expect.poll(() => allRowKeys(page)).toEqual(keys(open));
    await expect(allCount(page)).toHaveText(String(open.length));
    await expect(tip(page)).not.toHaveAttribute('title', /稍后处理的条目没显示/);
    // its place: right after 「显示已关闭」, right before 「视图设置」, on one line
    const closedBox = (await page.getByTestId('show-closed-toggle').boundingBox())!;
    const parkedAt = (await parkedToggle(page).boundingBox())!;
    const viewBtn = (await page.getByTestId('open-view-panel').boundingBox())!;
    expect(closedBox.x + closedBox.width).toBeLessThanOrEqual(parkedAt.x);
    expect(parkedAt.x + parkedAt.width).toBeLessThanOrEqual(viewBtn.x);
    expect(Math.abs(closedBox.y + closedBox.height / 2 - (parkedAt.y + parkedAt.height / 2))).toBeLessThan(4);
    await expect(parkedToggle(page)).toHaveText('显示稍后处理');
    await shot(page, 'parked-switch-01-on');
    await layout(page, 'board');
    if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').first().click();
    await expect.poll(() => cardKeys(page)).toEqual(keys(open));
    // the board's bar (its widest) stays on one line with the switch: 「视图设置」 and 「快捷键」 show only their icon /
    // key there, still named for screen readers and in the tooltip; the table keeps their words
    const tops = await page.locator('.vbar > *').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => r.top + r.height / 2));
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(8);
    await expect(page.getByTestId('open-view-panel')).toHaveAccessibleName('视图设置');
    await expect(page.getByTestId('open-view-panel')).toHaveAttribute('title', '视图设置');
    await expect(page.getByTestId('open-shortcuts')).toHaveAccessibleName(/快捷键/);
    const words = (page: Page) => page.getByTestId('open-view-panel').getByText('视图设置').evaluate((e) => e.getBoundingClientRect().width);
    expect(await words(page)).toBeLessThanOrEqual(1);
    await shot(page, 'parked-switch-03-board');
    await layout(page, 'table');
    expect(await words(page)).toBeGreaterThan(20);
    await layout(page, 'graph');
    await expect(parkedToggle(page)).toBeVisible();
    for (const n of family) await expect(node(page, n)).toHaveAttribute('data-dim', 'no');

    // turned off in the graph: off in every layout (one switch)
    await showParked(page, false);
    for (const n of family) await expect(node(page, n)).toHaveCount(0);
    await layout(page, 'table');
    await expect(parkedBox(page)).not.toBeChecked();
    await expect.poll(() => allRowKeys(page)).toEqual(keys(ordinaryOpen));
    await expect(tip(page)).toHaveAttribute('title', HIDDEN_TIP(3));
    await shot(page, 'parked-switch-02-off');

    // a search naming the parked label decides, the switch greyed out — written, negated, any case, and the lit number
    await page.getByTestId('search').fill('label:Pending/Later');
    await expect.poll(() => rowKeys(page)).toEqual(family.map(K).sort());
    await expect(parkedBox(page)).toBeDisabled();
    await expect(parkedToggle(page)).toHaveClass(/disabled/);
    await expect(parkedToggle(page)).toHaveAttribute('title', /以搜索框为准/);
    await expect(parkedBox(page)).not.toBeChecked();
    await page.getByTestId('search').fill('-label:pending/later');
    await expect.poll(() => allRowKeys(page)).toEqual(keys(ordinaryOpen));
    await expect(parkedBox(page)).toBeDisabled();
    await page.getByTestId('search').fill('');
    await expect(parkedBox(page)).toBeEnabled();
    await press(page, 'later');
    await expect(page.getByTestId('search')).toHaveValue(`label:"${LATER}"`);
    await expect.poll(() => rowKeys(page)).toEqual(family.map(K).sort());
    await expect(parkedBox(page)).toBeDisabled();
    await press(page, 'later');
    await expect(page.getByTestId('search')).toHaveValue('');
    await expect.poll(() => allRowKeys(page)).toEqual(keys(ordinaryOpen));

    // kept across a restart: off stays off (the back end holds it, not just the window)
    await expect.poll(async () => (((await app.backend.call('init')) as { settings: Record<string, any> }).settings.view ?? {}).showParked).toBe(false);
    await app.close();
    app = await launchApp(env);
    page = app.page;
    await expect(parkedBox(page)).not.toBeChecked({ timeout: 15_000 });
    await expect.poll(() => allRowKeys(page), { timeout: 15_000 }).toEqual(keys(ordinaryOpen));
    await showParked(page, true);
    await expect.poll(() => allRowKeys(page)).toEqual(keys(open));
    await app.close();
  });

  test('GitHub#741 review round 1 problem 1: a parked label set for a repository that is not ticked names nothing — a search for it neither brings parked items back nor greys the switch out; a ticked repository\'s own name still does', async () => {
    let app: RunningApp = await launchApp(env);
    let page = app.page;
    await signIn(page, [PROJECT_URL, REPO]);
    await park(page, [349]);
    setLabel(349, 'bug', true);
    await sync(page, (all) => all.some((i) => i.key === K(349) && has(i, 'bug') && parked(i)));
    // a repository that is not among the sources, with settings of its own left behind: its parked label is "bug"
    await app.backend.call('setSetting', { key: 'repoLabels', value: { 'gigleai/not-selected': { hand: { later: 'bug' } } } });
    await app.close();
    app = await launchApp(env);
    page = app.page;
    await expect.poll(async () => (await page.evaluate(async () => (await (window as any).cavil.get()).state.repoLabels))['gigleai/not-selected']?.hand?.later, { timeout: 15_000 }).toBe('bug');
    await expect.poll(async () => (await items(page)).some((i) => i.key === K(349) && parked(i)), { timeout: 15_000 }).toBe(true);
    await layout(page, 'table');
    await showParked(page, false);
    // not vacuous: the switch really hides #349 before the search
    await expect.poll(() => allRowKeys(page)).not.toContain(K(349));
    expect((await items(page)).some((i) => i.key !== K(349) && i.state === 'open')).toBe(true);

    // 「bug」 names no ticked repository's parked label: #349 stays out, the switch stays usable
    await page.getByTestId('search').fill('label:bug');
    await expect.poll(() => allRowKeys(page)).not.toContain(K(349));
    await expect(parkedBox(page)).toBeEnabled();
    await expect(parkedToggle(page)).not.toHaveClass(/disabled/);
    // the ticked repository's own parked label still decides: #349 listed, the switch greyed out
    await page.getByTestId('search').fill('label:pending/later');
    await expect.poll(() => rowKeys(page)).toEqual([K(349)]);
    await expect(parkedBox(page)).toBeDisabled();
    // the ticked repository renamed to "bug": now 「label:bug」 names it and decides
    await app.backend.call('setSetting', { key: 'repoLabels', value: { 'gigleai/cavil-loop': { hand: { later: 'bug' } } } });
    await app.close();
    app = await launchApp(env);
    page = app.page;
    await expect.poll(async () => (await page.evaluate(async () => (await (window as any).cavil.get()).state.repoLabels))['gigleai/cavil-loop']?.hand?.later, { timeout: 15_000 }).toBe('bug');
    await page.getByTestId('search').fill('label:bug');
    await expect.poll(() => rowKeys(page), { timeout: 15_000 }).toContain(K(349));
    await expect(parkedBox(page)).toBeDisabled();
    await app.close();
  });

  test('GitHub#708 rows 8 / 8b: an ordinary parent #346 with a parked sub-issue #350 — not listed, not pulled; faded in the graph; listed when searched', async () => {
    const { page } = await launchApp(env);
    await signIn(page, [PROJECT_URL, REPO]);
    await setHierarchy(page, true);
    const openBefore = (await items(page)).filter((i) => i.state === 'open');
    await expect(allCount(page)).toHaveText(String(openBefore.length));
    const listedBefore = openBefore.length;
    await park(page, [350]);
    await showParked(page, false);
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

    // ---- 8b: #350's title searched — still out while the switch is off (only faded inside #346's box, which the
    // search does not list either); switched on, listed and solid ----
    await page.getByTestId('search').fill('父子框、阻塞箭头');
    await layout(page, 'table');
    await expect.poll(() => allRowKeys(page)).toEqual([]);
    await layout(page, 'graph');
    await showParked(page, true);
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
    await showParked(page, false);
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

    // ---- 9b: #349's title searched — out while the switch is off; switched on, listed and solid ----
    await page.getByTestId('search').fill('读取子 issue 列表');
    await layout(page, 'table');
    await expect.poll(() => rowKeys(page)).toEqual([]);
    await layout(page, 'graph');
    await showParked(page, true);
    await expect(node(page, 349)).toHaveAttribute('data-dim', 'no');
    await layout(page, 'table');
    await expect.poll(() => rowKeys(page)).toEqual([K(349)]);
  });

  test('GitHub#708 row 7: a closed parked item stays out with 「显示已关闭」 on; the number counts open items only', async () => {
    const { page } = await launchApp(env);
    await signIn(page, [PROJECT_URL, REPO]);
    await page.evaluate(() => (window as any).cavil.setView({ showClosed: { table: true } }));
    await expect(page.getByTestId('show-closed')).toBeChecked();
    await showParked(page, false);
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
    await showParked(page, false);

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

    // ---- 10b: the PR searched — with the switch off its issue is not carried; switched on, carried, faded, as before ----
    await page.getByTestId('search').fill(pr!.title);
    await layout(page, 'table');
    await expect.poll(() => allRowKeys(page)).toContain(pr!.key);
    await expect.poll(() => allRowKeys(page)).not.toContain(issue.key);
    await showParked(page, true);
    await expect.poll(() => page.$$eval(`[data-testid="row"][data-carried][data-key="${issue.key}"]`, (rs) => rs.length)).toBeGreaterThan(0);
    await layout(page, 'board');
    await expect.poll(() => page.$$eval(`[data-testid="card"][data-carried][data-key="${issue.key}"]`, (cs) => cs.length)).toBeGreaterThan(0);
  });
});
