// GigleAI/cavil-loop#577: the Windows app's window. Three places say or show something else than on a
// Mac: the reminder card (the taskbar number and the icon in the notification area instead of the Dock
// badge and ⌘Q), the local daemon card (Windows cannot run the daemon: a note and a way to the remote
// daemon card instead of checks and buttons, and no "接上 daemon" on the repositories), and where the
// sign-in is kept (Windows Credential Manager instead of the keychain). The shell names the system
// (`desktop_system`); here the bridge's fake desktop plays it. The Mac wording stays as it was — the
// same steps with the shell saying "macos" check that. The real window (built with --test-bridge), the
// real back end behind the loopback bridge, the local fake GitHub.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';
import { unfoldSettings } from './unfold';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
};

const REPO = 'GigleAI/cavil-loop';

let env: AppEnv;
let dir: string;
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
  rmSync(dir, { recursive: true, force: true });
});
test.afterAll(closeEngine);

/** sign in, add the repository as a source, stay on the settings page */
async function signInToSettings(page: Page) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await unfoldSettings(page);
  await page.getByTestId('source-input').fill(REPO);
  await page.getByTestId('source-add').click();
  await expect(page.getByTestId('settings')).toBeVisible();
}

const MAC = {
  login: '凭据存在本机钥匙串里，只发给 GitHub。',
  clear: 'Dock 角标 = 窗口不在前台时新来的待处理数，切到 App 清零。',
  close: '关掉窗口后 App 仍在后台同步和提醒（Dock 图标保留）；要完全退出，用菜单「退出」或 ⌘Q。',
  rule: 'Dock 角标只是「未读数」',
  logout: '会删除钥匙串里的凭据',
};
const WIN = {
  login: '凭据存在本机的 Windows 凭据管理器里，只发给 GitHub。',
  clear: '任务栏图标上的数字 = 窗口不在前台时新来的待处理数，切到 App 清零。',
  close: '关掉窗口后 App 仍在后台同步和提醒（图标留在任务栏右下角的通知区域）；要完全退出，在那个图标上右键选「退出」。',
  rule: '任务栏图标上的数字只是「未读数」',
  logout: '会删除 Windows 凭据管理器里的凭据',
};

test('Windows: the reminder card names the taskbar and the notification area, the daemon card points at the remote daemon, sign-in is kept in Credential Manager', async () => {
  const app = await launchApp(env, { system: 'windows' });
  const { page } = app;
  try {
    await expect(page.getByTestId('permission-text')).toContainText(WIN.login);
    await expect(page.getByTestId('permission-text')).not.toContainText('钥匙串');
    await signInToSettings(page);

    // ① the reminder card
    await expect(page.getByTestId('pending-how-to-clear')).toHaveText(WIN.clear);
    await expect(page.getByTestId('launch-at-login')).toBeVisible();
    await expect(page.getByTestId('close-keeps-running')).toHaveText(WIN.close);
    await expect(page.getByTestId('pending-more')).toContainText(WIN.rule);
    await expect(page.getByTestId('pending-settings')).not.toContainText('Dock');
    await expect(page.getByTestId('pending-settings')).not.toContainText('⌘Q');
    await page.getByTestId('pending-settings').scrollIntoViewIfNeeded();
    await shot(page, 'windows-1-pending-settings');

    // ② the daemon card: a note and a way to the remote daemon card, none of the local checks or buttons
    await expect(page.getByTestId('daemon-windows-note')).toContainText('这台电脑是 Windows，不能运行 daemon');
    await expect(page.getByTestId('daemon-settings')).toHaveCount(0);
    await expect(page.getByTestId('daemon-install')).toHaveCount(0);
    // the repository is listed, without "接上 daemon"
    await expect(page.locator('#set-sources')).toContainText(REPO);
    await expect(page.getByTestId('connect-open')).toHaveCount(0);
    await expect(page.getByTestId('connect-connected')).toHaveCount(0);
    await page.getByTestId('daemon-settings-windows').scrollIntoViewIfNeeded();
    await shot(page, 'windows-2-daemon-note');
    await page.getByTestId('daemon-go-remote').click();
    await expect(page.getByTestId('remote-settings')).toBeInViewport();

    // ③ the account card
    await expect(page.getByTestId('logout-note')).toHaveText(WIN.logout);
    await page.getByTestId('logout-note').scrollIntoViewIfNeeded();
    await shot(page, 'windows-3-account');
  } finally {
    await app.close();
  }
});

test('macOS: the same places keep the Mac wording and the local daemon card', async () => {
  const app = await launchApp(env, { system: 'macos' });
  const { page } = app;
  try {
    await expect(page.getByTestId('permission-text')).toContainText(MAC.login);
    await signInToSettings(page);
    await expect(page.getByTestId('pending-how-to-clear')).toHaveText(MAC.clear);
    await expect(page.getByTestId('close-keeps-running')).toHaveText(MAC.close);
    await expect(page.getByTestId('pending-more')).toContainText(MAC.rule);
    await expect(page.getByTestId('daemon-settings')).toBeVisible();
    await expect(page.getByTestId('daemon-settings-windows')).toHaveCount(0);
    await expect(page.getByTestId('logout-note')).toHaveText(MAC.logout);
    for (const w of Object.values(WIN)) await expect(page.getByTestId('settings')).not.toContainText(w);
  } finally {
    await app.close();
  }
});
