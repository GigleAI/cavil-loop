// GigleAI/cavil-loop#747: the table's column lines, moving a column by its heading, and the cell editors —
// not faded on a faded row, a press outside one only puts it away, milestone / iteration / status as a list
// in the page. The real window (built with --test-bridge), the real back end through the loopback bridge and
// the fake GitHub serving the relations recorded from the real board (#346 ⊃ #349 #350), as table-pulled.spec.ts.
// Screenshots land in test-results/screens/.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelationIssues, loadRelationPages, startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const K = (n: number) => `gigleai/cavil-loop#${n}`;
const EDITABLE = ['labels', 'assignees', 'iteration', 'status', 'milestone'] as const;

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-cells-'));
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

const row = (page: Page, n: number) => page.locator(`[data-testid="row"][data-key="${K(n)}"]`);
const cell = (page: Page, n: number, col: string) => row(page, n).locator(`[data-testid="cell"][data-col="${col}"]`);
const heads = (page: Page) => page.locator('[data-testid="col-head"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-col')));
const savedColumns = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).state.view.table.columns as string[]);
/** writes to GitHub so far (REST method / GraphQL operation) */
const writes = () => env.fake.writes().map((w) => (w.method === 'POST' && w.path === '/api/graphql' ? w.operation : `${w.method} ${w.path}`));
/** what is drawn of an element: its own opacity times every ancestor's */
const drawnOpacity = (l: Locator) =>
  l.evaluate((el) => {
    let o = 1;
    for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  });
/** the open editor's floating part: the label / assignee picker, or the lists */
const pop = (page: Page) => page.locator('[data-cell-editor] .picker, [data-cell-editor] [data-testid="cell-lists"]');

async function signedInTable(page: Page) {
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
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  // every editable column shown
  await page.getByTestId('open-view-panel').click();
  for (const c of EDITABLE) {
    const box = page.locator(`[data-testid="columns-pick"] input[data-col="${c}"]`);
    if (!(await box.isChecked())) await box.check();
  }
  await page.getByTestId('open-view-panel').click();
  // a search that matches #346 only: #349 and #350 are pulled in under it, faded
  await page.getByTestId('search').fill('新增依赖图视图');
  await expect(row(page, 349)).toHaveAttribute('data-pulled', '');
}

test('GitHub#747: a line between the columns, on the width grip', async () => {
  const { page } = await launchApp(env);
  await signedInTable(page);
  const th = page.locator('[data-testid="col-head"][data-col="labels"]');
  const grip = page.locator('[data-testid="col-resize"][data-col="labels"]');
  const line = () => grip.evaluate((g) => {
    const s = getComputedStyle(g, '::after');
    return { width: s.width, bg: s.backgroundColor };
  });
  const idle = await line();
  expect(idle.width).toBe('1px');
  expect(idle.bg).not.toBe('rgba(0, 0, 0, 0)');
  // the line is the grip's right edge, which is the heading's right edge
  const [t, g] = [(await th.boundingBox())!, (await grip.boundingBox())!];
  expect(Math.abs(g.x + g.width - (t.x + t.width))).toBeLessThan(1);
  expect(g.width).toBeGreaterThanOrEqual(8);
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await expect.poll(async () => (await line()).width).toBe('3px');
  // the body has its own lighter line between cells; a row spanning the table has none
  const shadow = (l: Locator) => l.evaluate((td) => getComputedStyle(td).boxShadow);
  expect(await shadow(cell(page, 346, 'labels'))).toMatch(/ 1px 0px 0px 0px inset/);
  expect(await shadow(row(page, 346).locator('.title-cell'))).not.toMatch(/ 1px 0px 0px 0px inset/);
  expect(await shadow(page.locator('[data-testid="group-head"]').first().locator('td'))).not.toMatch(/ 1px 0px 0px 0px inset/);
  await page.screenshot({ path: join(screens, 'table-cells-01-lines.png') });
});

test('GitHub#747: a column moves by dragging its heading, and keeps its place after a restart; the title column stays first', async () => {
  let app = await launchApp(env);
  let page = app.page;
  await signedInTable(page);
  const before = await heads(page);
  expect(before[0]).toBe('title');
  const box = async (c: string) => (await page.locator(`[data-testid="col-head"][data-col="${c}"]`).boundingBox())!;
  const drag = async (c: string, toX: number, opts: { esc?: boolean; shot?: string } = {}) => {
    const b = await box(c);
    await page.mouse.move(b.x + 20, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(toX, b.y + b.height / 2, { steps: 8 });
    if (opts.shot) {
      await expect(page.getByTestId('col-drop-line')).toBeVisible();
      await page.screenshot({ path: join(screens, opts.shot) });
    }
    if (opts.esc) await page.keyboard.press('Escape');
    await page.mouse.up();
  };

  // a press that moves less than 4px is a click: nothing moves
  const u = await box('updated');
  await page.mouse.move(u.x + 20, u.y + u.height / 2);
  await page.mouse.down();
  await page.mouse.move(u.x + 23, u.y + u.height / 2);
  await page.mouse.up();
  expect(await heads(page)).toEqual(before);
  await expect(page.getByTestId('col-drop-line')).toHaveCount(0);

  // the title column does not move
  const t0 = await box('title');
  await drag('title', t0.x + t0.width + 300);
  expect(await heads(page)).toEqual(before);

  // Esc while dragging: nothing moves
  const l = await box('labels');
  await drag('updated', l.x + 5, { esc: true });
  expect(await heads(page)).toEqual(before);

  // PR #749 review round 1, problem 3: the system takes the pointer away mid-drag — the drag ends, a later button-up saves nothing
  const u2 = await box('updated');
  await page.mouse.move(u2.x + 20, u2.y + u2.height / 2);
  await page.mouse.down();
  await page.mouse.move(l.x + 5, u2.y + u2.height / 2, { steps: 8 });
  await expect(page.getByTestId('col-drop-line')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })));
  await expect(page.getByTestId('col-drop-line')).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await heads(page)).toEqual(before);
  expect((await savedColumns(page)).filter((c) => c !== 'title')).toEqual(before.slice(1));

  // "updated" dropped on the left half of the first column after the title: it goes right after the title
  const first = before[1]!;
  const f = await box(first);
  await drag('updated', f.x + 5, { shot: 'table-cells-02-moving.png' });
  const after = ['title', 'updated', ...before.slice(1).filter((c) => c !== 'updated')];
  await expect.poll(() => heads(page)).toEqual(after);
  // the cells follow their heading
  const cols = await row(page, 346).locator('[data-testid="cell"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-col')));
  expect(cols).toEqual(after.slice(1));
  // saved: the title keeps its place in the saved list, only the others changed order
  const saved = await savedColumns(page);
  expect(saved.filter((c) => c !== 'title')).toEqual(after.slice(1));
  // dragged back to the far right
  const last = await box(after[after.length - 1]!);
  await drag('updated', last.x + last.width - 2);
  const back = [...after.filter((c) => c !== 'updated'), 'updated'];
  await expect.poll(() => heads(page)).toEqual(back);

  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => heads(page)).toEqual(back);
});

test('GitHub#747: every cell editor is drawn in full on a faded row, and a press outside it only puts it away', async () => {
  const { page } = await launchApp(env);
  await signedInTable(page);
  const title346 = row(page, 346).locator('.title-cell');
  for (const c of EDITABLE) {
    const w0 = writes().length;
    await cell(page, 349, c).click();
    await expect(pop(page)).toBeVisible({ timeout: 10_000 });
    // the faded row's other cells stay faded; the editor is not
    expect(await drawnOpacity(cell(page, 349, 'updated'))).toBeLessThan(1);
    expect(await drawnOpacity(pop(page))).toBe(1);
    if (c === 'labels') await page.screenshot({ path: join(screens, 'table-cells-03-picker-on-faded-row.png') });
    if (c === 'iteration') await page.screenshot({ path: join(screens, 'table-cells-04-iteration-list.png') });
    // inside the table's visible area (the last column opens leftwards)
    const [p, s] = [(await pop(page).boundingBox())!, (await page.locator('.table-scroll').boundingBox())!];
    expect(p.x + p.width).toBeLessThanOrEqual(s.x + s.width + 1);

    // PR #749 review round 1, problem 2: a press in the edited cell's own blank space, outside the picker / list, puts it away too
    const [tdBox, popBox] = [(await cell(page, 349, c).boundingBox())!, (await pop(page).boundingBox())!];
    const outsidePop = (x: number, y: number) => x < popBox.x || x > popBox.x + popBox.width || y < popBox.y || y > popBox.y + popBox.height;
    const spot = [
      [tdBox.x + 2, tdBox.y + 2],
      [tdBox.x + tdBox.width - 2, tdBox.y + 2],
      [tdBox.x + 2, tdBox.y + tdBox.height - 2],
      [tdBox.x + tdBox.width - 2, tdBox.y + tdBox.height - 2],
    ].find(([x, y]) => outsidePop(x, y));
    expect(spot, `a point of the ${c} cell outside its editor`).toBeTruthy();
    await page.mouse.click(spot![0], spot![1]);
    await expect(page.locator('[data-cell-editor]')).toHaveCount(0);
    await page.waitForTimeout(200);
    await expect(page.locator('[data-cell-editor]')).toHaveCount(0);
    await cell(page, 349, c).click();
    await expect(pop(page)).toBeVisible();

    // a press on another row's title: the editor goes away, the item does not open
    await title346.click();
    await expect(page.locator('[data-cell-editor]')).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page.getByTestId('detail')).toHaveCount(0);
    // a press on another editable cell: the editor goes away, that cell does not open
    await cell(page, 349, c).click();
    await expect(pop(page)).toBeVisible();
    await cell(page, 350, c === 'labels' ? 'assignees' : 'labels').click();
    await expect(page.locator('[data-cell-editor]')).toHaveCount(0);
    await page.waitForTimeout(200);
    await expect(page.locator('[data-cell-editor]')).toHaveCount(0);
    // a press on a heading: nothing moves
    const order = await heads(page);
    await cell(page, 349, c).click();
    await expect(pop(page)).toBeVisible();
    const h = (await page.locator('[data-testid="col-head"][data-col="updated"]').boundingBox())!;
    await page.mouse.move(h.x + 20, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x - 200, h.y + h.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('[data-cell-editor]')).toHaveCount(0);
    expect(await heads(page)).toEqual(order);
    expect(writes().slice(w0)).toEqual([]);
  }
  // with nothing open, a press on the title opens the item as before
  await title346.click();
  await expect(page.getByTestId('detail')).toBeVisible();
});

test('GitHub#747: the iteration list — arrows only move, Enter writes once, a click writes once', async () => {
  const { page } = await launchApp(env);
  await signedInTable(page);
  const list = page.getByTestId('cell-iteration').first();
  await cell(page, 349, 'iteration').click();
  await expect(list).toBeVisible();
  await expect(list).toBeFocused();
  const start = await list.inputValue();
  const w0 = writes().length;
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => list.inputValue()).not.toBe(start);
  const marked = await list.inputValue();
  await page.waitForTimeout(300);
  expect(writes().slice(w0)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-cell-editor]')).toHaveCount(0);
  await expect.poll(() => writes().slice(w0)).toEqual(['CavilSetIteration']);
  // a click on another option: one write, the list goes away
  await cell(page, 349, 'iteration').click();
  await expect(list).toBeVisible();
  const other = await list.evaluate((s: HTMLSelectElement, m) => [...s.options].find((o) => o.value !== m && o.value !== '')!.value, marked);
  const w1 = writes().length;
  await list.locator(`option[value="${other}"]`).click();
  await expect(page.locator('[data-cell-editor]')).toHaveCount(0);
  await expect.poll(() => writes().slice(w1)).toEqual(['CavilSetIteration']);
  // PR #749 review round 1, problem 1: ↓ then a click on the option now marked — written once, the list goes away
  await cell(page, 349, 'iteration').click();
  await expect(list).toBeVisible();
  const w15 = writes().length;
  const was = await list.inputValue();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => list.inputValue()).not.toBe(was);
  const nowMarked = await list.inputValue();
  expect(writes().slice(w15)).toEqual([]);
  await list.locator(`option[value="${nowMarked}"]`).click();
  await expect(page.locator('[data-cell-editor]')).toHaveCount(0);
  await expect.poll(() => writes().slice(w15)).toEqual(['CavilSetIteration']);
  await page.waitForTimeout(300);
  expect(writes().slice(w15)).toEqual(['CavilSetIteration']);
  // a click on the value it already has: no write, the list goes away
  await cell(page, 349, 'iteration').click();
  await expect(list).toBeVisible();
  const w16 = writes().length;
  await list.locator(`option[value="${await list.inputValue()}"]`).click();
  await expect(page.locator('[data-cell-editor]')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(writes().slice(w16)).toEqual([]);

  // Esc puts it away without a write
  await cell(page, 349, 'iteration').click();
  await expect(list).toBeVisible();
  const w2 = writes().length;
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-cell-editor]')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(writes().slice(w2)).toEqual([]);
});
