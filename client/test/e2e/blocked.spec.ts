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
import { restIdOf } from '../fake-github/blocked';
import { findCopies, gqlContent } from '../fake-github/writes';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const REPO = 'acme/demo';
const T0 = '2026-11-10T00:00:00Z';
// `id`: the REST database id, the same one the fake's single-item answer carries (a real list always has it)
const issue = (number: number, title: string, labels: string[], extra: Record<string, unknown> = {}) => ({
  id: restIdOf(REPO, number),
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

test('PR #441 review round 1: the registration is edited in place (same comment, one more prerequisite) between two steps — the client stops and loses nothing; done again, the edit is kept', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  const detail = await openItem(page, 14);
  await detail.getByTestId('blocked-open').click();
  const dialog = page.getByTestId('blocked-dialog');
  await dialog.getByTestId('blocked-search').fill('16');
  await expect(dialog.getByTestId('blocked-result')).toHaveCount(1);
  await dialog.getByTestId('blocked-search').press('Enter');
  // hold the answer of the pause: GitHub has it, the client has not heard yet; meanwhile a maintainer edits the registration
  const release = env.fake.holdWhen((e) => e.method === 'POST' && e.path === `/api/repos/${REPO}/issues/14/labels`);
  await page.getByTestId('confirm-ok').click();
  await expect.poll(() => labelsOf(14), { timeout: 15_000 }).toEqual(['pending/blocked', 'pending/human']);
  env.fake.state.w.comments.get(`${REPO}#14`)![0].body = '在等 PR #12 和 #17\n<!-- agent-blocked-by: #12 #17 resume=pending/agent -->';
  release();
  const notice = page.getByTestId('op-notice-text').filter({ hasText: '停在' }).first();
  await expect(notice).toHaveCount(1, { timeout: 15_000 });
  await expect(notice).toContainText('被改动');
  await expect(notice).toContainText('已暂停');
  // nothing after the pause went out: no registration that would have dropped #17, the pause stays
  expect(writesTo(14)).toEqual(['POST labels ["pending/human"]']);
  expect(commentsOf(14).filter((b) => b.includes('<!-- agent-blocked-by:'))).toHaveLength(1);
  expect(labelsOf(14)).toEqual(['pending/blocked', 'pending/human']);
  // done again from the dialog: it shows the edited registration, and the new one keeps #17
  await expect(detail.getByTestId('blocked-open')).toBeEnabled({ timeout: 15_000 });
  await detail.getByTestId('blocked-open').click();
  await expect(dialog.getByTestId('blocked-current')).toContainText('#17');
  await dialog.getByTestId('blocked-search').fill('16');
  await expect(dialog.getByTestId('blocked-result')).toHaveCount(1);
  await dialog.getByTestId('blocked-search').press('Enter');
  await page.getByTestId('confirm-ok').click();
  await expect.poll(() => labelsOf(14), { timeout: 15_000 }).toEqual(['pending/blocked']);
  expect(commentsOf(14).filter((b) => b.includes('<!-- agent-blocked-by:')).pop()).toContain('<!-- agent-blocked-by: #12 #17 #16 resume=pending/agent -->');
});

test('GitHub#523: "登记前置" pressed while the item just picked is still being read — it waits for that read and registers the item too; when that read finds the item closed nothing is registered and the reason is on screen', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  const detail = await openItem(page, 10);
  await detail.getByTestId('blocked-open').click();
  const dialog = page.getByTestId('blocked-dialog');
  await dialog.getByTestId('blocked-search').fill('12');
  await expect(dialog.getByTestId('blocked-result')).toHaveCount(1);
  await dialog.getByTestId('blocked-search').press('Enter');
  await expect(dialog.getByTestId('blocked-pick')).toHaveCount(1);
  // the board's copy of #16 has no GitHub id, so picking it reads #16 first: hold that read, confirm in the meantime
  const read16 = (e: { method: string; path: string }) => e.method === 'GET' && e.path === `/api/repos/${REPO}/issues/16`;
  const release = env.fake.holdWhen(read16);
  await dialog.getByTestId('blocked-search').fill('16');
  await expect(dialog.getByTestId('blocked-result')).toHaveCount(1);
  await dialog.getByTestId('blocked-search').press('Enter');
  await expect.poll(() => env.fake.log.filter(read16).length).toBeGreaterThan(0);
  await expect(dialog.getByTestId('blocked-pick')).toHaveCount(1);
  await page.getByTestId('confirm-ok').click();
  await page.waitForTimeout(300);
  // nothing goes out while #16 is still on its way into the list
  expect(writesTo(10)).toEqual([]);
  release();
  await expect.poll(() => labelsOf(10), { timeout: 15_000 }).toEqual(['pending/blocked']);
  const reg = commentsOf(10).filter((b) => b.includes('<!-- agent-blocked-by:'));
  expect(reg).toHaveLength(1);
  expect(reg[0]).toMatch(/<!-- agent-blocked-by: #12 #16 resume=/);

  // the same on #11, but #16 has just been closed on GitHub while the board still shows it open (a read that merely fails is covered by the
  // list of open items read a moment ago, so it is not a way to make this pick fail): the dialog stays open with the
  // reason, and nothing is registered
  await expect(dialog).toHaveCount(0);
  await page.getByTestId('detail-close').click();
  const detail11 = await openItem(page, 11);
  await detail11.getByTestId('blocked-open').click();
  await dialog.getByTestId('blocked-search').fill('12');
  await expect(dialog.getByTestId('blocked-result')).toHaveCount(1);
  await dialog.getByTestId('blocked-search').press('Enter');
  await expect(dialog.getByTestId('blocked-pick')).toHaveCount(1);
  const release2 = env.fake.holdWhen(read16);
  // (the fake works out an answer when the request arrives and only holds it back, so close it first; the board
  // still shows it open)
  for (const r of env.fake.state.repos.get(REPO)!) if (r.number === 16) r.state = 'closed';
  await dialog.getByTestId('blocked-search').fill('16');
  await expect(dialog.getByTestId('blocked-result')).toHaveCount(1);
  await dialog.getByTestId('blocked-search').press('Enter');
  await page.getByTestId('confirm-ok').click();
  release2();
  await expect(dialog.getByTestId('blocked-search-err')).toContainText('不是开着的', { timeout: 15_000 });
  await expect(page.getByTestId('confirm-ok')).toBeEnabled();
  await page.waitForTimeout(300);
  expect(writesTo(11)).toEqual([]);
  await expect(dialog.getByTestId('blocked-pick')).toHaveCount(1);
});

test('PR #441 review round 1: only taking the pause off failed — after a restart the dialog finishes it with nothing new picked; with nothing left to do it cannot be confirmed', async () => {
  let app = await launchApp(env);
  let page = app.page;
  await ready(page);
  env.fake.state.w.failUnlabel = 'pending/human';
  let detail = await openItem(page, 10);
  await detail.getByTestId('blocked-open').click();
  let dialog = page.getByTestId('blocked-dialog');
  await dialog.getByTestId('blocked-search').fill('12');
  await expect(dialog.getByTestId('blocked-result')).toHaveCount(1);
  await dialog.getByTestId('blocked-search').press('Enter');
  await page.getByTestId('confirm-ok').click();
  // the registration and the waiting label went on; taking 等人处理 off was refused
  await expect.poll(() => labelsOf(10), { timeout: 15_000 }).toEqual(['pending/blocked', 'pending/human']);
  await expect(page.getByTestId('op-notice-text').filter({ hasText: '没有成功' }).first()).toHaveCount(1, { timeout: 15_000 });
  const before = writesTo(10);
  expect(before).toEqual(['POST comments', 'POST labels ["pending/blocked"]', `DELETE labels/${encodeURIComponent('pending/human')}`]);
  env.fake.state.w.failUnlabel = null;
  // restart: nothing goes on by itself
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await expect(page.locator(`[data-testid="card"][data-key="${REPO}#10"]`)).toBeVisible({ timeout: 15_000 });
  expect(writesTo(10)).toEqual(before);
  detail = await openItem(page, 10);
  await detail.getByTestId('blocked-open').click();
  dialog = page.getByTestId('blocked-dialog');
  await expect(dialog.getByTestId('blocked-paused')).toBeVisible();
  await expect(dialog.getByTestId('blocked-current')).toContainText('PR #12');
  await expect(dialog.getByTestId('blocked-pick')).toHaveCount(0);
  await expect(dialog.getByTestId('blocked-summary')).toContainText('去掉「pending/human」');
  await expect(page.getByTestId('confirm-ok')).toBeEnabled();
  await page.screenshot({ path: join(screens, 'blocked-05-finish-paused.png') });
  await page.getByTestId('confirm-ok').click();
  await expect.poll(() => labelsOf(10), { timeout: 15_000 }).toEqual(['pending/blocked']);
  // only the missing step went out
  expect(writesTo(10)).toEqual([...before, `DELETE labels/${encodeURIComponent('pending/human')}`]);
  // the control: already waiting with a full registration and nothing new — confirm stays off, nothing sent
  await page.keyboard.press('Escape');
  detail = await openItem(page, 14);
  await detail.getByTestId('blocked-open').click();
  await expect(dialog.getByTestId('blocked-current')).toContainText('PR #12');
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  expect(writesTo(14)).toEqual([]);
});

// ---- GitHub#448: a number prefix, a number in another repository, an address ----

const BIG = 'acme/big';
/** acme/big is not on the board: every row comes from GitHub. #901–#1000 fill the first page (updated last), #444 / #447 are on the second */
function bigRepo() {
  const at = (n: number) => `2026-11-10T0${n > 900 ? 5 : 1}:00:00Z`;
  const big = (n: number, state = 'open') => ({ ...issue(n, `big ${n}`, [], { state, updated_at: at(n) }), id: restIdOf(BIG, n), node_id: `I_big_${n}`, html_url: `https://github.com/acme/big/issues/${n}` });
  return [...Array.from({ length: 100 }, (_, i) => big(901 + i)), big(444), big(447), big(4, 'closed'), big(45, 'closed')];
}
const refsShown = (page: Page) => page.getByTestId('blocked-dialog').getByTestId('blocked-result').evaluateAll((els) => els.map((e) => e.getAttribute('data-ref')));
const bigListReads = () => env.fake.log.filter((e) => e.method === 'GET' && e.path.startsWith(`/api/repos/${BIG}/issues?`)).length;

test('GitHub#448: owner/repo#4 lists the open items whose number starts with 4 — the second page too; the list is reused a minute; an address finds its item', async () => {
  env.fake.state.repos.set(BIG, bigRepo());
  const { page } = await launchApp(env);
  await ready(page);
  const detail = await openItem(page, 10);
  await detail.getByTestId('blocked-open').click();
  const dialog = page.getByTestId('blocked-dialog');
  const box = dialog.getByTestId('blocked-search');
  // #4 itself is closed; #447 / #444 are only on the second page of the open list
  await box.fill('acme/big#4');
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual([`${BIG}#447`, `${BIG}#444`]);
  await expect(dialog.getByTestId('blocked-search-err')).toHaveCount(0);
  // the reachability side of "reused": the list really was read, both pages
  expect(bigListReads()).toBe(2);
  // another prefix within the minute: the same complete list, not read again (the number itself is)
  await box.fill('ACME/big#44');
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual([`${BIG}#447`, `${BIG}#444`]);
  await box.fill('acme/big#9');
  // 20 rows at most, the largest numbers starting with 9 (#9 itself does not exist; #1000 does not start with 9)
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual(Array.from({ length: 20 }, (_, i) => `${BIG}#${999 - i}`));
  expect(bigListReads()).toBe(2);
  // an address: that one item, no prefix (#4440… would not be listed either way)
  await box.fill('https://github.com/acme/big/issues/444');
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual([`${BIG}#444`]);
  await box.fill(`${env.fake.web}/acme/big/pull/447#issuecomment-1`);
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual([`${BIG}#447`]);
  // a closed one by address: nothing listed, no error
  await box.fill('github.com/acme/big/issues/4');
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual([]);
  await expect(dialog.getByTestId('blocked-search-err')).toHaveCount(0);
  // the exact number, then Enter: that item is picked
  await box.fill('acme/big#447');
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual([`${BIG}#447`]);
  await box.press('Enter');
  await expect(dialog.getByTestId('blocked-pick')).toHaveAttribute('data-ref', `${BIG}#447`);
  await page.screenshot({ path: join(screens, 'blocked-06-prefix.png') });
  expect(env.fake.writes()).toEqual([]);
});

test('GitHub#448: the second page fails — the exact item is still listed, next to "没读全", never an empty "no results"; the failure is not kept, the next search reads again', async () => {
  env.fake.state.repos.set(BIG, bigRepo());
  const { page } = await launchApp(env);
  await ready(page);
  const detail = await openItem(page, 10);
  await detail.getByTestId('blocked-open').click();
  const dialog = page.getByTestId('blocked-dialog');
  const box = dialog.getByTestId('blocked-search');
  env.fake.state.failRepoPage.set(BIG, 2);
  await box.fill('acme/big#44');
  await expect(dialog.getByTestId('blocked-search-err')).toContainText('开着的条目没读全', { timeout: 15_000 });
  // #44 itself does not exist (404 is "none"), so nothing to list: the reason is what shows
  expect(await refsShown(page)).toEqual([]);
  await box.fill('acme/big#447');
  await expect(dialog.getByTestId('blocked-search-err')).toContainText('开着的条目没读全', { timeout: 15_000 });
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual([`${BIG}#447`]);
  const failed = bigListReads();
  expect(failed).toBeGreaterThanOrEqual(4);
  env.fake.state.failRepoPage.delete(BIG);
  await box.fill('acme/big#4');
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual([`${BIG}#447`, `${BIG}#444`]);
  await expect(dialog.getByTestId('blocked-search-err')).toHaveCount(0);
  expect(bigListReads()).toBe(failed + 2);
  await page.screenshot({ path: join(screens, 'blocked-07-prefix-failed.png') });
});

test('GitHub#448: a bare prefix lists the board copies at once; a board copy clicked while GitHub has not answered is that item, not another one with the same prefix', async () => {
  const repo = env.fake.state.repos.get(REPO)!;
  repo.push(issue(110, '一百一十号', []), issue(111, '一百一十一号', []), issue(112, '已关闭的一百一十二号', [], { state: 'closed' }));
  const { page } = await launchApp(env);
  await ready(page);
  const detail = await openItem(page, 10);
  await detail.getByTestId('blocked-open').click();
  const dialog = page.getByTestId('blocked-dialog');
  const release = env.fake.hold(`/repos/${REPO}/issues?state=open`);
  try {
    // the board's rows before GitHub answers: #11 itself first, then #111, #110 (the closed #112 is not one)
    await dialog.getByTestId('blocked-search').fill('#11');
    await expect.poll(() => refsShown(page)).toEqual([`${REPO}#11`, `${REPO}#111`, `${REPO}#110`]);
    await dialog.getByTestId('blocked-result').filter({ hasText: '#110' }).click();
  } finally {
    release();
  }
  await expect(dialog.getByTestId('blocked-pick')).toHaveCount(1, { timeout: 15_000 });
  await expect(dialog.getByTestId('blocked-pick')).toHaveAttribute('data-ref', `${REPO}#110`);
  await expect(dialog.getByTestId('blocked-search-err')).toHaveCount(0);
});

test('PR #452 review round 1: the board still holds an item as open but GitHub closed it — once the number search has answered it is gone; a failed list keeps the board\'s rows', async () => {
  const { page } = await launchApp(env);
  await ready(page);
  const detail = await openItem(page, 10);
  await detail.getByTestId('blocked-open').click();
  const dialog = page.getByTestId('blocked-dialog');
  const box = dialog.getByTestId('blocked-search');
  // closed on GitHub after the board read them; the board is not synced again
  for (const n of [11, 17]) env.fake.state.repos.get(REPO)!.find((i) => i.number === n)!.state = 'closed';
  const reads = (path: string) => env.fake.log.filter((e) => e.method === 'GET' && e.path === path).length;
  const listReads = () => env.fake.log.filter((e) => e.method === 'GET' && e.path.startsWith(`/api/repos/${REPO}/issues?state=open`)).length;
  // ① the open list cannot be read: it settles nothing — the board's rows (the stale #11 / #17 among them) stay, next to the reason
  env.fake.state.failRepoPage.set(REPO, 1);
  const failedBefore = listReads();
  await box.fill('1');
  await expect(dialog.getByTestId('blocked-search-err')).toContainText('开着的条目没读全', { timeout: 15_000 });
  expect(listReads()).toBeGreaterThan(failedBefore);
  expect(await refsShown(page)).toEqual([17, 16, 14, 13, 12, 11].map((n) => `${REPO}#${n}`));
  env.fake.state.failRepoPage.delete(REPO);
  // ② the exact number, read now: closed → gone, though the board still lists it as open (the open list is read
  // again too — the failure was not kept)
  const before11 = reads(`/api/repos/${REPO}/issues/11`);
  const okBefore = listReads();
  await box.fill('#11');
  await expect.poll(() => reads(`/api/repos/${REPO}/issues/11`), { timeout: 15_000 }).toBeGreaterThan(before11);
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual([]);
  await expect(dialog.getByText('正在搜 GitHub…')).toHaveCount(0);
  await expect(dialog.getByTestId('blocked-search-err')).toHaveCount(0);
  const okAfter = listReads();
  expect(okAfter).toBeGreaterThan(okBefore);
  // ③ a prefix: the open list read whole in ② (reused within the minute) settles #17 too; the open ones stay
  await box.fill('1');
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual([16, 14, 13, 12].map((n) => `${REPO}#${n}`));
  expect(listReads()).toBe(okAfter);
  await expect(dialog.getByTestId('blocked-search-err')).toHaveCount(0);
});

test('PR #452 review round 2: the list is kept a minute, then the exact number is deleted — its 404 wins over the kept list (and the board); the other prefix rows stay', async () => {
  env.fake.state.repos.get(REPO)!.push(issue(110, '一百一十号', []));
  const { page } = await launchApp(env);
  await ready(page);
  const detail = await openItem(page, 10);
  await detail.getByTestId('blocked-open').click();
  const dialog = page.getByTestId('blocked-dialog');
  const box = dialog.getByTestId('blocked-search');
  const reads = (path: string) => env.fake.log.filter((e) => e.method === 'GET' && e.path === path).length;
  const listReads = () => env.fake.log.filter((e) => e.method === 'GET' && e.path.startsWith(`/api/repos/${REPO}/issues?state=open`)).length;
  const listBefore = listReads();
  await box.fill('#11');
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual([`${REPO}#11`, `${REPO}#110`]);
  await expect.poll(() => listReads(), { timeout: 15_000 }).toBeGreaterThan(listBefore);
  await expect(dialog.getByText('正在搜 GitHub…')).toHaveCount(0);
  const listKept = listReads();
  // #11 is deleted on GitHub; the board and the kept list still hold it open
  const repo = env.fake.state.repos.get(REPO)!;
  repo.splice(
    repo.findIndex((i) => i.number === 11),
    1,
  );
  const exactBefore = reads(`/api/repos/${REPO}/issues/11`);
  await box.fill('');
  await box.fill('#11');
  await expect.poll(() => reads(`/api/repos/${REPO}/issues/11`), { timeout: 15_000 }).toBeGreaterThan(exactBefore);
  await expect.poll(() => refsShown(page), { timeout: 15_000 }).toEqual([`${REPO}#110`]);
  await expect(dialog.getByText('正在搜 GitHub…')).toHaveCount(0);
  await expect(dialog.getByTestId('blocked-search-err')).toHaveCount(0);
  // the kept list really was what answered (no new list read)
  expect(listReads()).toBe(listKept);
});
