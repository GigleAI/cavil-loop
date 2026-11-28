// GigleAI/cavil-loop#752: the table's 「收件箱」 and 「最近完成」, at the top of its left column. In the real window
// (built with --test-bridge), the real back end behind the loopback bridge, the fake GitHub serving the board
// recorded from the real cavil project, signed in as user-6 (the author of most of its items). The expected
// rows are picked here straight from what the window holds, with the rules written out in this file (author
// or assignee, any case; the pending label; completed / merged; the update time) — not with the app's functions.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCavilProjectPages, startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';
import { unfoldSettings } from './unfold';
import type { Item } from '../../src/shared/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const ME = 'user-6';
const DAY = 86_400_000;
const lc = (s: string | null) => (s ?? '').toLowerCase();

// The recording has no item of ME carrying the pending label: one open issue and one closed issue of ME get it
// here; a third open issue of ME (no label) and an open issue of someone else get an unread notification.
const recorded = loadCavilProjectPages();
const contents = recorded.flatMap((pg: any) => pg.items.nodes).map((n: any) => n.content).filter((c: any) => c?.number != null && c.labels && c.__typename === 'Issue');
const isMineRaw = (c: any) => lc(c.author?.login) === ME || (c.assignees?.nodes ?? []).some((a: any) => lc(a.login) === ME);
const openMine = contents.filter((c: any) => c.state === 'OPEN' && isMineRaw(c));
const PENDING_OPEN: number = openMine[0]?.number;
const NOTIFIED: number = openMine[1]?.number;
const PENDING_CLOSED: number = contents.find((c: any) => c.state === 'CLOSED' && isMineRaw(c))?.number;
const OTHERS: number = contents.find((c: any) => c.state === 'OPEN' && !isMineRaw(c))?.number;
function pages() {
  const data = loadCavilProjectPages();
  let done = 0;
  const walk = (v: any): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (v.content && typeof v.content === 'object' && (v.content.number === PENDING_OPEN || v.content.number === PENDING_CLOSED) && v.content.__typename === 'Issue' && v.content.labels) {
      v.content.labels = { ...v.content.labels, nodes: [...v.content.labels.nodes, { name: 'pending/human', color: 'd93f0b' }] };
      done++;
    }
    Object.values(v).forEach(walk);
  };
  walk(data);
  if (done !== 2) throw new Error(`the recording no longer holds #${PENDING_OPEN} / #${PENDING_CLOSED} as expected`);
  return data;
}

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-inbox-'));
  env = {
    fake: await startFakeGitHub({ viewer: ME, projects: new Map([['org/gigleai/11', pages()]]) }),
    userData: join(dir, 'userData'),
    cred: join(dir, 'cred'),
    opened: join(dir, 'opened.txt'),
    requests: join(dir, 'requests.txt'),
  };
  // the window runs on the real clock: GitHub's gap between inbox reads made short, so each beat may read it
  env.fake.state.inbox.pollSecs = 1;
  env.fake.state.inbox.threads = [];
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

const mine = (i: Item) => lc(i.author) === ME || i.assignees.some((a) => lc(a) === ME);
const human = (i: Item) => i.labels.some((l) => l.name.toLowerCase() === 'pending/human');
const done = (i: Item) => (i.kind === 'pr' ? i.state === 'merged' : i.state !== 'open' && i.stateReason === 'completed');
const newest = (a: Item, b: Item) => (a.updatedAt !== b.updatedAt ? (a.updatedAt > b.updatedAt ? -1 : 1) : a.key < b.key ? -1 : 1);
const items = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).data.items as Item[]);
const rowKeys = (page: Page) => page.$$eval('[data-testid="row"]', (rs) => rs.map((r) => r.getAttribute('data-key')!));
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

const REPO = 'GigleAI/cavil-loop';
/** a thread of GitHub's notification inbox for an issue of the board (GitHub's shape) */
function notify(n: number, id: string, reason: string) {
  const url = `${env.fake.api}/repos/${REPO}/issues/${n}`;
  env.fake.state.inbox.threads.push({ id, unread: true, reason, updated_at: new Date(Date.now() - 60_000).toISOString(), subject: { title: `issue ${n}`, url, latest_comment_url: url, type: 'Issue' }, repository: { full_name: REPO } });
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
  await expect.poll(async () => (await items(page)).length).toBeGreaterThan(0);
}

test('GitHub#752: 「收件箱」 lists my pending items open and closed plus my unread GitHub notifications, newest first; 「最近完成」 my done items of the last N days; both kept across a restart', async () => {
  expect([PENDING_OPEN, NOTIFIED, PENDING_CLOSED, OTHERS].every((n) => typeof n === 'number')).toBe(true);
  notify(NOTIFIED, '9001', 'mention');
  notify(OTHERS, '9002', 'mention');

  let app = await launchApp(env);
  let page = app.page;
  await ready(page);
  app.desktop.push({ kind: 'active' });
  // the inbox read once (the first sync round reads it)
  await expect.poll(async () => (app.desktop.push({ kind: 'tick' }), env.fake.log.filter((e) => e.operation === 'notifications' && e.status === 200).length), { timeout: 15_000 }).toBeGreaterThan(0);
  const all = await items(page);
  const mineKey = `${lc(REPO)}#${NOTIFIED}`;
  const othersKey = `${lc(REPO)}#${OTHERS}`;
  expect(all.find((i) => i.key === mineKey)).toBeTruthy();
  const pendingMine = all.filter((i) => human(i) && mine(i));
  // not vacuous: pending items of mine, one of them closed; pending items of others the inbox leaves out
  expect(pendingMine.length).toBeGreaterThan(0);
  expect(pendingMine.some((i) => i.state !== 'open')).toBe(true);
  expect(all.some((i) => human(i) && !mine(i))).toBe(true);
  const inboxWant = [...pendingMine, all.find((i) => i.key === mineKey)!].sort(newest).map((i) => i.key);

  // ---- the two entries are there, above the repositories, with their counts; 「显示已关闭」 is off ----
  await expect(page.getByTestId('slice-inbox')).toBeVisible();
  await expect(page.getByTestId('slice-done')).toBeVisible();
  await expect.poll(() => page.getByTestId('slice-inbox-count').textContent(), { timeout: 15_000 }).toBe(String(inboxWant.length));
  const before = await rowKeys(page);
  expect(before).not.toEqual(inboxWant);

  // ---- 收件箱: exactly those, newest update first, flat, the repository a column; the notified one says why ----
  await page.getByTestId('slice-inbox').click();
  await expect(page.getByTestId('slice-inbox')).toHaveClass(/on/);
  await expect.poll(() => rowKeys(page)).toEqual(inboxWant);
  await expect(page.locator('[data-testid="row"]:not([data-depth="0"])')).toHaveCount(0);
  await expect(page.getByTestId('group-head')).toHaveCount(0);
  await expect(page.locator(`[data-testid="row"][data-key="${mineKey}"] [data-testid="inbox-why"]`)).toHaveAttribute('data-why', 'mention');
  await expect(page.locator(`[data-testid="row"][data-key="${othersKey}"]`)).toHaveCount(0);
  await expect(page.locator('[data-testid="cell"][data-col="repo"]').first()).toBeVisible();
  await expect(page.getByTestId('list-line')).toContainText(`${inboxWant.length}`);
  await expect(page.getByTestId('inbox-note')).toHaveCount(0);
  await shot(page, 'inbox-01-inbox');

  // ---- opened in the app: the notified one leaves; the pending ones stay ----
  await page.locator(`[data-testid="row"][data-key="${mineKey}"] [data-testid="title-cell"]`).click();
  await expect.poll(() => rowKeys(page)).toEqual(inboxWant.filter((k) => k !== mineKey));
  await page.keyboard.press('Escape');

  // ---- 最近完成: my done items updated in the last 7 days, newest first; 30 days widens it ----
  const doneWant = (days: number) =>
    all
      .filter((i) => mine(i) && done(i) && Date.parse(i.updatedAt) >= Date.now() - days * DAY)
      .sort(newest)
      .map((i) => i.key);
  expect(doneWant(30).length).toBeGreaterThan(doneWant(7).length);
  await page.getByTestId('slice-done').click();
  await expect.poll(() => rowKeys(page)).toEqual(doneWant(7));
  await expect(page.getByTestId('slice-done-count')).toHaveText(String(doneWant(7).length));
  await page.getByTestId('done-days').selectOption('30');
  await expect.poll(() => rowKeys(page)).toEqual(doneWant(30));
  await expect(page.getByTestId('slice-done-count')).toHaveText(String(doneWant(30).length));
  await shot(page, 'inbox-02-done');
  // a number typed by hand: out of range is refused, 365 is taken
  await page.getByTestId('done-days').selectOption('custom');
  await page.getByTestId('done-days-custom').fill('0');
  await page.getByTestId('done-days-apply').click();
  await expect(page.getByTestId('done-days-bad')).toBeVisible();
  await expect.poll(async () => (await page.evaluate(async () => (await (window as any).cavil.get()).state.doneDays))).toBe(30);
  await page.getByTestId('done-days-custom').fill('365');
  await page.getByTestId('done-days-custom').press('Enter');
  await expect.poll(async () => (await page.evaluate(async () => (await (window as any).cavil.get()).state.doneDays))).toBe(365);
  await expect.poll(() => rowKeys(page)).toEqual(doneWant(365));

  // ---- the view bar's 「只看我的」 switch makes no difference here (its panel's conditions always apply) ----
  await expect(page.getByTestId('mine-filter-toggle')).toHaveAttribute('data-on', 'no');

  // ---- a restart keeps the entry picked and the days ----
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('slice-done')).toHaveClass(/on/);
  await expect(page.getByTestId('done-days')).toHaveValue('365');

  // ---- 「左侧按仓库切片」 off: the two entries stay, the repositories go ----
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('slice-by-repo').uncheck();
  await expect(page.getByTestId('slice-inbox')).toBeVisible();
  await expect(page.locator('[data-testid="slice"]')).toHaveCount(0);
  await app.close();
});
