// GigleAI/cavil-loop#350: the dependency graph in the real window (built with --test-bridge),
// the real back end behind the loopback bridge, the fake GitHub serving the relations recorded
// from the real board (test/fixtures/record.mjs --relations). Screenshots land in
// test-results/screens/ (uploaded by CI).
//
// The recording (2026-11-10): #346 ⊃ #349 #350, #349 blocks #350, all open; #311 ⊃ #313 #314 #315
// (the repository list lacks #313); #169 blocks #181, both closed; #232's parent is
// GigleAI/GigleTutor-Web#1458, in no source.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelationIssues, loadRelationPages, startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { Cache } from '../support/cache';
import type { Item } from '../../src/shared/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const BOARD = 'org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';
const PROJECT_KEY = 'project:org/gigleai/11';
const REPO_KEY = 'repo:gigleai/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const OUTSIDE_PARENT = 'gigleai/gigletutor-web#1458';

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-graph-'));
  env = {
    fake: await startFakeGitHub({ projects: new Map([[BOARD, loadRelationPages()]]), repos: new Map([['gigleai/cavil-loop', loadRelationIssues()]]) }),
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

async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
}

/** sign in, add the recorded board and the repository, switch to the graph with an empty search */
async function signInToGraph(page: Page, sources: string[] = [PROJECT_URL, REPO]) {
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
  await expect(page.getByTestId('source-row')).toHaveCount(sources.length);
  await page.getByTestId('back').click();
  // adding the Project imported its saved web view (table, -label:Done -status:Done): wait for it, then look at the graph of everything
  if (sources.includes(PROJECT_URL)) await expect(page.getByTestId('search')).toHaveValue('-label:Done -status:Done', { timeout: 15_000 });
  await page.getByTestId('search').fill('');
  // saved (the box saves 300 ms after typing stops), so a restart opens on the same search
  await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.view.query)).toBe('');
  await expect.poll(() => sourcesStatus(page), { timeout: 20_000 }).toEqual(sources.map(() => true));
  await page.locator('[data-testid="layout"] button[data-value="graph"]').click();
  await expect(page.getByTestId('graph')).toBeVisible();
}

/** per configured source: has the latest round read it whole */
const sourcesStatus = (page: Page) => page.evaluate(async () => ((await (window as any).cavil.get()).state.sync.sources as { ok: boolean }[]).map((s) => s.ok));
const items = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).data.items as Item[]);

const nodeOf = (page: Page, key: string) => page.locator(`[data-testid="graph-node"][data-key="${key}"]`);
const edgeOf = (page: Page, from: number | string, to: number | string) =>
  page.locator(`[data-testid="graph-edge"][data-from="${typeof from === 'number' ? K(from) : from}"][data-to="${typeof to === 'number' ? K(to) : to}"]`);
const boxOf = (page: Page, key: string) => page.locator(`[data-testid="graph-box"][data-key="${key}"]`);

/** the on-screen boxes of every node, keyed */
const nodeBoxes = (page: Page): Promise<Record<string, number[]>> =>
  page.$$eval('[data-testid="graph-node"]', (els) =>
    Object.fromEntries(
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return [e.getAttribute('data-key'), [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]];
      }),
    ),
  );
const inside = async (outer: Locator, inner: Locator) => {
  const o = (await outer.boundingBox())!;
  const i = (await inner.boundingBox())!;
  return i.x >= o.x && i.y >= o.y && i.x + i.width <= o.x + o.width + 0.5 && i.y + i.height <= o.y + o.height + 0.5;
};
/** a point of the canvas with nothing on it (canvas-relative) */
const emptySpot = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('[data-testid="graph-canvas"]')!;
    const r = c.getBoundingClientRect();
    for (let y = r.height - 140; y > 60; y -= 20)
      for (let x = r.width / 2; x > 20; x -= 20) if (document.elementFromPoint(r.left + x, r.top + y) === c) return { x, y };
    throw new Error('no empty spot');
  });
const stroke = (l: Locator) => l.evaluate((e) => getComputedStyle(e).stroke);
const strokeWidth = (l: Locator) => l.evaluate((e) => parseFloat(getComputedStyle(e).strokeWidth));

/** somebody closes / reopens an issue on github.com */
async function setState(n: number, state: 'open' | 'closed') {
  const r = await fetch(`${env.fake.api}/repos/${REPO}/issues/${n}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${env.fake.state.validTokens.values().next().value}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  expect(r.status).toBe(200);
}
/** one more round, waited for */
async function syncRound(page: Page) {
  const before = env.fake.log.filter((e) => e.operation === 'CavilProjectItems').length;
  await page.getByTestId('refresh').click();
  await expect.poll(() => env.fake.log.filter((e) => e.operation === 'CavilProjectItems').length, { timeout: 15_000 }).toBeGreaterThan(before);
  await expect.poll(async () => (await page.evaluate(async () => (await (window as any).cavil.get()).state.sync.syncing)) as boolean, { timeout: 15_000 }).toBe(false);
}

test('GitHub#350: boxes, arrows and their colours, the three kinds of "not in the current sources", summary and detail, counts, search', async () => {
  const app = await launchApp(env);
  const { page } = app;
  await signInToGraph(page);
  await shot(page, 'graph-01-normal');

  // ---- the view is remembered: back from the board, the graph is still picked ----
  const saved = await page.evaluate(async () => (await (window as any).cavil.get()).state.view.layout);
  expect(saved).toBe('graph');
  await expect(page.locator('[data-testid="layout"] button[data-value="graph"]')).toHaveClass(/on/);

  // ---- parents are boxes, their sub-issues inside ----
  for (const c of [313, 314, 315]) {
    await expect(nodeOf(page, K(c))).toBeVisible();
    expect(await inside(boxOf(page, K(311)), nodeOf(page, K(c))), `#${c} in #311`).toBe(true);
  }
  for (const c of [349, 350]) expect(await inside(boxOf(page, K(346)), nodeOf(page, K(c))), `#${c} in #346`).toBe(true);
  // control: a child is not inside another parent's box
  expect(await inside(boxOf(page, K(311)), nodeOf(page, K(350)))).toBe(false);
  await expect(boxOf(page, K(311)).getByTestId('graph-box-progress')).toHaveText('3 / 3 子项完成');
  // a parent shows its labels like any node (PR #367 review round 1): the box of #346, and a plain node, both from the items' labels
  const labelsOf = async (n: number) => (await items(page)).find((i) => i.key === K(n))!.labels.map((l) => l.name);
  const parentLabels = await labelsOf(346);
  expect(parentLabels.length).toBeGreaterThan(0);
  expect(await boxOf(page, K(346)).locator('.gbox-head .label').allTextContents()).toEqual(parentLabels);
  expect(await nodeOf(page, K(350)).locator('.label').allTextContents()).toEqual(await labelsOf(350));

  // ---- arrows: from the blocker to the blocked; open = amber and bold, closed = grey and thin ----
  const open = edgeOf(page, 349, 350);
  const closed = edgeOf(page, 169, 181);
  await expect(open).toHaveAttribute('data-open', 'yes');
  await expect(closed).toHaveAttribute('data-open', 'no');
  await expect(edgeOf(page, 350, 349)).toHaveCount(0);
  expect(await stroke(open)).not.toBe(await stroke(closed));
  expect(await strokeWidth(open)).toBeGreaterThan(await strokeWidth(closed));
  // the arrow leaves the blocker's right and ends at the blocked one's left
  const from = (await nodeOf(page, K(349)).boundingBox())!;
  const to = (await nodeOf(page, K(350)).boundingBox())!;
  expect(from.x + from.width).toBeLessThan(to.x);
  const path = (await open.boundingBox())!;
  expect(Math.abs(path.x - (from.x + from.width))).toBeLessThan(8);
  expect(Math.abs(path.x + path.width - to.x)).toBeLessThan(8);
  await expect(nodeOf(page, K(350)).getByTestId('graph-blocked-by')).toHaveText('被 1 项挡住');
  await expect(nodeOf(page, K(349)).getByTestId('graph-blocking-ahead')).toHaveText('挡住后面 1 项');
  await expect(nodeOf(page, K(181)).getByTestId('graph-blocked-by')).toHaveCount(0);
  // the state words and colour are the card's
  await expect(nodeOf(page, K(350)).getByTestId('graph-node-state')).toHaveText(/Issue · 开/);
  await expect(nodeOf(page, K(350)).getByTestId('graph-node-state')).toHaveAttribute('data-tone', 'open');
  await expect(nodeOf(page, K(181)).getByTestId('graph-node-state')).toHaveAttribute('data-tone', 'done');

  // ---- a parent in no source: a dashed box of its own, marked ----
  await expect(nodeOf(page, OUTSIDE_PARENT)).toHaveAttribute('data-outside', 'yes');
  await expect(boxOf(page, OUTSIDE_PARENT).getByTestId('graph-outside')).toHaveText('不在当前来源中');
  expect(await inside(boxOf(page, OUTSIDE_PARENT), nodeOf(page, K(232)))).toBe(true);
  await expect(nodeOf(page, K(232))).toHaveAttribute('data-outside', 'no');

  // ---- counts: entries next to the total; the rest said, not drawn ----
  const all = await items(page);
  const issuesWithRel = all.filter((i) => i.kind === 'issue' && i.relations && (i.relations.parent || i.relations.subIssues.length || i.relations.blockedBy.length || i.relations.blocking.length));
  await expect(page.getByTestId('graph-count')).toHaveText(`显示 ${issuesWithRel.length} 个有关系的条目 · 共 ${all.length} 个条目`);
  const lonely = all.length - issuesWithRel.length;
  expect(lonely).toBeGreaterThan(0);
  await expect(page.getByTestId('graph-hidden')).toHaveText(`另有 ${lonely} 个条目没有父子 / 阻塞关系，未显示（在看板 / 表格里看）`);
  const lonelyKey = all.find((i) => !issuesWithRel.includes(i))!.key;
  await expect(nodeOf(page, lonelyKey)).toHaveCount(0);
  await expect(page.getByTestId('graph-unknown-count')).toHaveCount(0);

  // ---- one click: the summary; "打开详情" and a double click: the board's detail panel ----
  await nodeOf(page, K(350)).click();
  const pop = page.getByTestId('graph-summary');
  await expect(pop).toHaveAttribute('data-key', K(350));
  await expect(pop.getByTestId('graph-summary-blockers')).toContainText('#349');
  await expect(pop.getByTestId('graph-summary-blockers')).toContainText('未完成');
  await expect(pop.getByTestId('graph-summary-parent')).toContainText('#346');
  await shot(page, 'graph-02-summary');
  await pop.getByTestId('graph-summary-open').click();
  await expect(page.getByTestId('detail')).toBeVisible();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', K(350));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('detail')).toHaveCount(0);
  await nodeOf(page, K(349)).dblclick();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', K(349));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('detail')).toHaveCount(0);
  // an issue in no source: no detail, only GitHub
  await nodeOf(page, OUTSIDE_PARENT).click();
  await expect(pop).toHaveAttribute('data-key', OUTSIDE_PARENT);
  await expect(pop.getByTestId('graph-summary-open')).toHaveCount(0);
  await pop.getByTestId('graph-summary-web').click();
  await expect.poll(() => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '')).toContain('https://github.com/GigleAI/GigleTutor-Web/issues/1458\n');
  await nodeOf(page, OUTSIDE_PARENT).dblclick();
  await expect(page.getByTestId('detail')).toHaveCount(0);
  // a click on empty space puts the summary away
  await page.getByTestId('graph-canvas').click({ position: await emptySpot(page) });
  await expect(pop).toHaveCount(0);

  // ---- the search picks first; an end it hid stays, faded, so the arrow is whole ----
  await page.getByTestId('search').fill('is:open');
  await expect(nodeOf(page, K(311))).toHaveCount(0);
  await expect(nodeOf(page, K(350))).toHaveAttribute('data-dim', 'no');
  await page.getByTestId('search').fill('350');
  await expect(nodeOf(page, K(349))).toHaveAttribute('data-dim', 'yes');
  await expect(nodeOf(page, K(346))).toHaveAttribute('data-dim', 'yes');
  await expect(nodeOf(page, K(350))).toHaveAttribute('data-dim', 'no');
  await expect(edgeOf(page, 349, 350)).toHaveCount(1);
  await expect(page.getByTestId('graph-count')).toHaveText(new RegExp(`^显示 1 个有关系的条目 · 共 ${all.length} 个条目$`));
  await shot(page, 'graph-03-search');
  await page.getByTestId('search').fill('');

  // ---- the repository alone: #313 is in no source — still in #311's box, dashed ----
  await page.locator(`[data-testid="source-pick"] input[data-key="${PROJECT_KEY}"]`).uncheck();
  await expect(nodeOf(page, K(313))).toHaveAttribute('data-outside', 'yes');
  await expect(nodeOf(page, K(313)).getByTestId('graph-outside')).toHaveText('不在当前来源中');
  expect(await inside(boxOf(page, K(311)), nodeOf(page, K(313)))).toBe(true);
  await expect(nodeOf(page, K(314))).toHaveAttribute('data-outside', 'no');
  await expect(nodeOf(page, OUTSIDE_PARENT)).toHaveCount(0);
  await page.locator(`[data-testid="source-pick"] input[data-key="${PROJECT_KEY}"]`).check();
  await expect(nodeOf(page, K(313))).toHaveAttribute('data-outside', 'no');

  // ---- the shortcut list names the graph's keys ----
  await page.getByTestId('graph-canvas').click({ position: await emptySpot(page) });
  await page.keyboard.press('?');
  await expect(page.locator('[data-testid="shortcut-row"][data-id="graphFit"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await app.close();
});

test('GitHub#350: a blocker closed and reopened on GitHub turns its arrow grey and amber; nothing moves', async () => {
  const app = await launchApp(env);
  const { page } = app;
  await signInToGraph(page);
  const before = await nodeBoxes(page);
  const handle = await nodeOf(page, K(350)).elementHandle();
  const unchanged = await nodeOf(page, K(314)).elementHandle();
  await page.evaluate((el) => ((el as any).__mark = 'same element'), unchanged);
  // every change the page makes to a node from here on, by node
  await page.evaluate(() => {
    const touched = ((window as any).__touched = new Set<string>());
    new MutationObserver((ms) => {
      for (const m of ms) {
        const el = (m.target instanceof Element ? m.target : m.target.parentElement)?.closest('[data-testid="graph-node"], [data-testid="graph-box"]');
        if (el) touched.add(el.getAttribute('data-key')!);
      }
    }).observe(document.querySelector('[data-testid="graph-world"]')!, { subtree: true, childList: true, attributes: true, characterData: true });
  });

  // the in-source blocker closes: grey, thin; the badges go
  await setState(349, 'closed');
  await syncRound(page);
  await expect(edgeOf(page, 349, 350)).toHaveAttribute('data-open', 'no');
  await expect(nodeOf(page, K(350)).getByTestId('graph-blocked-by')).toHaveCount(0);
  await expect(nodeOf(page, K(349)).getByTestId('graph-node-state')).toHaveAttribute('data-tone', 'done');
  expect(await strokeWidth(edgeOf(page, 349, 350))).toBeLessThan(2);
  // the recorded closed blocker reopens: amber; closes again: grey
  await setState(169, 'open');
  await syncRound(page);
  await expect(edgeOf(page, 169, 181)).toHaveAttribute('data-open', 'yes');
  await expect(nodeOf(page, K(181)).getByTestId('graph-blocked-by')).toHaveText('被 1 项挡住');
  await shot(page, 'graph-04-reopened');
  await setState(169, 'closed');
  await syncRound(page);
  await expect(edgeOf(page, 169, 181)).toHaveAttribute('data-open', 'no');

  // a state change moved nothing (no new layout), and an untouched node was not redrawn
  expect(await nodeBoxes(page)).toEqual(before);
  const touched = await page.evaluate(() => [...(window as any).__touched] as string[]);
  // the nodes whose state, badge or count changed were redrawn …
  expect(touched).toEqual(expect.arrayContaining([K(349), K(350), K(169), K(181)]));
  // … and nothing else: #346's box only for its sub-issue count (#349 closed), never a node nobody touched
  expect(touched.filter((k) => ![K(349), K(350), K(169), K(181), K(346)].includes(k))).toEqual([]);
  expect(await handle!.evaluate((e) => e.isConnected)).toBe(true);
  expect(await page.evaluate((el) => (el as any).__mark, unchanged)).toBe('same element');
  await app.close();
});

test('GitHub#350: pan, zoom, fit, the minimap; an item gone keeps the view where it was', async () => {
  const app = await launchApp(env);
  const { page } = app;
  await signInToGraph(page);
  const canvas = page.getByTestId('graph-canvas');
  const zoom = page.getByTestId('graph-zoom');
  const box = (await canvas.boundingBox())!;

  // drag the empty space: everything moves by the same amount
  const a = (await nodeOf(page, K(315)).boundingBox())!;
  await page.mouse.move(box.x + box.width - 260, box.y + 70);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 200, box.y + 110, { steps: 5 });
  await page.mouse.up();
  const b = (await nodeOf(page, K(315)).boundingBox())!;
  expect(Math.round(b.x - a.x)).toBe(60);
  expect(Math.round(b.y - a.y)).toBe(40);

  // buttons and wheel zoom; fit puts the whole graph in the window
  const z0 = await zoom.textContent();
  await page.getByTestId('graph-zoom-in').click();
  await expect(zoom).not.toHaveText(z0!);
  const z1 = parseInt((await zoom.textContent())!);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => parseInt((await zoom.textContent())!)).toBeLessThan(z1);
  await page.getByTestId('graph-fit').click();
  const all = await nodeBoxes(page);
  for (const [k, [x, y, w, h]] of Object.entries(all)) {
    expect(x >= box.x - 1 && y >= box.y - 1 && x + w <= box.x + box.width + 1 && y + h <= box.y + box.height + 1, `${k} in the window after fit`).toBe(true);
  }
  // the keyboard: "=" zooms in, "-" out, "f" fits
  const fitted = await zoom.textContent();
  await page.keyboard.press('=');
  await expect(zoom).not.toHaveText(fitted!);
  await page.keyboard.press('f');
  await expect(zoom).toHaveText(fitted!);

  // the minimap: a click there moves the view to that spot
  const mini = page.getByTestId('graph-minimap-view');
  const m0 = (await mini.boundingBox())!;
  await page.getByTestId('graph-zoom-in').click();
  await page.getByTestId('graph-zoom-in').click();
  const mm = (await page.getByTestId('graph-minimap').locator('svg').boundingBox())!;
  await page.mouse.click(mm.x + mm.width - 4, mm.y + mm.height - 4);
  const m1 = (await mini.boundingBox())!;
  expect(m1.x + m1.width / 2).toBeGreaterThan(m0.x + m0.width / 2);
  // drag the frame back
  await page.mouse.move(m1.x + m1.width / 2, m1.y + m1.height / 2);
  await page.mouse.down();
  await page.mouse.move(mm.x + 4, mm.y + 4, { steps: 4 });
  await page.mouse.up();
  const m2 = (await mini.boundingBox())!;
  expect(m2.x + m2.width / 2).toBeLessThan(m1.x + m1.width / 2);

  // look at #315, then items with relations go (#346 and its sub-issues leave the board): a new layout, #315 stays put
  await page.getByTestId('graph-fit').click();
  // drag #315 to the middle of the canvas: the node nearest the middle is the one kept in place
  const n315 = (await nodeOf(page, K(315)).boundingBox())!;
  await page.mouse.move(n315.x + n315.width / 2, n315.y + n315.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('graph-summary')).toHaveCount(0);
  const at = (await nodeOf(page, K(315)).boundingBox())!;
  /** where the layout put #315 (graph coordinates, before pan / zoom) */
  const placed = () => nodeOf(page, K(315)).evaluate((e) => [(e as HTMLElement).style.left, (e as HTMLElement).style.top].join(' '));
  const placedBefore = await placed();
  env.fake.state.projects.set(BOARD, loadRelationPages().map((p: any) => ({ ...p, items: { ...p.items, nodes: p.items.nodes.filter((n: any) => ![346, 349, 350].includes(n.content.number)) } })));
  env.fake.state.repos.set('gigleai/cavil-loop', loadRelationIssues().filter((i: any) => ![346, 349, 350].includes(i.number)));
  await syncRound(page);
  await expect(nodeOf(page, K(350))).toHaveCount(0);
  const after = (await nodeOf(page, K(315)).boundingBox())!;
  expect(Math.abs(after.x - at.x)).toBeLessThan(1);
  expect(Math.abs(after.y - at.y)).toBeLessThan(1);
  // control: the layout did change — #315 has a new place in it, the view moved to keep it on the same spot
  expect(await placed()).not.toBe(placedBefore);
  await app.close();
});

test('GitHub#350: a read that fails after one that worked — the graph keeps the last whole data and says from when (one source, then both)', async () => {
  const app = await launchApp(env);
  const { page } = app;
  await signInToGraph(page);
  const edges = await page.getByTestId('graph-edge').count();
  expect(edges).toBeGreaterThan(0);

  // the repository's relation read fails
  env.fake.state.w.failRelationsBatch = true;
  await setState(349, 'closed');
  const n = env.fake.log.length;
  await syncRound(page);
  // it did go out, and failed
  expect(env.fake.log.slice(n).some((e) => e.operation === 'CavilIssueRelationsBatch' && e.status === 502)).toBe(true);
  const stale = page.locator(`[data-testid="graph-stale"][data-source="${REPO_KEY}"]`);
  await expect(stale).toBeVisible();
  await expect(stale).toContainText('这一轮读取失败');
  await expect(stale.getByTestId('graph-stale-time')).toHaveText(/^\d\d:\d\d$/);
  await expect(page.locator(`[data-testid="graph-stale"][data-source="${PROJECT_KEY}"]`)).toHaveCount(0);
  // the graph is still drawn, every arrow there; nothing says "unknown"
  await expect(page.getByTestId('graph-edge')).toHaveCount(edges);
  await expect(page.getByTestId('graph-unknown')).toHaveCount(0);
  await shot(page, 'graph-05-fail-stale');

  // both fail
  env.fake.state.failProjectPage.set(BOARD, 0);
  await page.getByTestId('refresh').click();
  await expect(page.locator(`[data-testid="graph-stale"][data-source="${PROJECT_KEY}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('graph-stale')).toHaveCount(2);
  await expect(page.getByTestId('graph-edge')).toHaveCount(edges);
  await expect(nodeOf(page, K(350))).toBeVisible();

  // GitHub answers again: the bars go, the closed blocker shows
  env.fake.state.failProjectPage.delete(BOARD);
  env.fake.state.w.failRelationsBatch = false;
  await syncRound(page);
  await expect(page.getByTestId('graph-stale')).toHaveCount(0);
  await expect(edgeOf(page, 349, 350)).toHaveAttribute('data-open', 'no');
  await app.close();
});

test('GitHub#350: relations never read (a cache from before relations, the first read failing) are "unknown", never "no relations" — one source, then all', async () => {
  // a first run reads everything; then the cache is put back the way a version before #349 wrote it
  let app: RunningApp = await launchApp(env);
  await signInToGraph(app.page);
  await app.close();
  const strip = (keys: string[]) => {
    const cache = new Cache(join(env.userData, 'cache.sqlite'));
    const snaps = cache.loadSnapshots();
    cache.replaceSnapshots(keys.map((k) => ({ ...snaps.get(k)!, items: snaps.get(k)!.items.map(({ relations: _r, relationsAt: _t, ...rest }) => rest as Item) })));
    cache.close();
  };

  // ---- the repository only: its read of relations keeps failing ----
  strip([REPO_KEY]);
  env.fake.state.w.failRelationsBatch = true;
  app = await launchApp(env);
  let page = app.page;
  await expect(page.getByTestId('graph')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => env.fake.log.some((e) => e.operation === 'CavilIssueRelationsBatch' && e.status === 502), { timeout: 15_000 }).toBe(true);
  const bar = page.locator(`[data-testid="graph-unknown"][data-source="${REPO_KEY}"]`);
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await expect(bar).toContainText('还没有读到过');
  await expect(bar).toContainText('关系未知');
  await expect(bar).toContainText('不代表它们之间没有关系');
  const data = await page.evaluate(async () => (await (window as any).cavil.get()).data as { items: Item[]; relationsUnknown: string[] });
  expect(data.relationsUnknown).toEqual([REPO_KEY]);
  const unknown = data.items.filter((i) => i.relations === undefined).length;
  expect(unknown).toBeGreaterThan(0);
  await expect(page.getByTestId('graph-unknown-count')).toHaveText(`${unknown} 个条目关系未知`);
  await expect(bar).toContainText(`${unknown} 个条目`);
  // the board's issues are drawn (#311 is on both: its relations come from the board)
  await expect(nodeOf(page, K(311))).toBeVisible();
  // an issue only the repository holds is not drawn — and not counted as "no relations"
  const onlyRepo = data.items.find((i) => i.relations === undefined)!;
  await expect(nodeOf(page, onlyRepo.key)).toHaveCount(0);
  await shot(page, 'graph-06-unknown-partial');
  await app.close();

  // ---- every source ----
  strip([PROJECT_KEY, REPO_KEY]);
  env.fake.state.failProjectPage.set(BOARD, 0);
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('graph')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('graph-unknown')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId('graph-all-unknown')).toBeVisible();
  await expect(page.getByTestId('graph-node')).toHaveCount(0);
  await expect(page.getByTestId('graph-hidden')).toHaveCount(0);
  const total = (await items(page)).length;
  await expect(page.getByTestId('graph-unknown-count')).toHaveText(`${total} 个条目关系未知`);
  await shot(page, 'graph-07-unknown-all');

  // the first read that works fills them in
  env.fake.state.failProjectPage.delete(BOARD);
  env.fake.state.w.failRelationsBatch = false;
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('graph-unknown')).toHaveCount(0, { timeout: 15_000 });
  await expect(nodeOf(page, K(350))).toBeVisible();
  await app.close();
});

test('GitHub#350: a graph too big to read at one screen opens on the open part, "看全图" shows it all', async () => {
  const app = await launchApp(env);
  const { page } = app;
  await page.setViewportSize({ width: 900, height: 600 });
  await signInToGraph(page);
  await expect(page.getByTestId('graph-big')).toBeVisible();
  const z = parseInt((await page.getByTestId('graph-zoom').textContent())!);
  expect(z).toBeGreaterThanOrEqual(60);
  // the open issues are on screen
  const canvas = (await page.getByTestId('graph-canvas').boundingBox())!;
  const n = (await nodeOf(page, K(350)).boundingBox())!;
  expect(n.x >= canvas.x && n.x + n.width <= canvas.x + canvas.width && n.y >= canvas.y && n.y + n.height <= canvas.y + canvas.height).toBe(true);
  await shot(page, 'graph-08-big');
  await page.getByTestId('graph-show-all').click();
  await expect(page.getByTestId('graph-big')).toHaveCount(0);
  expect(parseInt((await page.getByTestId('graph-zoom').textContent())!)).toBeLessThan(60);

  // PR #367 review round 1: a node near the bottom of the canvas — its summary moves up and its buttons can be clicked
  await page.getByTestId('graph-focus').click();
  const c = (await page.getByTestId('graph-canvas').boundingBox())!;
  const spot = await emptySpot(page);
  await page.mouse.move(c.x + spot.x, c.y + spot.y);
  await page.mouse.down();
  await page.mouse.move(c.x + spot.x, c.y + spot.y + 200, { steps: 5 });
  await page.mouse.up();
  const node = (await nodeOf(page, K(350)).boundingBox())!;
  expect(node.y + node.height).toBeGreaterThan(c.y + c.height - 200);
  await nodeOf(page, K(350)).click();
  const pop = page.getByTestId('graph-summary');
  await expect(pop).toHaveAttribute('data-key', K(350));
  const p = (await pop.boundingBox())!;
  expect(p.y + p.height).toBeLessThanOrEqual(c.y + c.height);
  /** is this button what a click at its centre lands on */
  const clickable = (l: Locator) =>
    l.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
  expect(await clickable(pop.getByTestId('graph-summary-open'))).toBe(true);
  expect(await clickable(pop.getByTestId('graph-summary-web'))).toBe(true);
  await shot(page, 'graph-09-summary-bottom');
  await pop.getByTestId('graph-summary-open').click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', K(350));
  await page.keyboard.press('Escape');

  // a canvas lower than the summary's content: capped at the canvas, its middle scrolls, the buttons stay in view
  await page.setViewportSize({ width: 900, height: 340 });
  await page.getByTestId('graph-focus').click();
  await nodeOf(page, K(350)).click();
  const c2 = (await page.getByTestId('graph-canvas').boundingBox())!;
  const p2 = (await pop.boundingBox())!;
  expect(p2.y).toBeGreaterThanOrEqual(c2.y);
  expect(p2.y + p2.height).toBeLessThanOrEqual(c2.y + c2.height);
  const body = pop.getByTestId('graph-summary-body');
  expect(await body.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  expect(await clickable(pop.getByTestId('graph-summary-open'))).toBe(true);
  expect(await clickable(pop.getByTestId('graph-summary-web'))).toBe(true);
  expect(await clickable(pop.getByTestId('graph-summary-close'))).toBe(true);
  expect(await clickable(page.getByTestId('graph-fit'))).toBe(true);
  await shot(page, 'graph-10-summary-short');

  // PR #367 review round 2: fit below 20% here; zoom in a little, then out — back to the fit, by button, key and wheel
  await page.getByTestId('graph-summary-close').click();
  await page.getByTestId('graph-fit').click();
  const scaleNow = async () => Number(await page.getByTestId('graph-world').getAttribute('data-scale'));
  const fitScale = await scaleNow();
  expect(fitScale).toBeLessThan(0.2);
  await page.getByTestId('graph-zoom-in').click();
  expect(await scaleNow()).toBeGreaterThan(fitScale);
  await page.getByTestId('graph-zoom-out').click();
  expect(await scaleNow()).toBeCloseTo(fitScale, 2);
  await page.getByTestId('graph-canvas').click({ position: await emptySpot(page) });
  await page.keyboard.press('=');
  expect(await scaleNow()).toBeGreaterThan(fitScale);
  await page.keyboard.press('-');
  expect(await scaleNow()).toBeCloseTo(fitScale, 2);
  const c3 = (await page.getByTestId('graph-canvas').boundingBox())!;
  await page.mouse.move(c3.x + c3.width / 2, c3.y + c3.height / 2);
  await page.mouse.wheel(0, -100);
  await expect.poll(scaleNow).toBeGreaterThan(fitScale);
  await page.mouse.wheel(0, 400);
  await expect.poll(scaleNow).toBeCloseTo(fitScale, 2);
  await app.close();
});

// GigleAI/cavil-loop#429: the shape that started it (luosky/arkknights-tool) — #56 waits for #55, #57
// for #56, #58 for #57, registered only in the loop's hidden comments (GitHub's "Blocked by" empty).
test('GitHub#429: the loop registrations in comments are drawn as arrows; the setting turns them off', async () => {
  const TOOL = 'luosky/arkknights-tool';
  const TK = (n: number) => `luosky/arkknights-tool#${n}`;
  const issue = (n: number, labels: string[]) => ({
    number: n,
    node_id: `I_tool_${n}`,
    title: `明日方舟抽卡分析 ${n}`,
    state: 'open',
    html_url: `https://github.com/${TOOL}/issues/${n}`,
    updated_at: '2026-11-12T05:35:00Z',
    labels: labels.map((name) => ({ name, color: 'c5def5' })),
    assignees: [],
    milestone: null,
    user: { login: 'luosky' },
    parent_issue_url: null,
    sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
    issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 0, blocking: 0, total_blocking: 0 },
  });
  env.fake.state.repos.set(TOOL, [issue(55, ['pending/PR']), issue(56, ['pending/blocked']), issue(57, ['pending/blocked']), issue(58, ['pending/blocked'])]);
  let i = 0;
  for (const [n, waits] of [
    [56, 55],
    [57, 56],
    [58, 57],
  ]) {
    const body = `## 等前置 #${waits}\n\n<!-- agent-blocked-by: #${waits} resume=pending/agent -->`;
    env.fake.state.w.comments.set(`${TOOL}#${n}`, [
      { id: `IC_tool_${++i}`, url: `https://github.com/${TOOL}/issues/${n}#c${i}`, createdAt: `2026-11-12T05:35:0${i}Z`, bodyHTML: body, body, author: { login: 'luosky-bot-pusher' }, authorAssociation: 'COLLABORATOR' },
    ]);
  }
  const app = await launchApp(env);
  const { page } = app;
  await signInToGraph(page, [TOOL]);
  for (const [from, to] of [
    [55, 56],
    [56, 57],
    [57, 58],
  ])
    await expect(edgeOf(page, TK(from), TK(to))).toHaveCount(1);
  await expect(page.locator('[data-testid="graph-edge"]')).toHaveCount(3);
  await expect(nodeOf(page, TK(55)).getByTestId('graph-blocking-ahead')).toHaveText('挡住后面 3 项');
  for (const n of [56, 57, 58]) await expect(nodeOf(page, TK(n)).getByTestId('graph-blocked-by')).toHaveText('被 1 项挡住');
  // #55 is drawn as the end of a registration: not counted among the hidden ones
  await expect(page.getByTestId('graph-hidden')).toHaveCount(0);
  await page.getByTestId('graph-fit').click();
  await shot(page, 'graph-11-loop-registrations');

  // the setting: empty = only GitHub's own relations (none here) — the arrows go, no registration is read again
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('hand-back-blocked')).toHaveValue('pending/blocked');
  await shot(page, 'graph-12-setting');
  await page.getByTestId('hand-back-blocked').fill('');
  await page.getByTestId('hand-back-blocked').blur();
  await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.handBack.blocked)).toBe('');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('graph-hidden')).toBeVisible();
  await expect(page.locator('[data-testid="graph-edge"]')).toHaveCount(0);
  // and back: the next read under the label brings them back
  await page.getByTestId('open-settings').click();
  await page.getByTestId('hand-back-blocked').fill('pending/blocked');
  await page.getByTestId('hand-back-blocked').blur();
  await page.getByTestId('back').click();
  await expect(page.locator('[data-testid="graph-edge"]')).toHaveCount(3, { timeout: 20_000 });
  await app.close();
});
