// GitHub#473 (sub-issue ③ of #466): the app updating itself, in English — the update section of
// Settings, the list of what changed, the board's "ready" and "updated" notices. The shell's side
// (what the updater says) is played by the bridge, worded as the back end words it: its own words
// in English, the network's / the updater's words as written in a marked part; the release notes
// come from GitHub's release pages and are shown as written. Real window, real back end.
// The back end's wording itself (the same states through the real updater) is test/unit/update.test.ts.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';
import { chineseIn } from './langCheck';

const REPO = 'GigleAI/cavil-loop';

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-i18n-update-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

async function signIn(page: Page) {
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
}

const CUR = '0.5.1-dev.444';
const NEW = '0.5.1-dev.462';
const notes = {
  from: CUR,
  to: NEW,
  complete: false,
  more: 1,
  entries: [
    { version: NEW, at: new Date(2026, 10, 10, 11, 27).toISOString(), more: 2, items: [{ title: '重启后窗口回到原来的大小和位置（GitHub#333）', more: '关掉 App 再打开，窗口还在原来的位置。' }] },
    { version: '0.5.1-dev.456', at: null, more: 0, items: [{ title: '只有标题的一条', more: null }] },
    { version: '0.5.1-dev.455', at: null, more: 0, items: [] },
  ],
};
const at = new Date(2026, 10, 6, 14, 2).getTime();
const base = { supported: true, current: CUR, auto: true, channel: 'dev', devUnavailable: null, problem: null, phase: 'idle', dismissed: null, last: null, notes: null, installed: null };
/** a failed round as the back end words it in English: the network's words in their hole */
const failed = {
  at,
  ok: false,
  message: 'Downloading 0.5.1 failed: 网络中断（没收全）',
  said: { template: 'Downloading 0.5.1 failed: {e_e}', parts: [{ name: 'e_e', text: '网络中断（没收全）', from: 'system' }] },
};

test('GitHub#473: the update section, its list of changes and the board notices in English; the release notes and the network\'s words as written', async () => {
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  await page.getByTestId('lang-en').check();
  await expect(page.locator('.settings .toolbar h2')).toHaveText('Settings');
  const SECTION = ['#set-update'];

  app.desktop.setUpdate(base);
  await expect(page.getByTestId('update-line')).toHaveText('Not checked yet');
  await expect(page.getByTestId('update-check')).toHaveText('Check now');
  await expect(page.getByTestId('update-current')).toHaveText(CUR);
  await expect(page.getByTestId('update-channel-note')).toContainText('Development builds follow main');
  expect(await chineseIn(page, SECTION)).toEqual([]);

  app.desktop.setUpdate({ ...base, phase: 'downloading', version: '0.5.1', got: 3_200_000, total: 8_000_000, notes });
  await expect(page.getByTestId('update-line')).toHaveText('Downloading 0.5.1 (3.2 / 8.0 MB)');
  await expect(page.getByTestId('update-notes-open')).toHaveText("See what's new (4 versions)");
  expect(await chineseIn(page, SECTION)).toEqual([]);

  // the list of what changed: the release pages' words as written, everything around them English
  await page.getByTestId('update-notes-open').click();
  const dialog = page.getByTestId('update-notes');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('update-notes-range')).toHaveText(`${CUR} → ${NEW}, 4 versions`);
  await expect(dialog.locator(`[data-version="${NEW}"] summary [data-verbatim="github"]`)).toHaveText('重启后窗口回到原来的大小和位置（GitHub#333）');
  await expect(dialog.locator(`[data-version="${NEW}"]`)).toContainText('2 more items, see them on GitHub');
  await expect(dialog.locator('[data-version="0.5.1-dev.456"] [data-verbatim="github"]')).toHaveText('只有标题的一条');
  await expect(dialog.locator('[data-version="0.5.1-dev.455"]').getByTestId('update-notes-none')).toHaveText('No notes were written for this version');
  await expect(dialog.getByTestId('update-notes-foot')).toContainText('1 earlier version is not listed');
  await expect(dialog.getByTestId('update-notes-close')).toHaveText('Close');
  // the details opened too
  await dialog.locator(`[data-version="${NEW}"] summary`).click();
  await expect(dialog.locator(`[data-version="${NEW}"] .more [data-verbatim="github"]`)).toHaveText('关掉 App 再打开，窗口还在原来的位置。');
  expect(await chineseIn(page, ['[data-testid="update-notes"]'])).toEqual([]);
  await dialog.getByTestId('update-notes-close').click();

  // a failed round: the back end's words in English, the network's in their marked part
  app.desktop.setUpdate({ ...base, last: failed });
  await expect(page.getByTestId('update-line')).toHaveText('Downloading 0.5.1 failed: 网络中断（没收全） (14:02)');
  await expect(page.getByTestId('update-line').locator('[data-verbatim="system"]')).toHaveText('网络中断（没收全）');
  expect(await chineseIn(page, SECTION)).toEqual([]);
  app.desktop.setUpdate({ ...base, last: { at, ok: true, message: 'Up to date', said: { template: 'Up to date', parts: [] } } });
  await expect(page.getByTestId('update-line')).toHaveText('Last checked 14:02: Up to date');

  // installing: the channel cannot be switched now
  app.desktop.setUpdate({ ...base, phase: 'installing', version: NEW });
  await expect(page.getByTestId('update-channel-note')).toHaveText(`Installing ${NEW}; the channel can be switched once it is installed`);
  expect(await chineseIn(page, SECTION)).toEqual([]);

  // ready: Settings and the board's notice
  app.desktop.setUpdate({ ...base, phase: 'ready', version: NEW, notes, installed: { ...notes, dismissed: false } });
  await expect(page.getByTestId('update-restart')).toHaveText('Restart now');
  await expect(page.getByTestId('update-channel-ready')).toHaveText(`${NEW} is installed and takes effect after a restart; later checks follow the chosen channel`);
  await expect(page.getByTestId('update-installed-line')).toContainText(`Last update: ${CUR} → ${NEW}`);
  expect(await chineseIn(page, SECTION)).toEqual([]);
  await page.getByTestId('back').click();
  await expect(page.getByTestId('update-ready')).toContainText(`Version ${NEW} is downloaded and takes effect after a restart.`);
  await expect(page.getByTestId('update-installed')).toContainText(`Updated from ${CUR} to ${NEW}.`);
  expect(await chineseIn(page, ['[data-testid="update-ready"]', '[data-testid="update-installed"]'])).toEqual([]);
  await app.close();
});

test('GitHub#473: the same section in Chinese reads as before', async () => {
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  app.desktop.setUpdate({ ...base, last: { ...failed, message: '下载 0.5.1 失败：网络中断（没收全）', said: { template: '下载 0.5.1 失败：{e_e}', parts: failed.said.parts } } });
  await expect(page.getByTestId('update-line')).toHaveText('下载 0.5.1 失败：网络中断（没收全）（14:02）');
  // an older shell without the marked form: its text as it came
  app.desktop.setUpdate({ ...base, last: { at, ok: true, message: '已是最新' } });
  await expect(page.getByTestId('update-line')).toHaveText('上次检查 14:02，已是最新');
  app.desktop.setUpdate({ ...base, phase: 'downloading', version: '0.5.1', got: 3_200_000, total: null, notes });
  await expect(page.getByTestId('update-line')).toHaveText('正在下载 0.5.1（3.2 MB）');
  await expect(page.getByTestId('update-notes-open')).toHaveText('查看更新内容（4 个版本）');
  await app.close();
});
