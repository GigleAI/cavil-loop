// GigleAI/cavil-loop#502: ⌘F finds text on the page — never the board's search box. The real window (built with
// --test-bridge), the real back end behind the loopback bridge, the local fake GitHub. The discussion frame is the
// real isolated frame: its matches are found by its own script and reported back.

import { test, expect, type Frame, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { findCopies } from '../fake-github/writes';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
const A = 139;
const B = 142;

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(closeEngine);

let tick = 0;
function retitle(n: number, title: string) {
  const c = findCopies(env.fake.state, REPO, n)!;
  const when = new Date(Date.now() + ++tick * 1000).toISOString();
  for (const r of c.rest) {
    r.title = title;
    r.updated_at = when;
  }
  for (const g of c.gql) {
    g.title = title;
    g.updatedAt = when;
  }
}

async function signIn(page: Page) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  for (const s of [PROJECT_URL, REPO]) {
    await page.getByTestId('source-input').fill(s);
    await page.getByTestId('source-add').click();
  }
  await page.getByTestId('back').click();
  await page.keyboard.press('Control+Shift+2');
  await expect(row(page, A)).toBeVisible({ timeout: 20_000 });
}

const row = (page: Page, n: number) => page.locator(`[data-testid="row"][data-key="${K(n)}"] [data-testid="title-cell"]`).first();
const bar = (page: Page) => page.getByTestId('find-bar');
const input = (page: Page) => page.getByTestId('find-input');
const count = (page: Page) => page.getByTestId('find-count');
const detail = (page: Page) => page.getByTestId('detail');
/** what the window highlights: all matches but the current one, and the current one */
const winMarks = (page: Page) =>
  page.evaluate(() => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
    return { all: h.get('cavil-find')?.size ?? 0, cur: [...(h.get('cavil-find-cur') ?? [])].map((r) => r.toString()) };
  });
const frameMarks = (f: Frame) =>
  f.evaluate(() => {
    const h = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
    const cur = [...(h.get('cavil-find-cur') ?? [])];
    return {
      all: h.get('cavil-find')?.size ?? 0,
      cur: cur.map((r) => r.toString()),
      curEntry: cur.map((r) => (r.startContainer.parentElement?.closest('details.entry') as HTMLDetailsElement | null)?.getAttribute('data-entry') ?? null),
      open: [...document.querySelectorAll('details.entry')].filter((d) => (d as HTMLDetailsElement).open).map((d) => d.getAttribute('data-entry')),
    };
  });
async function frameOf(page: Page): Promise<Frame> {
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  return (await page.getByTestId('timeline-frame').elementHandle())!.contentFrame() as Promise<Frame>;
}
const expectCount = async (page: Page, pos: number, total: number) => {
  await expect(count(page)).toHaveAttribute('data-pending', 'no');
  await expect(count(page)).toHaveAttribute('data-total', String(total));
  await expect(count(page)).toHaveAttribute('data-pos', String(pos));
};

test('⌘F opens the find bar and finds text on the page: count, next / previous with wrap-around, the search box and the board untouched, Esc clears', async () => {
  retitle(A, 'Quokka one and quokka two');
  retitle(B, 'a QUOKKA here');
  const { page } = await launchApp(env);
  await signIn(page);
  const search = page.getByTestId('search');
  // adding the Project imports its saved web view: wait for that first. Since GitHub#464 its filter
  // (-label:Done -status:Done, only hiding finished items) is left out of the box, so wait on the
  // import's own mark and check the box stayed empty
  await expect
    .poll(() => page.evaluate(async () => ((await (window as any).cavil.get()).state.view.imported?.viewNumber ?? null) as number | null), { timeout: 15_000 })
    .toBe(1);
  await expect(search).toHaveValue('');
  await expect
    .poll(() => page.evaluate(async () => ((await (window as any).cavil.get()).state.sync.sources as { ok: boolean }[]).map((x) => x.ok)), { timeout: 20_000 })
    .toEqual([true, true]);
  const searchBefore = await search.inputValue();
  const rowsBefore = await page.getByTestId('row').count();

  await page.keyboard.press('ControlOrMeta+f');
  await expect(bar(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await input(page).fill('quokka');
  // three in the window: two in one title (case does not matter), one in another
  await expectCount(page, 1, 3);
  const m0 = await winMarks(page);
  expect(m0.all).toBe(2);
  expect(m0.cur.map((t) => t.toLowerCase())).toEqual(['quokka']);
  await shot(page, '502-01-find-board');

  await page.keyboard.press('Enter');
  await expectCount(page, 2, 3);
  await page.keyboard.press('Enter');
  await expectCount(page, 3, 3);
  await page.keyboard.press('Enter');
  await expectCount(page, 1, 3);
  await page.keyboard.press('Shift+Enter');
  await expectCount(page, 3, 3);
  await page.keyboard.press('ControlOrMeta+g');
  await expectCount(page, 1, 3);
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expectCount(page, 3, 3);
  await page.getByTestId('find-next').click();
  await expectCount(page, 1, 3);
  await page.getByTestId('find-prev').click();
  await expectCount(page, 3, 3);

  // ⌘F again while open: back to the bar with its text selected
  await search.focus();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(input(page)).toBeFocused();
  expect(await input(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 6]);

  // nothing found: said so, and nothing is highlighted
  await input(page).fill('quokkaz');
  await expect(count(page)).toHaveText('没有找到');
  await expect(page.locator('.find-box.none')).toHaveCount(1);
  expect(await winMarks(page)).toEqual({ all: 0, cur: [] });
  await shot(page, '502-02-not-found');
  await input(page).fill('quokka');
  await expectCount(page, 1, 3);

  // the board's search box and the rows were never touched
  expect(await search.inputValue()).toBe(searchBefore);
  expect(await page.getByTestId('row').count()).toBe(rowsBefore);

  // Esc in the bar: closed, highlights gone, the keyboard back where it was (the search box)
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  expect(await winMarks(page)).toEqual({ all: 0, cur: [] });
  await expect(search).toBeFocused();
  expect(await search.inputValue()).toBe(searchBefore);

  // ⌘G with the bar closed is not taken; "/" still goes to the search box
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+g');
  await expect(bar(page)).toHaveCount(0);
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await expect(bar(page)).toHaveCount(0);
});

test('a sync that changes the page updates the count', async () => {
  retitle(A, 'Pangolin first');
  const app = await launchApp(env);
  const { page } = app;
  await signIn(page);
  await page.keyboard.press('ControlOrMeta+f');
  await input(page).fill('pangolin');
  await expectCount(page, 1, 1);
  expect((await winMarks(page)).cur).toEqual(['Pangolin']);
  retitle(B, 'pangolin second');
  // one sync round, the way the shell's beat starts it (again, should a round already be running)
  await expect
    .poll(
      async () => {
        await app.desktop.push({ kind: 'tick' });
        return row(page, B).textContent();
      },
      { timeout: 30_000, intervals: [1000] },
    )
    .toMatch(/pangolin second/);
  // one more; the current one stays the one it was (wherever the new one landed in the order)
  await expect(count(page)).toHaveAttribute('data-total', '2');
  await expect(count(page)).toHaveAttribute('data-pending', 'no');
  expect((await winMarks(page)).cur).toEqual(['Pangolin']);
  expect((await winMarks(page)).all).toBe(1);
});

test('the discussion takes part: its matches count, the current one is highlighted in it and a folded entry unfolds; ⌘F / ⌘G work from inside it; Esc there closes find only', async () => {
  retitle(A, 'Wombat in the title');
  env.fake.state.w.comments.set(K(A), [
    { id: 'IC_old', url: `https://github.com/${REPO}/issues/${A}#issuecomment-1`, createdAt: '2026-01-02T00:00:00Z', bodyHTML: '<p>an older note: the <b>wom</b>bat was here</p>', author: { login: 'user-2' } },
    { id: 'IC_new', url: `https://github.com/${REPO}/issues/${A}#issuecomment-2`, createdAt: '2026-01-03T00:00:00Z', bodyHTML: '<p>latest: no animal</p><p>WOMBAT again</p>', author: { login: 'user-3' } },
  ]);
  const { page } = await launchApp(env);
  await signIn(page);
  await row(page, A).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  const f = await frameOf(page);
  // the older entry is folded when the discussion opens
  expect((await frameMarks(f)).open).not.toContain('IC_old');

  await page.keyboard.press('ControlOrMeta+f');
  await input(page).fill('wombat');
  // the window: the title in the row and the panel's heading; the frame: one per comment (one across <b>)
  await expect(count(page)).toHaveAttribute('data-total', '4');
  await expectCount(page, 1, 4);
  // step to the first one in the discussion
  const before = await page.evaluate(() => {
    const frame = document.querySelector('[data-testid="timeline-frame"]')!;
    const ranges = [...((CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('cavil-find') ?? [])];
    const cur = [...((CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('cavil-find-cur') ?? [])];
    return [...ranges, ...cur].filter((r) => (frame.compareDocumentPosition(r.startContainer) & Node.DOCUMENT_POSITION_PRECEDING) !== 0).length;
  });
  for (let i = 0; i < before; i++) await page.keyboard.press('Enter');
  await expectCount(page, before + 1, 4);
  // the discussion lists the newest first: its first match is in the open, latest comment
  await expect.poll(async () => (await frameMarks(f)).cur).toEqual(['WOMBAT']);
  const m1 = await frameMarks(f);
  expect(m1.curEntry).toEqual(['IC_new']);
  expect(m1.all).toBe(1);
  expect(m1.open).not.toContain('IC_old');
  // the window shows no current match of its own while the current one is in the frame
  expect((await winMarks(page)).cur).toEqual([]);
  await page.keyboard.press('Enter');
  await expectCount(page, before + 2, 4);
  // the next one is in the folded, older comment (across <b>): it unfolds
  await expect.poll(async () => (await frameMarks(f)).curEntry).toEqual(['IC_old']);
  const m2 = await frameMarks(f);
  expect(m2.cur).toEqual(['wombat']);
  expect(m2.open).toContain('IC_old');
  await shot(page, '502-03-find-in-discussion');

  // the keyboard in the discussion: ⌘G steps, ⌘F goes back to the bar
  await f.locator('details.entry[data-entry="IC_new"] .md p').first().click();
  await page.keyboard.press('ControlOrMeta+g');
  await expect(count(page)).toHaveAttribute('data-pos', String(((before + 2) % 4) + 1));
  await f.locator('details.entry[data-entry="IC_new"] .md p').first().click();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(input(page)).toBeFocused();

  // Esc with the keyboard in the discussion: find closes (both sides' highlights gone), the panel stays, the keyboard stays in the discussion
  const fm = await frameMarks(f);
  expect(fm.all + fm.cur.length).toBeGreaterThan(0);
  await f.locator('details.entry[data-entry="IC_new"] .md p').first().click();
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await expect.poll(async () => { const m = await frameMarks(f); return m.all + m.cur.length; }).toBe(0);
  expect(await winMarks(page)).toEqual({ all: 0, cur: [] });
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('timeline-frame');

  // find closed: Esc in the discussion does what it always did there (nothing reaches the window)
  await f.locator('details.entry[data-entry="IC_new"] .md p').first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await expect(detail(page)).toHaveAttribute('data-key', K(A));

  // an Esc from the frame arriving after find closed is dropped: never "back to the home tab"
  await f.evaluate(() => parent.postMessage({ cavil: 'findEsc', render: document.body.getAttribute('data-render') }, '*'));
  await page.waitForTimeout(300);
  await expect(detail(page)).toHaveAttribute('data-key', K(A));

  // find open, the keyboard on the page (not in the bar): the first Esc closes find only, the second does what Esc did before
  await page.keyboard.press('ControlOrMeta+f');
  await input(page).fill('wombat');
  await expectCount(page, 1, 4);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  await page.keyboard.press('Escape');
  await expect(detail(page)).toHaveCount(0);
});

test('a dialog on top keeps its Esc while find is open', async () => {
  const { page } = await launchApp(env);
  await signIn(page);
  await page.keyboard.press('ControlOrMeta+f');
  await input(page).fill('a');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // the shortcut list is a layer: Esc closes it, find stays open
  await page.keyboard.press('Shift+?');
  await expect(page.getByTestId('shortcut-help')).toBeVisible();
  await expect(page.getByTestId('shortcut-help')).toContainText('在页面上查找文字');
  await expect(page.getByTestId('shortcut-help')).toContainText('查找栏里');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcut-help')).toHaveCount(0);
  await expect(bar(page)).toBeVisible();
});

test('without highlight support the current match is selected instead — and find takes that selection away again (closed, nothing found, moved), in the window and in the discussion; a selection the person made is left alone', async () => {
  retitle(A, 'Wombat in the title');
  env.fake.state.w.comments.set(K(A), [
    { id: 'IC_new', url: `https://github.com/${REPO}/issues/${A}#issuecomment-2`, createdAt: '2026-01-03T00:00:00Z', bodyHTML: '<p>a WOMBAT here</p>', author: { login: 'user-3' } },
  ]);
  const app = await launchApp(env);
  const { page } = app;
  // a web engine without the highlight API (WebKit before macOS 14.2): for the window and every frame, before any script
  await page.context().addInitScript(() => {
    Object.defineProperty(window, 'Highlight', { value: undefined, configurable: true, writable: true });
  });
  await page.reload();
  await signIn(page);
  // the range itself: with the keyboard in a text field Chromium's Selection.toString() reports that field instead
  const sel = () => page.evaluate(() => { const s = getSelection(); return s && s.rangeCount ? s.getRangeAt(0).toString() : ''; });

  // the window: selected while current, gone when nothing is found, back, gone on close
  await page.keyboard.press('ControlOrMeta+f');
  await input(page).fill('wombat');
  await expectCount(page, 1, 1);
  expect(await page.evaluate(() => typeof (window as unknown as { Highlight?: unknown }).Highlight)).toBe('undefined');
  await page.keyboard.press('Enter');
  await expect.poll(sel).toBe('Wombat');
  await input(page).fill('wombatz');
  await expect(count(page)).toHaveText('没有找到');
  await expect.poll(sel).toBe('');
  await input(page).fill('wombat');
  await expectCount(page, 1, 1);
  await page.keyboard.press('Enter');
  await expect.poll(sel).toBe('Wombat');
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await expect.poll(sel).toBe('');

  // a selection the person makes after find selected its match is not taken away on close
  await page.keyboard.press('ControlOrMeta+f');
  await input(page).fill('wombat');
  await page.keyboard.press('Enter');
  await expect.poll(sel).toBe('Wombat');
  await page.evaluate(() => {
    const t = document.querySelector('[data-testid="search"]')!.closest('header')!.querySelector('h1, .brand, span') ?? document.body;
    const r = document.createRange();
    r.selectNodeContents(t);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
  });
  const mine = await sel();
  expect(mine).not.toBe('Wombat');
  await page.getByTestId('find-close').click();
  await expect(bar(page)).toHaveCount(0);
  expect(await sel()).toBe(mine);

  // the discussion: its match selected inside it; moving back to the window's match, and closing, take it away
  await row(page, A).click();
  const f = await frameOf(page);
  expect(await f.evaluate(() => typeof (window as unknown as { Highlight?: unknown }).Highlight)).toBe('undefined');
  const fsel = () => f.evaluate(() => { const s = getSelection(); return s && s.rangeCount ? s.getRangeAt(0).toString() : ''; });
  await page.keyboard.press('ControlOrMeta+f');
  await input(page).fill('wombat');
  // the row title and the panel heading in the window, one in the discussion
  await expectCount(page, 1, 3);
  // the discussion sits after both window matches: the third one is in it
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expectCount(page, 3, 3);
  await expect.poll(fsel).toBe('WOMBAT');
  // the next one wraps to the window: the discussion's selection goes
  await page.keyboard.press('Enter');
  await expectCount(page, 1, 3);
  await expect.poll(fsel).toBe('');
  await page.keyboard.press('Shift+Enter');
  await expectCount(page, 3, 3);
  await expect.poll(fsel).toBe('WOMBAT');
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await expect.poll(fsel).toBe('');
});
