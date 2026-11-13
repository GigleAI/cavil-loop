// GitHub#473: the local daemon's parts of the window in English — Settings → 本机 daemon, "接上 daemon"
// and a project's "配置" — with the real window, the real back end and the daemon's real scripts in a
// fake HOME (test/support/daemon-world.ts). What the daemon's scripts say is Chinese (setup.sh's
// output, the settings' names from scripts/config-fields.txt, a config that does not load): it is
// shown as written, while every title, button, explanation and error prefix around it is English.
// The run-time language check (langCheck.ts) scans each of these regions.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { connect, daemonEnv, daemonWorld, dropWorlds, githubRewrite, installByHand, localCopy, pathFor, type DaemonWorld, type Os } from '../support/daemon-world';
import { chineseIn } from './langCheck';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const REPO = 'GigleAI/cavil-loop';
let env: AppEnv;
let w: DaemonWorld;
const running: RunningApp[] = [];

test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-i18n-daemon-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  w = daemonWorld(join(dir, 'machine'));
  installByHand(w);
});
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close()));
  await env.fake.close();
  dropWorlds();
});
test.afterAll(async () => {
  await closeEngine();
});

/** sign in, add the repository, switch to English, wait for the daemon section */
async function openEnglish(os: Os, path: string, extra: Record<string, string> = {}): Promise<{ app: RunningApp; page: Page }> {
  const app = await launchApp(env, { backendEnv: daemonEnv(w, { os, path, extra: { FAKE_GH_REPO: REPO, ...githubRewrite(w), ...extra } }) });
  running.push(app);
  const page = app.page;
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await page.getByTestId('lang-en').check();
  await expect(page.locator('.settings .toolbar h2')).toHaveText('Settings');
  await page.getByTestId('source-input').fill(REPO);
  await page.getByTestId('source-add').click();
  await expect(page.getByTestId('source-row')).toHaveCount(1);
  await expect(page.getByTestId('daemon-summary')).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  return { app, page };
}

/** the local daemon section, its heading included */
const SECTION = ['#set-daemon'];
/** inside it but migrated with the remote daemon (another part of #473): this machine's remote entry */
const LATER = ['[data-testid="local-remote"]'];

test("GitHub#473: Settings → local daemon in English — the projects table, the checklist and the stop confirmation; this machine's names as written", async () => {
  const path = pathFor(w);
  connect(w, 'widget', 'Linux', path);
  const { page } = await openEnglish('Linux', path);
  const section = page.locator('#set-daemon');
  await section.scrollIntoViewIfNeeded();
  await expect(section.locator('h3').first()).toHaveText('Local daemon');
  await expect(page.getByTestId('daemon-recheck')).toHaveText('Check again');
  await expect(page.getByTestId('daemon-form')).toHaveText(/updated by hand|updates itself|cannot be updated here/);
  const row = page.locator('[data-testid=daemon-project][data-key=widget]');
  await expect(row.getByTestId('daemon-log')).toHaveText('Log');
  await expect(row.getByTestId('daemon-config')).toHaveText('Settings…');
  await expect(page.getByTestId('daemon-check').first()).toContainText(/All common tools are there|Missing/);
  expect(await chineseIn(page, SECTION, LATER)).toEqual([]);
  // the stop confirmation: its title names the project as written, the rest is English
  await row.getByTestId('daemon-stop').click();
  await expect(page.locator('.modal h3')).toHaveText('Stop the background polling of widget?');
  await expect(page.getByTestId('daemon-confirm-text')).toContainText('Once stopped, the daemon no longer reads GitHub');
  // (its two buttons are the confirm dialog's own, migrated with the dialogs in sub-issue ② #472)
  expect(await chineseIn(page, ['.modal h3', '[data-testid="daemon-confirm-text"]'])).toEqual([]);
  await page.getByTestId('confirm-cancel').click();
  await section.screenshot({ path: join(screens, '473-daemon-en.png') });
});

test('GitHub#473: "接上 daemon" in English — setup.sh\'s Chinese output shown as written, the dialog around it English', async () => {
  const host = localCopy(join(w.home, 'github', 'cavil-loop'), 'https://github.com/GigleAI/cavil-loop.git');
  const { page } = await openEnglish('Linux', pathFor(w));
  const row = page.locator(`[data-testid=source-row][data-key="repo:gigleai/cavil-loop"]`);
  await expect(row.getByTestId('connect-open')).toHaveText('Connect daemon');
  await row.getByTestId('connect-open').click();
  const dlg = page.getByTestId('connect-dialog');
  await expect(dlg.locator('h3')).toHaveText(`Connect ${REPO} to the local daemon`);
  await expect(dlg.getByTestId('connect-dir')).toHaveValue(host);
  await expect(dlg.getByTestId('connect-dir-check')).toHaveText(`Usable: ${host}`);
  await expect(dlg.getByTestId('connect-precheck')).toHaveAttribute('data-ready', 'true');
  await expect(dlg.getByTestId('connect-start')).toHaveText('Start');
  expect(await chineseIn(page, ['[data-testid="connect-dialog"]'])).toEqual([]);
  await dlg.getByTestId('connect-start').click();
  const res = dlg.getByTestId('connect-result');
  await expect(res).toHaveAttribute('data-result', 'connected', { timeout: 60_000 });
  await expect(res).toContainText('Connected: cavil-loop (background polling running)');
  const out = dlg.getByTestId('connect-output');
  // setup.sh's own words, as it printed them
  await expect(out).toContainText('依赖齐全');
  await expect(out).toContainText('setup 完成');
  await expect(out.locator('[data-verbatim="daemon"]').first()).toBeVisible();
  // the client's own lines in the same box are English (the command line is a command, as written)
  await expect(out).toContainText(`$ WORKER_AGENT=claude bash ${w.skill}/setup.sh --yes ${host} cavil-loop`);
  await expect(dlg.getByTestId('connect-close')).toHaveText('Close');
  expect(await chineseIn(page, ['[data-testid="connect-dialog"]'])).toEqual([]);
  await dlg.locator('.modal').screenshot({ path: join(screens, '473-connect-en.png') });
});

test('GitHub#473: "接上 daemon" fails in English — the failure explained in English, git\'s / setup.sh\'s words as written', async () => {
  localCopy(join(w.home, 'github', 'cavil-loop'), 'https://github.com/GigleAI/cavil-loop.git');
  const { page } = await openEnglish('Darwin', pathFor(w), { FAKE_LD_BOOTSTRAP: 'fail' });
  await page.locator(`[data-testid=source-row][data-key="repo:gigleai/cavil-loop"]`).getByTestId('connect-open').click();
  const dlg = page.getByTestId('connect-dialog');
  await expect(dlg.getByTestId('connect-precheck')).toHaveAttribute('data-ready', 'true');
  await expect(dlg.getByTestId('connect-dir-check')).toHaveAttribute('data-ok', 'true');
  await dlg.getByTestId('connect-start').click();
  await expect(dlg.getByTestId('connect-result')).toHaveAttribute('data-result', 'failed', { timeout: 60_000 });
  await expect(dlg.getByTestId('connect-failure')).toHaveText('setup.sh did not succeed (exit code 5); not connected');
  await expect(dlg.getByTestId('connect-output')).toContainText('Bootstrap failed: 5: Input/output error');
  expect(await chineseIn(page, ['[data-testid="connect-dialog"]'])).toEqual([]);
});

test('GitHub#473: a project\'s settings in English — the settings\' Chinese names from the daemon shown as written, the form around them English; a config that does not load', async () => {
  const path = pathFor(w);
  const host = connect(w, 'widget', 'Linux', path);
  const { page } = await openEnglish('Linux', path);
  const row = page.locator('[data-testid=daemon-project][data-key=widget]');
  await row.getByTestId('daemon-config').click();
  const dlg = page.getByTestId('config-dialog');
  await expect(dlg).toHaveAttribute('data-phase', 'form');
  await expect(dlg.locator('h3')).toHaveText('Project settings: widget');
  await expect(dlg.getByTestId('config-open-editor')).toHaveText('Open the config file in an editor');
  await expect(dlg.getByTestId('config-save')).toHaveText('Save');
  // the daemon's own names for its settings (scripts/config-fields.txt) are Chinese, shown as written
  const names = await dlg.locator('[data-testid=config-row] .what b [data-verbatim=daemon]').allTextContents();
  expect(names.length).toBeGreaterThan(3);
  expect(names.some((n) => /[一-鿿]/.test(n))).toBe(true);
  expect(await chineseIn(page, ['[data-testid="config-dialog"]'])).toEqual([]);
  await dlg.locator('.modal').screenshot({ path: join(screens, '473-config-en.png') });
  await dlg.getByTestId('config-cancel').click();
  await expect(dlg).toHaveCount(0);

  // a config that does not load: the script's reason as written, the client's words around it English
  const config = join(host, 'cavil-loop.config');
  writeFileSync(config, readFileSync(config, 'utf8') + 'if then fi (\n');
  await row.getByTestId('daemon-config').click();
  await expect(dlg).toHaveAttribute('data-phase', 'failed');
  await expect(dlg.getByTestId('config-read-failed')).toContainText("This project's config cannot be read, so no values are shown here");
  await expect(dlg.getByTestId('config-reload')).toHaveText('Read again');
  expect(await chineseIn(page, ['[data-testid="config-dialog"]'])).toEqual([]);
});
