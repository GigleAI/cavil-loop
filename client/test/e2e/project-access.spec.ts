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

test('an organisation that has not approved the app: one explanation in the card, Settings and the ⚠️; approved + "重新读取" reads it', async () => {
  env.fake.state.restrictedOrgs.set('gigleai', { kind: 'oauth' });
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
  await expect(card.getByTestId('failure-auth-page')).toBeVisible();
  await expect(card).toContainText('OAuth App access restrictions');
  await expect(page.getByTestId('board-notice')).toHaveCount(0);
  await shot(page, 'board-failed');

  await page.getByTestId('sync-trouble').click();
  await expect(page.getByTestId('sync-trouble-source')).toContainText(`读取失败（${RESTRICTED_TITLE}）`);
  await page.getByTestId('sync-trouble').click();

  await page.getByTestId('open-settings').click();
  const row = page.getByTestId('source-row');
  await expect(row.getByTestId('source-failure').getByTestId('failure-title')).toHaveText(RESTRICTED_TITLE);
  await shot(page, 'settings-failed');

  // approved on GitHub; "重新读取" from the row reads it
  env.fake.state.restrictedOrgs.delete('gigleai');
  await row.getByTestId('failure-retry').click();
  await expect(row.getByTestId('source-failure')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('[data-testid="source-row"] .kind')).not.toContainText(' 0 个条目', { timeout: 15_000 });
  await page.getByTestId('back').click();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('empty-guide')).toHaveCount(0);
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
