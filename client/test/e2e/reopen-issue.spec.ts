// GigleAI/cavil-loop#753: a closed issue can be reopened from its detail. The real window (built with
// --test-bridge), the real back end behind the loopback bridge, the local fake GitHub. The button sits where
// 「关闭 issue…」 does and the two never show together; a PR never offers it. The dialog's comment goes out
// first, the reopen only after it; labels stay; the detail stays open and turns back to 「关闭 issue…」.

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
/** recorded issues: OPEN stays open (the sign-in waits for it), SHUT is closed here with a label on it */
const OPEN = 139;
const SHUT = 142;

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  set(OPEN, 'open', []);
  set(SHUT, 'closed', ['Done']);
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(closeEngine);

/** the item's state and labels on GitHub (the fake: every copy it holds) */
function set(n: number, state: 'open' | 'closed', labels: string[]) {
  const c = findCopies(env.fake.state, REPO, n)!;
  const rest = labels.map((name) => ({ name, color: '586069' }));
  for (const r of c.rest) Object.assign(r, { state, state_reason: state === 'closed' ? 'completed' : null, labels: rest });
  for (const g of c.gql) Object.assign(g, { state: state === 'open' ? 'OPEN' : 'CLOSED', stateReason: state === 'closed' ? 'COMPLETED' : null, labels: { nodes: rest.map((l) => ({ ...l })) } });
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
  await expect(row(page, OPEN)).toBeVisible({ timeout: 20_000 });
}

const row = (page: Page, n: number) => page.locator(`[data-testid="row"][data-key="${K(n)}"] [data-testid="title-cell"]`).first();
const detail = (page: Page) => page.getByTestId('detail');
/** the writes to the item, in the order GitHub got them */
const writesTo = (n: number) =>
  env.fake.log
    .filter((l) => (l.method === 'PATCH' && l.path.endsWith(`/repos/${REPO}/issues/${n}`)) || (l.method === 'POST' && l.path.endsWith(`/repos/${REPO}/issues/${n}/comments`)))
    .map((l) => [l.method, l.status, l.body]);

test('GitHub#753: a closed issue offers 「重新打开 issue…」 where 「关闭 issue…」 is; the comment goes first, then the reopen; labels and the detail stay', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);

  // an open issue: only the close button
  await row(page, OPEN).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(OPEN));
  await expect(detail(page).getByTestId('close-issue')).toBeEnabled({ timeout: 15_000 });
  await expect(detail(page).getByTestId('reopen-issue')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // the closed one: the search lists it, its detail offers only the reopen
  await page.getByTestId('search').fill('is:closed');
  await row(page, SHUT).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(SHUT));
  await expect(detail(page).getByTestId('reopen-issue')).toBeEnabled({ timeout: 15_000 });
  await expect(detail(page).getByTestId('close-issue')).toHaveCount(0);
  await expect(detail(page).getByTestId('reopen-issue')).toHaveText('重新打开 issue…');
  // ⌘⇧X stays the close key: on a closed issue it opens nothing
  await detail(page).getByTestId('reply').locator('textarea').first().click();
  await page.keyboard.press('Control+Shift+X');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await shot(page, '753-01-closed');

  // cancel sends nothing
  await detail(page).getByTestId('reopen-issue').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText(`重新打开 issue #${SHUT}？`);
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  expect(writesTo(SHUT)).toEqual([]);

  await detail(page).getByTestId('reopen-issue').click();
  await expect(page.getByTestId('confirm-ok')).toHaveText(/确认重新打开/);
  await page.getByTestId('reopen-comment').fill('还没修好，接着做');
  await shot(page, '753-02-dialog');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

  // GitHub got the comment first, then the reopen
  await expect
    .poll(() => writesTo(SHUT), { timeout: 15_000 })
    .toEqual([
      ['POST', 201, { body: '还没修好，接着做' }],
      ['PATCH', 200, { state: 'open' }],
    ]);
  // the detail stays (not put away like a close), turns back to the close button; the label is still there
  await expect(detail(page).getByTestId('close-issue')).toBeVisible({ timeout: 15_000 });
  await expect(detail(page)).toHaveAttribute('data-key', K(SHUT));
  await expect(detail(page).getByTestId('reopen-issue')).toHaveCount(0);
  await expect(detail(page).locator('[data-testid="detail-label"]', { hasText: 'Done' })).toHaveCount(1);
  await shot(page, '753-03-reopened');
  expect(findCopies(env.fake.state, REPO, SHUT)!.rest.every((r: any) => r.state === 'open' && r.labels.some((l: any) => l.name === 'Done'))).toBe(true);
  await app.close();
});

test('GitHub#753: a PR never offers 「重新打开 issue…」, not even closed without a merge', async () => {
  // a recorded PR, made closed and not merged in every copy
  const node = [...env.fake.state.projects.values()].flat().flatMap((p: any) => p.items.nodes).find((x: any) => x.content?.__typename === 'PullRequest')!;
  const n = node.content.number as number;
  const c = findCopies(env.fake.state, REPO, n)!;
  for (const g of c.gql) Object.assign(g, { state: 'CLOSED', merged: false });
  for (const r of c.rest) Object.assign(r, { state: 'closed', pull_request: { ...r.pull_request, merged_at: null } });
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  await page.getByTestId('search').fill('is:pr is:closed');
  await row(page, n).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(n));
  // the PR's detail has been read (its PR bar is there), and still no reopen, nor a close of an issue
  await expect(detail(page).getByTestId('pr-box')).toBeVisible({ timeout: 15_000 });
  await expect(detail(page).getByTestId('hand-back')).toBeVisible();
  await expect(detail(page).getByTestId('reopen-issue')).toHaveCount(0);
  await expect(detail(page).getByTestId('close-issue')).toHaveCount(0);
  await app.close();
});
