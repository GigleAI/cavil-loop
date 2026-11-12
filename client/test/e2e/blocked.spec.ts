// GigleAI/cavil-loop#434: "等前置…" in the detail panel — search the item's repository by number or
// title, pick what it waits for, register it the way the daemon reads it and put it on the waiting
// label. The real window (built with --test-bridge) and back end, the fake GitHub on a small
// repository written here. What GitHub ends up holding is read from the fake's own state; the order
// of the writes from its request log. Screenshots land in test-results/screens/.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { findCopies, gqlContent } from '../fake-github/writes';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const REPO = 'acme/demo';
const T0 = '2026-11-10T00:00:00Z';
const issue = (number: number, title: string, labels: string[], extra: Record<string, unknown> = {}) => ({
  number,
  node_id: `I_demo_${number}`,
  title,
  state: 'open',
  html_url: `https://github.com/acme/demo/issues/${number}`,
  updated_at: T0,
  labels: labels.map((name) => ({ name, color: 'ededed' })),
  assignees: [],
  milestone: null,
  user: { login: 'user-1' },
  ...extra,
});
const pr = (number: number, title: string) => issue(number, title, [], { node_id: `PR_demo_${number}`, html_url: `https://github.com/acme/demo/pull/${number}`, pull_request: { html_url: `https://github.com/acme/demo/pull/${number}`, merged_at: null } });

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-blocked-'));
  env = {
    fake: await startFakeGitHub({
      projects: new Map(),
      repos: new Map([
        [
          REPO,
          [
            issue(10, '目标：等别人做完再开工', ['pending/human']),
            issue(11, '前置 issue：先把接口定下来', []),
            pr(12, 'feat: 前置 PR 依赖图'),
            issue(13, '复审中的 issue', ['pending/review']),
            issue(14, '已经在等前置的 issue', ['pending/blocked']),
            issue(15, '已经做完的旧 issue', [], { state: 'closed' }),
            pr(16, 'fix: 另一个前置 PR'),
            issue(17, '另一个客户端登记的前置', []),
          ],
        ],
      ]),
    }),
    userData: join(dir, 'userData'),
    cred: join(dir, 'cred'),
    opened: join(dir, 'opened.txt'),
    requests: join(dir, 'requests.txt'),
  };
  const w = env.fake.state.w;
  w.repoLabels.set(REPO, ['pending/human', 'pending/agent', 'pending/blocked', 'pending/review', 'doing/agent', 'autopilot'].map((name) => ({ name, color: 'ededed' })));
  // #14 waits already: the waiting label went on (event 1) and a maintainer registered PR #12 after it
  w.labelEvents.set(`${REPO}#14`, [{ id: 1, event: 'labeled', label: { name: 'pending/blocked' }, actor: { login: 'user-1' }, created_at: '2026-11-10T01:00:00Z' }]);
  w.comments.set(`${REPO}#14`, [
    { id: 'IC_14_1', url: 'https://github.com/acme/demo/issues/14#issuecomment-1', createdAt: '2026-11-10T01:00:05Z', bodyHTML: '<p>waits</p>', author: { login: 'user-1' }, body: '在等 PR #12\n<!-- agent-blocked-by: #12 resume=pending/agent -->', authorAssociation: 'OWNER' },
  ]);
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

async function ready(page: Page) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(REPO);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect(page.locator(`[data-testid="card"][data-key="${REPO}#10"]`)).toBeVisible({ timeout: 15_000 });
}

async function openItem(page: Page, n: number) {
  await page.locator(`[data-testid="card"][data-key="${REPO}#${n}"]`).first().click();
  const detail = page.getByTestId('detail');
  await expect(detail).toHaveAttribute('data-key', `${REPO}#${n}`);
  await expect(detail.getByTestId('quick-actions')).toBeVisible({ timeout: 15_000 });
  return detail;
}

const labelsOf = (n: number) => gqlContent(findCopies(env.fake.state as any, REPO, n)!).labels.nodes.map((l: any) => l.name).sort();
const commentsOf = (n: number) => (env.fake.state.w.comments.get(`${REPO}#${n}`) ?? []).map((c) => c.body ?? '');
const nativeOf = (n: number) => (env.fake.state.w.relations.get(`${REPO}#${n}`)?.blockedBy ?? []).map((x) => x.number);
/** the client's writes to this item, in order, as "METHOD what" */
const writesTo = (n: number) =>
  env.fake
    .writes()
    .filter((e) => e.path.includes(`/repos/${REPO}/issues/${n}/`))
    .map((e) => `${e.method} ${e.path.replace(`/api/repos/${REPO}/issues/${n}/`, '')}${e.method === 'POST' && e.path.endsWith('/labels') ? ' ' + JSON.stringify((e.body as any)?.labels) : ''}`);

test('GitHub#434: search by title and number, pick an issue and a PR; native relation + registration, then the waiting label replaces 等人处理', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  const detail = await openItem(page, 10);
  const btn = detail.getByTestId('blocked-open');
  await expect(btn).toBeEnabled();
  await expect(btn).toContainText('等前置');
  await btn.click();
  const dialog = page.getByTestId('blocked-dialog');
  await expect(dialog.getByTestId('blocked-current')).toContainText('还没有');
  // by title: GitHub's search, open items only (#15 is closed), never the item itself
  await dialog.getByTestId('blocked-search').fill('前置');
  const results = dialog.getByTestId('blocked-result');
  await expect(results.filter({ hasText: '#11' })).toHaveCount(1);
  await expect(results.filter({ hasText: 'PR #12' })).toHaveCount(1);
  await expect(results.filter({ hasText: '#15' })).toHaveCount(0);
  await results.filter({ hasText: '#11' }).click();
  // by number, then Enter
  await dialog.getByTestId('blocked-search').fill('12');
  // the number's own answer: exactly that one item (the title search's rows are gone)
  await expect(results).toHaveCount(1);
  await expect(results).toContainText('PR #12');
  await dialog.getByTestId('blocked-search').press('Enter');
  await expect(dialog.getByTestId('blocked-pick')).toHaveCount(2);
  const summary = dialog.getByTestId('blocked-summary');
  await expect(summary).toContainText('把 #11 设成本条的「Blocked by」');
  await expect(summary).toContainText('列出 #12');
  await expect(summary).toContainText('加上标签「pending/blocked」');
  await expect(summary).toContainText('去掉「pending/human」');
  await page.screenshot({ path: join(screens, 'blocked-01-picked.png') });
  expect(writesTo(10)).toEqual([]);
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('blocked-dialog')).toHaveCount(0);
  await expect.poll(() => labelsOf(10), { timeout: 15_000 }).toEqual(['pending/blocked']);
  expect(nativeOf(10)).toEqual([11]);
  const reg = commentsOf(10).filter((b) => b.includes('<!-- agent-blocked-by:'));
  expect(reg).toHaveLength(1);
  expect(reg[0]).toContain('<!-- agent-blocked-by: #12 resume=pending/agent -->');
  // already waiting for a person: no pause step; relation, registration, waiting label, then 等人处理 off
  expect(writesTo(10)).toEqual(['POST dependencies/blocked_by', 'POST comments', 'POST labels ["pending/blocked"]', `DELETE labels/${encodeURIComponent('pending/human')}`]);
  await page.screenshot({ path: join(screens, 'blocked-02-done.png') });
});

test('GitHub#434: an item in another flow cannot enter (button greyed, why named, nothing sent); a person-waiting one can; an empty setting hides the button', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  let detail = await openItem(page, 13);
  const btn = detail.getByTestId('blocked-open');
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveAttribute('title', /挂着「pending\/review」/);
  // the key does nothing either
  await page.keyboard.press('Control+Shift+B');
  await expect(page.getByTestId('blocked-dialog')).toHaveCount(0);
  expect(env.fake.writes()).toEqual([]);
  // the positive side: an item waiting for a person opens the dialog, by the key too
  await page.keyboard.press('Escape');
  detail = await openItem(page, 10);
  await expect(detail.getByTestId('blocked-open')).toBeEnabled();
  await page.keyboard.press('Control+Shift+B');
  await expect(page.getByTestId('blocked-dialog')).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
  // Settings: an empty waiting label = no button
  await page.getByTestId('open-settings').click();
  await page.getByTestId('hand-back-blocked').fill('');
  await page.getByTestId('hand-back-blocked').blur();
  await page.getByTestId('back').click();
  detail = await openItem(page, 10);
  await expect(detail.getByTestId('blocked-open')).toHaveCount(0);
  expect(env.fake.writes()).toEqual([]);
});

test('GitHub#434: a registration made by somebody else while the dialog is open — nothing written, the dialog shows it; confirmed again, all of them are in the new registration', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  const detail = await openItem(page, 14);
  await detail.getByTestId('blocked-open').click();
  const dialog = page.getByTestId('blocked-dialog');
  await expect(dialog.getByTestId('blocked-current-ref')).toHaveCount(1);
  await expect(dialog.getByTestId('blocked-current')).toContainText('PR #12');
  await dialog.getByTestId('blocked-search').fill('16');
  await expect(dialog.getByTestId('blocked-result')).toHaveCount(1);
  await dialog.getByTestId('blocked-search').press('Enter');
  // another maintainer registers #17 (with #12) meanwhile
  env.fake.actAs('user-9', 'POST', `/repos/${REPO}/issues/14/comments`, { body: '<!-- agent-blocked-by: #12 #17 resume=pending/agent -->' });
  await page.getByTestId('confirm-ok').click();
  await expect(dialog.getByTestId('blocked-warn')).toContainText('什么都没写');
  await expect(dialog.getByTestId('blocked-current')).toContainText('#17');
  expect(writesTo(14)).toEqual([]);
  await page.screenshot({ path: join(screens, 'blocked-03-changed.png') });
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('blocked-dialog')).toHaveCount(0);
  await expect.poll(() => writesTo(14), { timeout: 15_000 }).toEqual([
    'POST labels ["pending/human"]',
    'POST comments',
    `DELETE labels/${encodeURIComponent('pending/human')}`,
  ]);
  const last = commentsOf(14).filter((b) => b.includes('<!-- agent-blocked-by:')).pop()!;
  expect(last).toContain('<!-- agent-blocked-by: #12 #17 #16 resume=pending/agent -->');
  expect(labelsOf(14)).toEqual(['pending/blocked']);
});

for (const variant of ['repause', 'closed'] as const) {
  test(`GitHub#434: another registration crosses this one after it was posted — ${variant === 'repause' ? 'only that changed: 等人处理 is put back, the item stays paused' : 'the item was closed too: nothing is put back, the pause is reported unconfirmed'}`, async () => {
    const { page } = await launchApp(env);
    await ready(page);
    const detail = await openItem(page, 14);
    await detail.getByTestId('blocked-open').click();
    const dialog = page.getByTestId('blocked-dialog');
    await dialog.getByTestId('blocked-search').fill('16');
    await expect(dialog.getByTestId('blocked-result')).toHaveCount(1);
    await dialog.getByTestId('blocked-search').press('Enter');
    // hold the answer of this client's registration: it is on GitHub, the client has not heard yet
    const release = env.fake.holdWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/14/comments`);
    await page.getByTestId('confirm-ok').click();
    await expect.poll(() => commentsOf(14).length, { timeout: 15_000 }).toBe(2);
    // the other client: its own registration, then it finishes and takes 等人处理 off
    env.fake.actAs('user-9', 'POST', `/repos/${REPO}/issues/14/comments`, { body: '<!-- agent-blocked-by: #12 #17 resume=pending/agent -->' });
    env.fake.actAs('user-9', 'DELETE', `/repos/${REPO}/issues/14/labels/${encodeURIComponent('pending/human')}`);
    if (variant === 'closed') env.fake.actAs('user-9', 'PATCH', `/repos/${REPO}/issues/14`, { state: 'closed', state_reason: 'completed' });
    release();
    // the notice of the record (it may sit behind the panel's notices button): its words are what is asserted
    const notice = page.getByTestId('op-notice-text').filter({ hasText: '停在' }).first();
    await expect(notice).toHaveCount(1, { timeout: 15_000 });
    if (variant === 'repause') {
      await expect(notice).toContainText('已补挂「pending/human」');
      await expect(notice).toContainText('已暂停');
      await expect.poll(() => labelsOf(14)).toEqual(['pending/blocked', 'pending/human']);
      expect(writesTo(14)).toEqual(['POST labels ["pending/human"]', 'POST comments', 'POST labels ["pending/human"]']);
    } else {
      await expect(notice).toContainText('暂停状态未确认');
      await expect(notice).toContainText('没有补挂');
      expect(writesTo(14)).toEqual(['POST labels ["pending/human"]', 'POST comments']);
    }
    await page.screenshot({ path: join(screens, `blocked-04-crossed-${variant}.png`) });
  });
}

test('GitHub#434: the answer of the registration is lost — found again by its hidden id, the remaining steps go on behind the permit', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  const lost = env.fake.dropAnswerWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/10/comments`);
  const detail = await openItem(page, 10);
  await detail.getByTestId('blocked-open').click();
  const dialog = page.getByTestId('blocked-dialog');
  await dialog.getByTestId('blocked-search').fill('12');
  await expect(dialog.getByTestId('blocked-result')).toHaveCount(1);
  await dialog.getByTestId('blocked-search').press('Enter');
  await page.getByTestId('confirm-ok').click();
  await expect.poll(() => labelsOf(10), { timeout: 15_000 }).toEqual(['pending/blocked']);
  expect(lost.caught()).toBe(1);
  expect(commentsOf(10).filter((b) => b.includes('<!-- agent-blocked-by:'))).toHaveLength(1);
});
