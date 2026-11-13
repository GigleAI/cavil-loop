// GigleAI/cavil-loop#401, in the real window: the empty board says how to add a source (and opens
// Settings with the Project list open, or the address box ready); "从 GitHub 选" lists what the
// account can see and adds with one click; an organisation that has not approved the app says so —
// in the Settings row, the empty board's card and the ⚠️ the same words — and "重新读取" reads it
// once it is approved. The board's "no iteration field" notice is gone while there is no source.
// Screenshots of each state land in test-results/screens/ (issue401-*).

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const RESTRICTED_TITLE = '组织 GigleAI 还没有批准 Cavil Loop 访问它的数据';

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

async function signIn(): Promise<Page> {
  const app = await launchApp(env);
  const page = app.page;
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toHaveText(/^ABCD-\d+$/);
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  return page;
}
const opened = () => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '');
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `issue401-${name}.png`) });
};

test('no source: the guide; "从 GitHub 选" lists the account\'s Projects, a refusing organisation says why, one click adds', async () => {
  env.fake.state.memberOrgs.set('user-1', ['GigleAI', 'acme-team']);
  env.fake.state.restrictedOrgs.set('acme-team', { kind: 'oauth' });
  env.fake.state.extraProjects.set('user/user-1', [{ number: 2, title: '读书清单' }]);
  const page = await signIn();

  const guide = page.getByTestId('empty-guide');
  await expect(guide).toHaveAttribute('data-kind', 'add');
  await expect(guide).toContainText('user-1');
  // the iteration-field notice is not up while there is no source at all
  await expect(page.getByTestId('board-notice')).toHaveCount(0);
  await shot(page, 'board-empty');

  // "打开 GitHub 授权页" opens this app's own page on GitHub
  await guide.getByTestId('guide-auth-page').click();
  await expect.poll(opened).toContain(`${env.fake.web}/settings/connections/applications/${env.fake.state.oauthClientId}\n`);

  await guide.getByTestId('guide-pick').click();
  const picker = page.getByTestId('project-picker');
  await expect(picker).toBeVisible();
  await expect(picker.locator('[data-testid="picker-group"]')).toHaveCount(3);
  await expect(picker.locator('[data-testid="picker-group"][data-owner="user-1"] [data-testid="picker-row"]')).toContainText('读书清单');
  const acme = picker.locator('[data-testid="picker-group"][data-owner="acme-team"]');
  await expect(acme.getByTestId('failure-title')).toHaveText('组织 acme-team 还没有批准 Cavil Loop 访问它的数据');
  await expect(acme.getByTestId('picker-row')).toHaveCount(0);
  const gigle = picker.locator(`[data-testid="picker-row"][data-url="${PROJECT_URL}"]`);
  await expect(gigle).toBeVisible();
  await shot(page, 'picker');

  await gigle.getByTestId('picker-add').click();
  await expect(gigle.getByTestId('picker-added')).toBeVisible();
  await expect(page.getByTestId('source-row')).toHaveCount(1);
  await expect(page.locator('[data-testid="source-row"] .kind')).not.toContainText(' 0 个条目', { timeout: 15_000 });
  await page.getByTestId('back').click();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('empty-guide')).toHaveCount(0);
});

test('"去设置添加" focuses the address box', async () => {
  const page = await signIn();
  await page.getByTestId('guide-add').click();
  await expect(page.getByTestId('source-input')).toBeFocused();
  await expect(page.getByTestId('project-picker')).toHaveCount(0);
});

/** title + explanation + GitHub's words + buttons of one failure note, as shown */
async function noteText(note: import('@playwright/test').Locator) {
  return {
    title: await note.getByTestId('failure-title').innerText(),
    body: await note.getByTestId('failure-body').innerText(),
    raw: await note.getByTestId('failure-raw').innerText(),
    buttons: await note.locator('.failure-actions button').allInnerTexts(),
  };
}

test('an organisation that has not approved the app: the same explanation in the card, Settings, the ⚠️ and the picker; the README steps, followed as written, read it once approved', async () => {
  env.fake.state.restrictedOrgs.set('gigleai', { kind: 'oauth' });
  env.fake.state.memberOrgs.set('user-1', ['GigleAI']);
  const page = await signIn();
  // the first read is held: while it has not answered there is no "failed" card
  const release = env.fake.holdWhen((e) => e.operation === 'CavilProjectItems');
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(PROJECT_URL);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect.poll(() => env.fake.log.some((e) => e.operation === 'CavilProjectItems')).toBe(true);
  await expect(page.getByTestId('empty-guide')).toHaveCount(0);
  release();

  const card = page.getByTestId('empty-guide');
  await expect(card).toHaveAttribute('data-kind', 'failed', { timeout: 15_000 });
  await expect(card.getByTestId('failure-title')).toHaveText(RESTRICTED_TITLE);
  await expect(page.getByTestId('board-notice')).toHaveCount(0);
  const inCard = await noteText(card.getByTestId('guide-failure'));
  expect(inCard.raw).toContain('OAuth App access restrictions');
  expect(inCard.buttons).toEqual(['打开 GitHub 授权页', '重新读取']);
  await shot(page, 'board-failed');

  // the ⚠️ panel: the same note (explanation, buttons, GitHub's words), not only the title
  await page.getByTestId('sync-trouble').click();
  await expect(page.getByTestId('sync-trouble-source')).toContainText(`读取失败（${RESTRICTED_TITLE}）`);
  expect(await noteText(page.getByTestId('sync-trouble-failure'))).toEqual(inCard);
  await shot(page, 'trouble-panel');
  await page.getByTestId('sync-trouble').click();

  await page.getByTestId('open-settings').click();
  const row = page.getByTestId('source-row');
  const inSettings = await noteText(row.getByTestId('source-failure'));
  expect(inSettings).toEqual(inCard);
  await shot(page, 'settings-failed');

  // the picker's row for the same organisation: the same explanation and buttons
  await page.getByTestId('source-pick').click();
  const pick = page.locator('[data-testid="picker-group"][data-owner="GigleAI"] [data-testid="picker-group-failure"]');
  await expect(pick).toBeVisible();
  const inPicker = await noteText(pick);
  expect({ title: inPicker.title, body: inPicker.body, buttons: inPicker.buttons }).toEqual({ title: inCard.title, body: inCard.body, buttons: inCard.buttons });
  expect(inPicker.raw).toContain('OAuth App access restrictions');
  await page.getByTestId('source-pick').click();

  // README "读不到组织的 Project 怎么办", step by step:
  // 1. 点「打开 GitHub 授权页」 → this app's own page on GitHub
  const before = opened().length;
  await row.getByTestId('failure-auth-page').click();
  await expect.poll(() => opened().slice(before)).toBe(`${env.fake.web}/settings/connections/applications/${env.fake.state.oauthClientId}\n`);
  // (not approved yet) 「重新读取」 → still not readable, the same explanation stays (the way back: nothing lost)
  const reads = () => env.fake.log.filter((e) => e.operation === 'CavilProjectItems').length;
  const n = reads();
  await row.getByTestId('failure-retry').click();
  await expect.poll(reads).toBeGreaterThan(n);
  await expect(row.getByTestId('source-failure').getByTestId('failure-title')).toHaveText(RESTRICTED_TITLE);
  // 2. on GitHub the organisation's access is granted (stand-in: the fake GitHub stops refusing — the
  //    real page's Request / Grant cannot be driven here)
  env.fake.state.restrictedOrgs.delete('gigleai');
  // 3. 回到这里点「重新读取」 → read: the explanation goes, the items are there
  await row.getByTestId('failure-retry').click();
  await expect(row.getByTestId('source-failure')).toHaveCount(0, { timeout: 15_000 });
  await expect(row.locator('.kind')).not.toContainText(' 0 个条目');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('empty-guide')).toHaveCount(0);
});

test('Client ID changed in Settings without signing in again: "打开 GitHub 授权页" still opens the page of the app this sign-in used', async () => {
  const page = await signIn();
  await page.getByTestId('open-settings').click();
  await page.locator('#set-login').getByTestId('oauth-settings-toggle').click();
  await page.locator('#set-login').getByTestId('client-id').fill('Ov23liAnotherApp');
  await page.locator('#set-login').getByTestId('save-client-id').click();
  await page.getByTestId('back').click();
  // the save really happened: Settings now holds the other app's ID for the next sign-in
  await page.getByTestId('open-settings').click();
  if ((await page.locator('#set-login').getByTestId('client-id').count()) === 0) await page.locator('#set-login').getByTestId('oauth-settings-toggle').click();
  await expect(page.locator('#set-login').getByTestId('client-id')).toHaveValue('Ov23liAnotherApp');
  await page.getByTestId('back').click();
  const before = opened().length;
  await page.getByTestId('guide-auth-page').click();
  await expect.poll(() => opened().slice(before)).toBe(`${env.fake.web}/settings/connections/applications/${env.fake.state.oauthClientId}\n`);
  expect(opened()).not.toContain('Ov23liAnotherApp');
});

test('"从 GitHub 选" rate limited: every way of reading again waits (no request), the buttons come back by themselves at GitHub\'s time, then it reads', async () => {
  let limited = true;
  env.fake.state.answerOverride = (e) => (limited && e.operation === 'CavilChoicesViewer' ? { status: 429, body: { message: 'too many' }, headers: { 'retry-after': '3' } } : null);
  const page = await signIn();
  const reads = () => env.fake.log.filter((e) => e.operation === 'CavilChoicesViewer').length;
  await page.getByTestId('guide-pick').click();
  const note = page.getByTestId('picker-failure');
  await expect(note).toHaveAttribute('data-kind', 'rateLimited');
  await expect(note.getByTestId('failure-retry')).toBeDisabled();
  await expect(page.getByTestId('picker-reload')).toBeDisabled();
  expect(reads()).toBe(1);
  // closing and opening the list again sends nothing either
  await page.getByTestId('source-pick').click();
  await page.getByTestId('source-pick').click();
  await expect(page.getByTestId('picker-failure')).toHaveAttribute('data-kind', 'rateLimited');
  expect(reads()).toBe(1);
  limited = false;
  // nothing else happens on the page: the buttons come back at GitHub's time on their own
  await expect(page.getByTestId('picker-failure').getByTestId('failure-retry')).toBeEnabled({ timeout: 8_000 });
  await expect(page.getByTestId('picker-reload')).toBeEnabled();
  expect(reads()).toBe(1);
  await page.getByTestId('picker-failure').getByTestId('failure-retry').click();
  await expect(page.locator('[data-testid="picker-group"]').first()).toBeVisible();
  expect(reads()).toBe(2);
});

test('one organisation rate limited while another is still loading: closing and opening the list sends nothing; after GitHub\'s time it reads (PR #414 review round 2)', async () => {
  env.fake.state.memberOrgs.set('user-1', ['a-org', 'b-org']);
  let limited = true;
  env.fake.state.answerOverride = (e) =>
    limited && e.operation === 'CavilChoicesOrg' && e.variables?.login === 'a-org' ? { status: 429, body: { message: 'too many' }, headers: { 'retry-after': '3' } } : null;
  const release = env.fake.holdWhen((e) => e.operation === 'CavilChoicesOrg' && e.variables?.login === 'b-org');
  const page = await signIn();
  const viewerReads = () => env.fake.log.filter((e) => e.operation === 'CavilChoicesViewer').length;
  await page.getByTestId('guide-pick').click();
  await expect.poll(() => env.fake.log.some((e) => e.operation === 'CavilChoicesOrg' && e.variables?.login === 'a-org' && e.status === 429)).toBe(true);
  await expect.poll(() => env.fake.log.some((e) => e.operation === 'CavilChoicesOrg' && e.variables?.login === 'b-org')).toBe(true);
  await expect(page.getByTestId('picker-loading')).toBeVisible();
  expect(viewerReads()).toBe(1);
  // closed and opened again while b-org has not answered
  await page.getByTestId('source-pick').click();
  await page.getByTestId('source-pick').click();
  await page.waitForTimeout(300);
  expect(viewerReads()).toBe(1);
  release();
  const aOrg = page.locator('[data-testid="picker-group"][data-owner="a-org"] [data-testid="picker-group-failure"]');
  await expect(aOrg).toHaveAttribute('data-kind', 'rateLimited');
  await expect(page.getByTestId('picker-reload')).toBeDisabled();
  expect(viewerReads()).toBe(1);
  limited = false;
  await expect(page.getByTestId('picker-reload')).toBeEnabled({ timeout: 8_000 });
  await page.getByTestId('picker-reload').click();
  await expect(page.locator('[data-testid="picker-group"][data-owner="a-org"] [data-testid="picker-group-failure"]')).toHaveCount(0);
  expect(viewerReads()).toBe(2);
});

test('a missing repository while the grant lacks the Project scope: "找不到", never "sign in again"', async () => {
  env.fake.state.oauthScopes = 'repo, read:org';
  const page = await signIn();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill('acme/missing');
  await page.getByTestId('source-add').click();
  const note = page.getByTestId('source-failure');
  await expect(note).toHaveAttribute('data-kind', 'notFound', { timeout: 15_000 });
  await expect(note.getByTestId('failure-relogin')).toHaveCount(0);
});

test('no connection: "连不上 GitHub", only "重新读取", nothing about authorising', async () => {
  const page = await signIn();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(PROJECT_URL);
  await page.getByTestId('source-add').click();
  await expect(page.locator('[data-testid="source-row"] .kind')).not.toContainText(' 0 个条目', { timeout: 15_000 });
  env.fake.state.offlineApi = true;
  await page.getByTestId('back').click();
  await page.getByTestId('refresh').click().catch(() => {});
  await page.getByTestId('open-settings').click();
  const note = page.getByTestId('source-failure');
  await expect(note.getByTestId('failure-title')).toHaveText('连不上 GitHub', { timeout: 15_000 });
  await expect(note.getByTestId('failure-retry')).toBeVisible();
  await expect(note.getByTestId('failure-auth-page')).toHaveCount(0);
  await expect(note.getByTestId('failure-relogin')).toHaveCount(0);
  await shot(page, 'settings-offline');
});

test('empty board card: "重新读取" spins while it runs and says what came of it; read once approved → the card goes (GitHub#455)', async () => {
  env.fake.state.restrictedOrgs.set('gigleai', { kind: 'oauth' });
  env.fake.state.memberOrgs.set('user-1', ['GigleAI']);
  const page = await signIn();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(PROJECT_URL);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  const card = page.getByTestId('empty-guide');
  await expect(card).toHaveAttribute('data-kind', 'failed', { timeout: 15_000 });
  const retry = card.getByTestId('failure-retry');
  await expect(retry).toHaveText('重新读取');
  const reads = () => env.fake.log.filter((e) => e.operation === 'CavilProjectItems').length;

  // held at GitHub: the card's own button spins, says when it started, and really reads
  const release = env.fake.holdWhen((e) => e.operation === 'CavilProjectItems');
  const n = reads();
  await retry.click();
  await expect(retry).toHaveText('正在重新读取…');
  await expect(retry).toHaveAttribute('data-running', 'yes');
  await expect(card.getByTestId('failure-reread-running')).toContainText(/^\d\d:\d\d:\d\d 开始重新读取，/);
  await expect.poll(reads).toBeGreaterThan(n);
  // answered, still refused: the outcome in the card, to the second
  release();
  await expect(card.getByTestId('failure-reread-result')).toHaveText(/^\d\d:\d\d:\d\d 重新读取完毕：这个来源仍然读取失败（原因见上）。$/, { timeout: 15_000 });
  await expect(card.getByTestId('failure-reread-running')).toHaveCount(0);
  await expect(retry).toHaveText('重新读取');
  await shot(page, '455-card-still-failing');

  // approved: the card goes
  env.fake.state.restrictedOrgs.delete('gigleai');
  await retry.click();
  await expect(card).toHaveCount(0, { timeout: 15_000 });
});

test('the green "all read" note never comes back: a panel reread that recovers, then fails again within 5 s, then a recovery by the refresh button (GitHub#455, PR #458 review round 1)', async () => {
  env.fake.state.memberOrgs.set('user-1', ['GigleAI']);
  const page = await signIn();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(PROJECT_URL);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('empty-guide')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('sync-trouble')).toHaveCount(0, { timeout: 15_000 });
  const btn = page.getByTestId('sync-trouble');
  const ok = page.getByTestId('sync-reread-ok');
  // refused at once (no retry wait), so every step fits in the note's 5 seconds
  const fail = async () => {
    env.fake.state.restrictedOrgs.set('gigleai', { kind: 'oauth' });
    await page.getByTestId('refresh').click();
    await expect(btn).toBeVisible({ timeout: 15_000 });
  };

  // 1. the panel reread recovers: the note
  await fail();
  await btn.click();
  env.fake.state.restrictedOrgs.delete('gigleai');
  await page.getByTestId('sync-trouble-resync').click();
  await expect(btn).toHaveCount(0, { timeout: 15_000 });
  await expect(ok).toBeVisible();
  // 2. within the 5 seconds: fails again, and a panel reread fails too
  await fail();
  await expect(ok).toHaveCount(0);
  await btn.click();
  await page.getByTestId('sync-trouble-resync').click();
  await expect(page.getByTestId('sync-trouble-result')).toContainText('仍然读取失败', { timeout: 15_000 });
  // 3. recovered by the refresh button: no note, now or later
  env.fake.state.restrictedOrgs.delete('gigleai');
  await page.getByTestId('refresh').click();
  await expect(btn).toHaveCount(0, { timeout: 15_000 });
  await expect(ok).toHaveCount(0);
  await page.waitForTimeout(6500);
  await expect(ok).toHaveCount(0);

  // 4. the same order without the second panel reread (only an automatic failure in between): no note either
  await fail();
  await btn.click();
  env.fake.state.restrictedOrgs.delete('gigleai');
  await page.getByTestId('sync-trouble-resync').click();
  await expect(ok).toBeVisible({ timeout: 15_000 });
  await fail();
  env.fake.state.restrictedOrgs.delete('gigleai');
  await page.getByTestId('refresh').click();
  await expect(btn).toHaveCount(0, { timeout: 15_000 });
  await expect(ok).toHaveCount(0);
  await page.waitForTimeout(6500);
  await expect(ok).toHaveCount(0);
});
