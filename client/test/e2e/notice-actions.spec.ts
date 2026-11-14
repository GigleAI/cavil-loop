// GitHub#490: a failed notice offers at most 「重试」 + one way out + ×, and what 「重试」 does follows how sure the
// outcome is. The real window (built with --test-bridge), the real back end behind the loopback bridge, the local
// fake GitHub — every assertion on what was sent is on what GitHub really received.
//   1. a close GitHub refused: 「重新关闭」 goes out at once with the same reason and comment (no dialog)
//   2. a reply whose answer never came: 「再查一次」 reads only; 「到 GitHub 上核对」 is two steps in one place — the
//      first opens the page and copies the text (a copy that fails says so, the text stays), the lock stays, no ×;
//      a restart keeps the text and the step; the second step unlocks locally (no request), × then clears the text

import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
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
const N = 139;

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  const c = findCopies(env.fake.state, REPO, N)!;
  for (const r of c.rest) Object.assign(r, { state: 'open', state_reason: null, labels: [] });
  for (const g of c.gql) Object.assign(g, { state: 'OPEN', stateReason: null, labels: { nodes: [] } });
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(closeEngine);

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
  await expect(row(page)).toBeVisible({ timeout: 20_000 });
}

const row = (page: Page) => page.locator(`[data-testid="row"][data-key="${K(N)}"] [data-testid="title-cell"]`).first();
const detail = (page: Page) => page.getByTestId('detail');
const area = (page: Page) => page.getByTestId('notice-area');
const posts = () => env.fake.log.filter((l) => l.method === 'POST' && l.path === `/api/repos/${REPO}/issues/${N}/comments`);
const closes = () => env.fake.writes().filter((w) => w.method === 'PATCH' && w.path === `/api/repos/${REPO}/issues/${N}`);
const onGitHub = (body: string) => (env.fake.state.w.comments.get(K(N)) ?? []).filter((c) => c.body === body).length;
const opened = () => (existsSync(env.opened!) ? readFileSync(env.opened!, 'utf8') : '');
/** the window's clipboard: what it was given; `fail` = every copy fails */
async function clipboard(page: Page, fail: boolean) {
  await page.evaluate((fail) => {
    (window as any).__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => (fail ? Promise.reject(new Error('denied')) : ((window as any).__copied.push(t), undefined)) },
    });
  }, fail);
}
const copied = (page: Page) => page.evaluate(() => (window as any).__copied as string[]);

async function openItem(page: Page) {
  await row(page).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(N));
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
}

test('GitHub#490: a refused close — 「重新关闭」 at once with the same choices; 「到 GitHub 上处理」 opens the page and copies the comment', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  await openItem(page);
  env.fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
  await page.getByTestId('close-issue').click();
  await page.getByTestId('close-reason-not_planned').check();
  await page.getByTestId('close-comment').fill('不做了，原因见上');
  await page.getByTestId('confirm-ok').click();
  const notice = area(page).locator(`[data-testid="op-notice"][data-key="${K(N)}"]`);
  await expect(notice).toHaveAttribute('data-kind', 'error', { timeout: 15_000 });
  await expect(notice.locator('.op-buttons button')).toHaveCount(2);
  await expect(notice.getByTestId('op-retry')).toHaveText('重新关闭');
  await expect(notice.getByTestId('op-fallback')).toHaveText('到 GitHub 上处理');
  await expect(notice.getByTestId('op-dismiss')).toBeVisible();
  await page.keyboard.press('Escape');
  await shot(page, '490-01-refused-close');
  await clipboard(page, false);
  await notice.getByTestId('op-fallback').click();
  await expect.poll(opened).toContain(`https://github.com/${REPO}/issues/${N}`);
  expect(await copied(page)).toEqual(['不做了，原因见上']);
  expect(closes()).toHaveLength(1);
  env.fake.state.w.readOnlyRepos.clear();
  await notice.getByTestId('op-retry').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(notice.getByTestId('op-notice-text')).toHaveText(`issue #${N} 已关闭（不计划），评论已发出`, { timeout: 15_000 });
  expect(closes().map((w) => w.body)).toEqual([
    { state: 'closed', state_reason: 'not_planned' },
    { state: 'closed', state_reason: 'not_planned' },
  ]);
  expect(onGitHub('不做了，原因见上')).toBe(1);
  await app.close();
});

test('GitHub#490: a reply whose answer never came — 「再查一次」 reads only; 「到 GitHub 上核对」 in two steps, a failed copy said, the text kept over a restart; the unlock sends nothing', async () => {
  let app = await launchApp(env);
  let page = app.page;
  await signIn(page);
  await openItem(page);
  const late = env.fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/${N}/comments`);
  await detail(page).getByTestId('reply-input').fill('可能已经发出去的评论');
  await detail(page).getByTestId('reply-send').click();
  const said = area(page).locator('[data-testid="send-notice"]').first();
  await expect(said).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });
  await expect.poll(() => late.caught()).toBe(1);
  late.stop();
  await page.keyboard.press('Escape');
  await expect(said.locator('.op-buttons button')).toHaveCount(2);
  await expect(said.getByTestId('send-retry')).toHaveText('再查一次');
  await expect(said.getByTestId('send-fallback')).toHaveText('到 GitHub 上核对');
  await expect(said.getByTestId('send-fallback')).toHaveAttribute('data-step', 'open');
  await expect(said.getByTestId('send-dismiss')).toHaveCount(0);
  await shot(page, '490-02-reply-unknown');
  // 「再查一次」: a read, nothing sent
  await said.getByTestId('send-retry').click();
  await expect(said.getByTestId('send-notice-text')).toContainText('还没查到');
  expect(posts()).toHaveLength(1);

  // the first step with a clipboard that refuses: said next to the button, the page opened all the same, the text stays
  await clipboard(page, true);
  await said.getByTestId('send-fallback').click();
  await expect(said.getByTestId('send-fallback-problem')).toContainText('复制失败');
  await expect.poll(opened).toContain(`https://github.com/${REPO}/issues/${N}`);
  await expect(said.getByTestId('send-text')).toContainText('可能已经发出去的评论');
  // opened: the same place now is the unlock; still locked, no ×; the reply box stays empty
  await expect(said.getByTestId('send-fallback')).toHaveAttribute('data-step', 'confirm');
  await expect(said.getByTestId('send-fallback')).toHaveText('已在 GitHub 上核对过，解除锁定');
  await expect(said.getByTestId('send-dismiss')).toHaveCount(0);
  // the item opened again: the reply box stays empty (the text may already be on GitHub)
  await openItem(page);
  await expect(detail(page).getByTestId('reply-input')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(detail(page)).toHaveCount(0);
  await shot(page, '490-03-reply-unknown-page-opened');

  // a restart: the text and the step are still there
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  const again = area(page).locator('[data-testid="send-notice"]').first();
  await expect(again).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });
  await expect(again.getByTestId('send-text')).toContainText('可能已经发出去的评论');
  await expect(again.getByTestId('send-fallback')).toHaveAttribute('data-step', 'confirm');
  await expect(again.getByTestId('send-dismiss')).toHaveCount(0);

  // the unlock: local only — not one request; × appears, the text stays until it is pressed
  const writesBefore = env.fake.writes().length;
  await again.getByTestId('send-fallback').click();
  await expect(again.getByTestId('send-dismiss')).toBeVisible();
  await expect(again.getByTestId('send-text')).toContainText('可能已经发出去的评论');
  await expect(again.getByTestId('send-notice-text')).toContainText('已由人核对后解除锁定');
  expect(env.fake.writes().length).toBe(writesBefore);
  await shot(page, '490-04-reply-unlocked');
  await again.getByTestId('send-dismiss').click();
  await expect(area(page).locator('[data-testid="send-notice"]')).toHaveCount(0);
  expect(posts()).toHaveLength(1);
  expect(onGitHub('可能已经发出去的评论')).toBe(0);
  await app.close();
});
