// GigleAI/cavil-loop#489: a reply (and an edit, a title, a ticked box) is sent by the app's controller, not
// waited for by the panel: the box is empty at once, the panel may be put away, and the result is said in
// the window's notice area. Refused for sure → the text goes back into the reply box; no answer → the text
// stays in the notice only (never back in the box), 「再查一次」 reads and sends nothing, and only the comment
// that appears proves it; a restart keeps it. The real window (built with --test-bridge), the real back end
// behind the loopback bridge, the local fake GitHub — every assertion is on what GitHub really received.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
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
const said = (page: Page) => page.locator('[data-testid="notice-area"] [data-testid="send-notice"]');
const posts = () => env.fake.log.filter((l) => l.method === 'POST' && l.path === `/api/repos/${REPO}/issues/${N}/comments`);
const onGitHub = (body: string) => (env.fake.state.w.comments.get(K(N)) ?? []).filter((c) => c.body === body).length;

async function openItem(page: Page) {
  await row(page).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(N));
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
}
async function reply(page: Page, text: string) {
  await detail(page).getByTestId('reply-input').fill(text);
  await detail(page).getByTestId('reply-send').click();
}

test('GitHub#489: a reply — the box empties at once and the panel may go; refused: back in the box; no answer: only in the notice, checked, never sent twice; a restart keeps it', async () => {
  let app = await launchApp(env);
  let page = app.page;
  await signIn(page);

  // ---- 1. sent, the panel put away before GitHub answers: the result is still said, once ----
  await openItem(page);
  const release = env.fake.holdWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/${N}/comments`);
  await reply(page, '先看这一版');
  await expect(detail(page).getByTestId('reply-input')).toHaveValue('');
  await expect(said(page).first()).toHaveAttribute('data-kind', 'busy');
  await expect(said(page).first().getByTestId('send-notice-text')).toHaveText('正在发评论…');
  await page.keyboard.press('Escape');
  await expect(detail(page)).toHaveCount(0);
  await expect.poll(() => posts().length).toBe(1);
  release();
  await expect(said(page).first()).toHaveAttribute('data-kind', 'ok', { timeout: 15_000 });
  await expect(said(page).first().getByTestId('send-notice-text')).toHaveText('评论已发出');
  await expect(said(page)).toHaveCount(1);
  expect(onGitHub('先看这一版')).toBe(1);
  await shot(page, '489-01-sent-panel-gone');
  await said(page).first().getByTestId('send-dismiss').click();
  await expect(said(page)).toHaveCount(0);

  // ---- 2. refused by GitHub: nothing there, the text back in the reply box, said in the notice area ----
  await openItem(page);
  env.fake.state.w.failComment = true;
  await reply(page, '这段会被拒');
  await expect(said(page).first()).toHaveAttribute('data-kind', 'error', { timeout: 15_000 });
  await expect(said(page).first().getByTestId('send-notice-text')).toContainText('原文已放回回复框');
  await expect(detail(page).getByTestId('reply-input')).toHaveValue('这段会被拒');
  await expect(said(page).first().getByTestId('send-resend')).toHaveCount(0); // the text can be sent from one place only
  env.fake.state.w.failComment = false;
  expect(onGitHub('这段会被拒')).toBe(0);
  await shot(page, '489-02-refused-back-in-box');
  await said(page).first().getByTestId('send-dismiss').click();
  await detail(page).getByTestId('reply-input').fill('');

  // ---- 3. no answer (GitHub took it, the connection dropped before it said so; it lands later) ----
  const late = env.fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/${N}/comments`);
  const before = posts().length;
  await reply(page, '可能已经发出去了');
  await expect(said(page).first()).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });
  await expect.poll(() => late.caught()).toBe(1);
  late.stop();
  // the box stays empty; the text is in the notice only, in full; no × while it is not sure
  await expect(detail(page).getByTestId('reply-input')).toHaveValue('');
  await expect(said(page).first().getByTestId('send-text')).toContainText('可能已经发出去了');
  await expect(said(page).first().getByTestId('send-notice-text')).toContainText('没有放回编辑框');
  await expect(said(page).first().getByTestId('send-dismiss')).toHaveCount(0);
  await expect(said(page).first().getByTestId('send-recheck')).toBeVisible();
  await shot(page, '489-03-unknown-text-in-notice');
  // 「再查一次」: a read only — still not sure, nothing sent
  await said(page).first().getByTestId('send-recheck').click();
  await expect(said(page).first().getByTestId('send-notice-text')).toContainText('还没查到');
  expect(posts().length).toBe(before + 1);

  // ---- 4. a restart: still there, with its text ----
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await expect(said(page).first()).toHaveAttribute('data-state', 'unknown', { timeout: 15_000 });
  await expect(said(page).first().getByTestId('send-text')).toContainText('可能已经发出去了');
  // the request lands now; the next check proves it: done, the text gone, exactly one comment, one request
  late.land();
  expect(onGitHub('可能已经发出去了')).toBe(1);
  await said(page).first().getByTestId('send-recheck').click();
  await expect(said(page).first()).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
  await expect(said(page).first().getByTestId('send-notice-text')).toContainText('在评论列表里找到了这条评论');
  await expect(said(page).first().getByTestId('send-text')).toHaveCount(0);
  expect(posts().length).toBe(before + 1);
  expect(onGitHub('可能已经发出去了')).toBe(1);
  await shot(page, '489-04-proven-after-restart');
  await app.close();
});
