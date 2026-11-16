// GitHub#559: the new-issue dialog when the repository lacks the labels 交给 agent / 托管 need. The real window
// (built with --test-bridge), the real back end behind the loopback bridge, the local fake GitHub — every
// assertion on what was sent is on what GitHub really received.
//   1. the account may write: one button creates exactly the missing labels (colour, description), the
//      notice names the repository, the buttons come alive, no issue is created
//   2. the account may not: no create request at all; the list, the labels page, the copied list; once someone
//      else created them, 「重新读取」 lets the buttons go
//   3. the permission cannot be read and GitHub refuses: the button first, then the guide; 「重试」 sends again
//   4. a press in repository A, then the dialog switched to B while A's answer is held: B shows only its own
//      state, nothing goes to B, the notice names A; back on A the buttons work
//   5. no answer: 「再查一次」 reads only — the label landed later is found, nothing is sent again

import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const screens = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-results', 'screens');
mkdirSync(screens, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const A = 'GigleAI/cavil-loop';
const B = 'GigleAI/second-repo';
const AK = A.toLowerCase();
const BK = B.toLowerCase();

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  // a second repository, so the dialog can switch
  env.fake.state.repos.set(BK, []);
  env.fake.state.w.repoLabels.set(AK, [{ name: 'bug', color: 'd73a4a' }]);
  env.fake.state.w.repoLabels.set(BK, [{ name: 'bug', color: 'd73a4a' }]);
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(closeEngine);
test.use({ actionTimeout: 15_000 });

async function signIn(page: Page) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  for (const s of [PROJECT_URL, A, B]) {
    await page.getByTestId('source-input').fill(s);
    await page.getByTestId('source-add').click();
  }
  await page.getByTestId('back').click();
  await expect(page.getByTestId('write-entry')).toBeVisible({ timeout: 20_000 });
}

const labelPosts = (repo: string) => env.fake.writes().filter((w) => w.method === 'POST' && w.path === `/api/repos/${repo}/labels`);
const issuePosts = () => env.fake.writes().filter((w) => w.method === 'POST' && /\/issues$/.test(w.path));
const labelsOn = (key: string) => (env.fake.state.w.repoLabels.get(key) ?? []).map((l) => l.name);
const opened = () => (existsSync(env.opened!) ? readFileSync(env.opened!, 'utf8') : '');

async function openDialog(page: Page, repo: string, title = '跑一下测试') {
  await page.getByTestId('write-entry').click();
  await expect(page.getByTestId('new-issue')).toBeVisible();
  await page.getByTestId('new-issue-repo').selectOption(repo);
  if (title) await page.getByTestId('new-issue-title').fill(title);
}
const box = (page: Page) => page.getByTestId('new-issue-labels');
const notice = (page: Page) => page.locator('[data-testid="notice-area"] [data-testid="label-notice"]');

test('GitHub#559: may write — one press creates exactly the missing labels, the buttons come alive, nothing else is created', async () => {
  const { page } = await launchApp(env);
  await signIn(page);
  await openDialog(page, A);
  await expect(box(page)).toHaveAttribute('data-kind', 'create');
  await expect(box(page)).toHaveAttribute('data-repo', A);
  await expect(box(page).getByTestId('new-issue-labels-label')).toHaveText(['pending/agent', 'autopilot']);
  await expect(page.getByTestId('new-issue-agent')).toBeDisabled();
  await expect(page.getByTestId('new-issue-autopilot')).toBeDisabled();
  await shot(page, '559-01-create');
  await box(page).getByTestId('new-issue-labels-create').click();
  await expect(notice(page)).toHaveAttribute('data-state', 'done');
  await expect(notice(page)).toContainText(`已在 ${A} 建好标签「pending/agent」「autopilot」`);
  await shot(page, '559-02-created');
  await expect(page.getByTestId('new-issue-agent')).toBeEnabled();
  await expect(page.getByTestId('new-issue-autopilot')).toBeEnabled();
  await expect(box(page)).toHaveCount(0);
  await expect(page.getByTestId('new-issue-handoff-why')).toHaveCount(0);
  // exactly the two, with the install script's colours and descriptions; nothing else written
  expect(labelPosts(A).map((w) => w.body)).toEqual([
    { name: 'pending/agent', color: 'd4c5f9', description: '等待 agent 处理' },
    { name: 'autopilot', color: 'ff401e', description: '托管：从方案到合并全交给 agent（复审与测试通过后自动合并）' },
  ]);
  expect(env.fake.writes().length).toBe(2);
  expect(issuePosts()).toEqual([]);
  // the dialog is still there, with what was typed
  await expect(page.getByTestId('new-issue-title')).toHaveValue('跑一下测试');
  // a success notice goes away by itself
  await expect(notice(page)).toHaveCount(0, { timeout: 10_000 });
});

test('GitHub#559: may not write — no create request; the list, the labels page and the copied list; 「重新读取」 once someone created them', async () => {
  env.fake.state.w.readOnlyRepos.add(AK);
  const { page } = await launchApp(env);
  await signIn(page);
  await page.evaluate(() => {
    (window as any).__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void (window as any).__copied.push(t) } });
  });
  await openDialog(page, A);
  await expect(box(page)).toHaveAttribute('data-kind', 'guide');
  await expect(box(page).getByTestId('new-issue-labels-why')).toHaveAttribute('data-why', 'noPermission');
  await expect(box(page).getByTestId('new-issue-labels-why')).toContainText(`当前账号不能在 ${A} 建标签`);
  await expect(box(page).getByTestId('new-issue-labels-list')).toContainText('颜色 ff401e');
  await expect(box(page).getByTestId('new-issue-labels-list')).toContainText('颜色 d4c5f9');
  await expect(box(page).getByTestId('new-issue-labels-create')).toHaveCount(0);
  await shot(page, '559-03-no-permission');
  await box(page).getByTestId('new-issue-labels-web').click();
  await expect.poll(opened).toContain(`/${A}/labels`);
  await box(page).getByTestId('new-issue-labels-copy').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied as string[])).toEqual([`pending/agent\t#d4c5f9\t等待 agent 处理\nautopilot\t#ff401e\t托管：从方案到合并全交给 agent（复审与测试通过后自动合并）`]);
  // a maintainer created them on the web page
  env.fake.state.w.repoLabels.set(AK, ['bug', 'autopilot', 'pending/agent'].map((name) => ({ name, color: 'ededed' })));
  await box(page).getByTestId('new-issue-labels-reread').click();
  await expect(box(page)).toHaveCount(0);
  await expect(page.getByTestId('new-issue-agent')).toBeEnabled();
  expect(labelPosts(A)).toEqual([]);
  expect(env.fake.writes()).toEqual([]);
});

test('GitHub#559: permission unreadable, GitHub refuses — the button first, then the guide; 「重试」 sends the same again', async () => {
  env.fake.state.w.failRepoInfo.add(AK);
  env.fake.state.w.readOnlyRepos.add(AK);
  const { page } = await launchApp(env);
  await signIn(page);
  await openDialog(page, A);
  // not known is not "no": the button is offered
  await expect(box(page)).toHaveAttribute('data-kind', 'create');
  await box(page).getByTestId('new-issue-labels-create').click();
  await expect(notice(page)).toHaveAttribute('data-state', 'refused');
  await expect(notice(page)).toContainText(`没能在 ${A} 建标签`);
  await expect(box(page)).toHaveAttribute('data-kind', 'guide');
  await expect(box(page).getByTestId('new-issue-labels-why')).toHaveAttribute('data-why', 'refused');
  expect(labelPosts(A).length).toBe(2);
  await expect(notice(page).getByTestId('label-notice-retry')).toHaveAttribute('data-retry', 'resend');
  // the account got write access meanwhile: the guide's own button sends the same labels to the same repository
  // (the notice's 「重试」 lies under the dialog while it is open)
  env.fake.state.w.readOnlyRepos.delete(AK);
  await box(page).getByTestId('new-issue-labels-create').click();
  await expect(notice(page)).toHaveAttribute('data-state', 'done');
  expect(labelPosts(A).map((w) => (w.body as any).name)).toEqual(['pending/agent', 'autopilot', 'pending/agent', 'autopilot']);
  expect(labelsOn(AK)).toEqual(['bug', 'pending/agent', 'autopilot']);
  await expect(page.getByTestId('new-issue-autopilot')).toBeEnabled();
});

test('GitHub#559: a press in A, the dialog switched to B while A is held — B shows only its own state, the notice names A', async () => {
  const { page } = await launchApp(env);
  await signIn(page);
  await openDialog(page, A);
  await expect(box(page)).toHaveAttribute('data-kind', 'create');
  const release = env.fake.holdWhen((e) => e.method === 'POST' && e.path === `/api/repos/${A}/labels`);
  await box(page).getByTestId('new-issue-labels-create').click();
  await expect(box(page)).toHaveAttribute('data-kind', 'running');
  await expect(box(page).getByTestId('new-issue-labels-create')).toBeDisabled();
  await expect(notice(page)).toHaveAttribute('data-repo', A);
  await expect(notice(page)).toContainText(`正在 ${A} 建标签`);
  // to B: its own labels, its own button, not "running"
  await page.getByTestId('new-issue-repo').selectOption(B);
  await expect(box(page)).toHaveAttribute('data-repo', B);
  await expect(box(page)).toHaveAttribute('data-kind', 'create');
  await expect(box(page).getByTestId('new-issue-labels-create')).toBeEnabled();
  await expect(page.getByTestId('new-issue-agent')).toBeDisabled();
  await shot(page, '559-04-switched-while-running');
  // A's answers arrive: the notice says A, B is untouched
  release();
  await expect(notice(page)).toHaveAttribute('data-state', 'done');
  await expect(notice(page)).toContainText(`已在 ${A} 建好标签`);
  await page.waitForTimeout(500);
  await expect(box(page)).toHaveAttribute('data-repo', B);
  await expect(box(page)).toHaveAttribute('data-kind', 'create');
  await expect(page.getByTestId('new-issue-agent')).toBeDisabled();
  await expect(page.getByTestId('new-issue-autopilot')).toBeDisabled();
  expect(labelPosts(B)).toEqual([]);
  expect(labelsOn(BK)).toEqual(['bug']);
  // back to A: read again, its labels are there
  await page.getByTestId('new-issue-repo').selectOption(A);
  await expect(box(page)).toHaveCount(0);
  await expect(page.getByTestId('new-issue-agent')).toBeEnabled();
  expect(issuePosts()).toEqual([]);
});

test('GitHub#559 (PR #564 review round 1): no answer — the dialog offers only 「再查一次」 (reads, never sends); missing → the button again; landed → done', async () => {
  const { page } = await launchApp(env);
  await signIn(page);
  await openDialog(page, A, '');
  const late = env.fake.lateWhen((e) => e.method === 'POST' && e.path === `/api/repos/${A}/labels`);
  await box(page).getByTestId('new-issue-labels-create').click();
  await expect(notice(page)).toHaveAttribute('data-state', 'unknown');
  await expect(notice(page).getByTestId('label-notice-retry')).toHaveAttribute('data-retry', 'recheck');
  // the requests did reach GitHub (their answers were lost) and nothing landed yet
  await expect.poll(() => late.caught()).toBe(2);
  expect(labelPosts(A).length).toBe(2);
  expect(labelsOn(AK)).toEqual(['bug']);
  // in the dialog: the read-only check, no button that sends
  await expect(box(page)).toHaveAttribute('data-kind', 'unknown');
  await expect(box(page).getByTestId('new-issue-labels-create')).toHaveCount(0);
  await expect(box(page).getByTestId('new-issue-labels-recheck')).toBeEnabled();
  await expect(page.getByTestId('new-issue-agent')).toBeDisabled();
  await shot(page, '559-05-no-answer');
  // checked while still not there: nothing sent, the button comes back
  const before = env.fake.writes().length;
  await box(page).getByTestId('new-issue-labels-recheck').click();
  await expect(notice(page)).toHaveAttribute('data-state', 'missing');
  await expect(box(page)).toHaveAttribute('data-kind', 'create');
  expect(env.fake.writes().length).toBe(before);
  // a second press, its answers lost again — then they land after all
  await box(page).getByTestId('new-issue-labels-create').click();
  await expect(box(page)).toHaveAttribute('data-kind', 'unknown');
  await expect.poll(() => late.caught()).toBe(4);
  late.land();
  late.stop();
  expect(labelsOn(AK)).toEqual(['bug', 'pending/agent', 'autopilot']);
  const sent = env.fake.writes().length;
  await box(page).getByTestId('new-issue-labels-recheck').click();
  await expect(notice(page)).toHaveAttribute('data-state', 'done');
  await expect(box(page)).toHaveCount(0);
  await expect(page.getByTestId('new-issue-title')).toBeVisible();
  await page.getByTestId('new-issue-title').fill('跑一下测试');
  await expect(page.getByTestId('new-issue-agent')).toBeEnabled();
  expect(env.fake.writes().length).toBe(sent);
  expect(issuePosts()).toEqual([]);
});

test('GitHub#559 (PR #564 review round 1): someone else created them meanwhile and the read afterwards fails — 422 "already exists" is done, never a refusal', async () => {
  const { page } = await launchApp(env);
  await signIn(page);
  await openDialog(page, A);
  await expect(box(page)).toHaveAttribute('data-kind', 'create');
  // the dialog read them missing; now another window creates both, and the label list stops answering
  env.fake.state.w.repoLabels.set(AK, ['bug', 'pending/agent', 'autopilot'].map((name) => ({ name, color: 'ededed' })));
  env.fake.state.w.failLabels.add(AK);
  await box(page).getByTestId('new-issue-labels-create').click();
  await expect(notice(page)).toHaveAttribute('data-state', 'done');
  expect(labelPosts(A).map((w) => (w.body as any).name)).toEqual(['pending/agent', 'autopilot']);
  // GitHub really answered 422 to both
  expect(env.fake.log.filter((l) => l.method === 'POST' && l.path === `/api/repos/${A}/labels`).map((l) => l.status)).toEqual([422, 422]);
  // no guide asking for labels that exist (the dialog's own read fails: it says so, it offers nothing to create)
  await expect(page.getByTestId('new-issue-labels')).toHaveCount(0);
  await expect(page.getByTestId('new-issue-handoff-why').first()).toContainText('读不到仓库');
  // the list answers again: the buttons work
  env.fake.state.w.failLabels.delete(AK);
  await page.getByTestId('new-issue-repo').selectOption(B);
  await page.getByTestId('new-issue-repo').selectOption(A);
  await expect(page.getByTestId('new-issue-agent')).toBeEnabled();
});

test('GitHub#559 (PR #564 review round 1): a 422 that is not "already exists" is a refusal — the guide, with GitHub\'s words', async () => {
  env.fake.state.w.rejectLabelCreate.add('autopilot');
  const { page } = await launchApp(env);
  await signIn(page);
  await openDialog(page, A);
  await box(page).getByTestId('new-issue-labels-create').click();
  await expect(notice(page)).toHaveAttribute('data-state', 'refused');
  await expect(box(page)).toHaveAttribute('data-kind', 'guide');
  await expect(box(page).getByTestId('new-issue-labels-why')).toHaveAttribute('data-why', 'refused');
  await expect(box(page).getByTestId('new-issue-labels-why')).toContainText('Validation Failed');
  // the one GitHub took is there; the other is not
  expect(labelsOn(AK)).toEqual(['bug', 'pending/agent']);
  await expect(page.getByTestId('new-issue-agent')).toBeEnabled();
  await expect(page.getByTestId('new-issue-autopilot')).toBeDisabled();
});
