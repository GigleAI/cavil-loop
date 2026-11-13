// GitHub#466 / #472: the board, the table, the dependency view, the detail (floating panel and tab),
// the tab bar, the new-issue dialog, the "wait for…" dialog, the confirm dialogs, the shortcut list
// and the notice area in English — the real window (test build) and the real back end against the
// fake GitHub. The run-time half of the language checks for sub-issue ②: every visible text and
// every hover / label / placeholder in these areas is scanned for Chinese; Chinese is allowed only
// inside text shown as is (`data-verbatim`) and in the few kept words. The test data is full of
// Chinese on purpose — recorded issue titles, a Chinese comment, a Chinese label — so the check is
// seen to let GitHub's words through while the window's own words around them are English.
// Sub-issue ①'s areas (top bar, settings, sign-in) are test/e2e/i18n.spec.ts.

import { test, expect, type Page, type Frame } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { findCopies } from '../fake-github/writes';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { KEEP_LANG } from '../../src/shared/i18n';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const ISSUE = 137;
const CN_COMMENT = '这条评论是中文写的，应该原样显示';

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-i18n-areas-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  const w = env.fake.state.w;
  w.comments.set(`gigleai/cavil-loop#${ISSUE}`, [
    { id: 'C-cn', url: `https://github.com/GigleAI/cavil-loop/issues/${ISSUE}#c1`, createdAt: '2026-11-02T01:00:00Z', bodyHTML: `<p>${CN_COMMENT}</p>`, author: { login: 'user-2' } },
  ]);
  w.milestones.set('gigleai/cavil-loop', [{ number: 1, title: '第一版', state: 'open', due_on: null }]);
  // waiting for a human (not in another flow), so "wait for…" can be opened on it
  const copies = findCopies(env.fake.state as any, REPO, ISSUE)!;
  for (const r of copies.rest) r.labels = [{ name: 'pending/human', color: 'ededed' }];
  for (const c of copies.gql) c.labels.nodes = c.labels.nodes.filter((l: any) => l.name !== 'pending/PR').concat([{ ...c.labels.nodes[0], name: 'pending/human' }]);
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

/** the scan of test/e2e/i18n.spec.ts, run in a page or a frame (the discussion is its own frame) */
async function chineseIn(where: Page | Frame, selectors: string[], skip: string[] = []): Promise<string[]> {
  return where.evaluate(
    ({ selectors, skip, keep }) => {
      const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
      const out: string[] = [];
      const exempt = (el: Element) => Boolean(el.closest('[data-verbatim]')) || skip.some((s) => el.closest(s));
      const kept = (el: Element) => {
        const k = el.closest('[data-keep-lang]');
        return Boolean(k && keep.some((x) => x.text === k.textContent && x.lang === k.getAttribute('lang')));
      };
      let seen = 0;
      for (const sel of selectors)
        for (const root of Array.from(document.querySelectorAll(sel))) {
          seen++;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const el = n.parentElement;
            if (!el || exempt(el) || kept(el)) continue;
            if (el.closest('style, script')) continue;
            if (CJK.test(n.textContent ?? '')) out.push(`${sel}: ${(n.textContent ?? '').trim()}`);
          }
          for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
            if (exempt(el)) continue;
            const parts: string[] = el.hasAttribute('data-verbatim-parts') ? JSON.parse(el.getAttribute('data-verbatim-parts')!) : [];
            for (const a of ['title', 'aria-label', 'placeholder', 'alt']) {
              let v = el.getAttribute(a);
              if (!v) continue;
              for (const p of parts) v = v.split(p).join('');
              if (CJK.test(v)) out.push(`${sel} [${a}]: ${el.getAttribute(a)}`);
            }
          }
        }
      if (seen === 0) out.push(`nothing matched ${selectors.join(', ')}`);
      return out;
    },
    { selectors, skip, keep: KEEP_LANG.map((k) => ({ ...k })) },
  );
}

/** some Chinese of GitHub's is really on screen inside `sel`, inside its as-is marker (the check saw it and let it through) */
async function githubChineseShown(where: Page | Frame, sel: string): Promise<boolean> {
  return where.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} [data-verbatim]`)).some((e) => /[一-鿿]/.test(e.textContent ?? '')), sel);
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
}

async function english(app: RunningApp) {
  const page = app.page;
  await page.getByTestId('lang-en').check();
  await expect.poll(async () => (await app.backend.call<any>('init')).settings.uiLanguage, { timeout: 20_000 }).toBe('en');
  // the shortcut section's rows are this sub-issue's: Settings has no Chinese left outside sub-issue ③'s sections
  expect(await chineseIn(page, ['.settings-main #set-keys'])).toEqual([]);
  await page.getByTestId('back').click();
  await toBoard(page);
}

/** adding the Project imported its saved web view (a table, filtered): the board, unfiltered */
async function toBoard(page: Page) {
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await layout(page, 'board');
  await page.getByTestId('search').fill('');
  await expect(card(page, ISSUE)).toBeVisible({ timeout: 20_000 });
}

const card = (page: Page, n: number) => page.locator(`[data-testid="card"][data-key="gigleai/cavil-loop#${n}"]`).first();
const layout = (page: Page, l: 'board' | 'table' | 'graph') => page.locator(`[data-testid="layout"] button[data-value="${l}"]`).click();

test('GitHub#472: board, table, dependency view and view settings in English; Chinese titles and labels from GitHub as written', async () => {
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  await english(app);

  expect(await chineseIn(page, ['[data-testid="board"]'])).toEqual([]);
  expect(await githubChineseShown(page, '[data-testid="board"]'), 'recorded Chinese titles are on the board, marked as GitHub text').toBe(true);
  await shot(page, '472-01-board-en');

  await page.getByTestId('open-view-panel').click();
  await expect(page.getByTestId('view-panel')).toBeVisible();
  expect(await chineseIn(page, ['[data-testid="view-panel"]'])).toEqual([]);
  await shot(page, '472-02-view-settings-en');
  await page.keyboard.press('Escape');

  await layout(page, 'table');
  await expect(page.locator('[data-testid="row"]').first()).toBeVisible({ timeout: 20_000 });
  expect(await chineseIn(page, ['[data-testid="board"]'])).toEqual([]);
  expect(await githubChineseShown(page, '[data-testid="board"]')).toBe(true);
  await shot(page, '472-03-table-en');

  await layout(page, 'graph');
  await expect(page.getByTestId('graph')).toBeVisible();
  expect(await chineseIn(page, ['[data-testid="graph"]'])).toEqual([]);
  await shot(page, '472-04-graph-en');

  // the shortcut list
  await layout(page, 'board');
  await page.getByTestId('open-shortcuts').click();
  await expect(page.getByTestId('shortcut-help')).toBeVisible();
  expect(await chineseIn(page, ['[data-testid="shortcut-help"]'])).toEqual([]);
  await shot(page, '472-05-shortcuts-en');
  await page.getByTestId('shortcut-help-close').click();
  await app.close();
});

test('GitHub#472: the detail in English — floating panel and tab, the discussion frame; a Chinese comment shown as written, the words around it English; confirm, "wait for…" and new-issue dialogs; the notice area', async () => {
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  await english(app);

  // the floating panel
  await card(page, ISSUE).click();
  const detail = page.getByTestId('detail');
  await expect(detail).toHaveAttribute('data-key', `gigleai/cavil-loop#${ISSUE}`);
  await expect(detail.getByTestId('quick-actions')).toBeVisible({ timeout: 15_000 });
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  await expect(frame.locator('body')).toContainText(CN_COMMENT, { timeout: 15_000 });
  expect(await chineseIn(page, ['[data-testid="detail"]'])).toEqual([]);
  expect(await githubChineseShown(page, '[data-testid="detail"]'), 'the Chinese title is shown, marked as GitHub text').toBe(true);
  const handle = await page.getByTestId('timeline-frame').elementHandle();
  const inner = (await handle!.contentFrame())!;
  expect(await chineseIn(inner, ['body'])).toEqual([]);
  // the comment's Chinese is really there, inside its as-is marker
  expect(await githubChineseShown(inner, 'body')).toBe(true);
  await shot(page, '472-06-detail-en');

  // the confirm dialog of "close issue"
  await detail.getByTestId('close-issue').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  expect(await chineseIn(page, ['[data-testid="confirm-dialog"]'])).toEqual([]);
  await shot(page, '472-07-close-confirm-en');
  await page.getByTestId('confirm-cancel').click();

  // "wait for…"
  await detail.getByTestId('blocked-open').click();
  await expect(page.getByTestId('blocked-dialog')).toBeVisible();
  expect(await chineseIn(page, ['[data-testid="blocked-dialog"]'])).toEqual([]);
  await shot(page, '472-08-blocked-en');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('blocked-dialog')).toHaveCount(0);

  // the same item as a tab: the tab bar and the detail in the tab
  await page.getByTestId('detail-close').click();
  await card(page, ISSUE).click({ modifiers: ['Control'] });
  await expect(page.getByTestId('tab')).toHaveCount(1);
  await expect(page.getByTestId('detail')).toBeVisible();
  expect(await chineseIn(page, ['[data-testid="tabs"]', '[data-testid="detail"]'])).toEqual([]);
  await shot(page, '472-09-tab-en');

  // a field change and an operation's result in the notice area: close the issue
  await page.getByTestId('detail').getByTestId('close-issue').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('notice-area')).toBeVisible({ timeout: 15_000 });
  expect(await chineseIn(page, ['[data-testid="notice-area"]'])).toEqual([]);
  await shot(page, '472-10-notice-en');

  // the new-issue dialog
  // (closing the issue put its tab away: the board is in front again)
  await expect(page.getByTestId('tab')).toHaveCount(0);
  await page.getByTestId('write-entry').click();
  await expect(page.getByTestId('new-issue')).toBeVisible();
  await page.getByTestId('new-issue-title').fill('新的中文标题');
  expect(await chineseIn(page, ['[data-testid="new-issue"]'])).toEqual([]);
  await shot(page, '472-11-new-issue-en');
  await app.close();
});

test('GitHub#472: the same areas in Chinese read as before (default, nothing set)', async () => {
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  await page.getByTestId('back').click();
  await toBoard(page);
  await card(page, ISSUE).click();
  const detail = page.getByTestId('detail');
  await expect(detail.getByTestId('close-issue')).toContainText('关闭 issue…');
  await detail.getByTestId('close-issue').click();
  await expect(page.getByTestId('confirm-dialog').locator('h3')).toHaveText(`关闭 issue #${ISSUE}？`);
  await app.close();
});
