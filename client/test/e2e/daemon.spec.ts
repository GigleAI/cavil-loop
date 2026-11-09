// Settings → 本机 daemon (GitHub#314): the real window, the real back end, and
// the daemon's real scripts in a fake HOME with the fake scheduler
// (test/support/daemon-world.ts). Five states of the section — not installed,
// a tool missing, gh not signed in, all fine, unreadable — and the rule that
// stop / start / disconnect go out only after the confirmation, and that an
// unreadable job state offers neither stop nor start.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { addTool, appendLine, connect, daemonEnv, daemonWorld, installByHand, pathFor, pushDaemonChange, systemTool, wrapTool, type DaemonWorld, type Os } from '../support/daemon-world';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

let env: AppEnv;
let w: DaemonWorld;
const running: RunningApp[] = [];

test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-daemon-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  w = daemonWorld(join(dir, 'machine'));
});
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close()));
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

async function openSection(os: Os, path: string, extra?: Record<string, string>): Promise<{ app: RunningApp; page: Page }> {
  const app = await launchApp(env, { backendEnv: daemonEnv(w, { os, path, extra }) });
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
  await page.getByTestId('daemon-settings').scrollIntoViewIfNeeded();
  return { app, page };
}

const shot = (page: Page, name: string) => page.getByTestId('daemon-settings').screenshot({ path: join(screens, `daemon-${name}.png`) });
const sentDaemon = (app: RunningApp, cmd: string) => app.backend.sent.filter((c) => c.cmd === cmd);
const ldCalls = () => (existsSync(join(w.ld, 'calls')) ? readFileSync(join(w.ld, 'calls'), 'utf8').split('\n').filter((l) => /^(bootout|bootstrap) /.test(l)) : []);

test('not installed: says so, offers "安装", and installing shows the daemon', async () => {
  const { page } = await openSection('Darwin', pathFor(w));
  const sum = page.getByTestId('daemon-summary');
  await expect(sum).toHaveAttribute('data-state', 'missing');
  await expect(sum).toContainText('还没装 daemon');
  await expect(page.getByTestId('daemon-projects')).toHaveCount(0);
  await shot(page, '1-missing');
  await page.getByTestId('daemon-install').click();
  await expect(sum).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await expect(page.getByTestId('daemon-form')).toHaveText('手动更新');
  await expect(page.getByTestId('daemon-note').first()).toContainText('已从');
  expect(existsSync(join(w.skill, 'setup.sh'))).toBe(true);
});

test('a tool missing: listed with a command to copy; nothing is installed for the person', async () => {
  installByHand(w);
  const { app, page } = await openSection('Darwin', pathFor(w, { missing: ['tmux'] }));
  await expect(page.getByTestId('daemon-summary')).toHaveAttribute('data-state', 'ok');
  const row = page.locator('[data-testid=daemon-check][data-id="tool:tmux"]');
  await expect(row).toContainText('缺 tmux');
  await expect(row.getByTestId('daemon-command')).toHaveText('brew install tmux');
  await expect(page.locator('[data-testid=daemon-check][data-id=gh]')).toHaveAttribute('data-ok', 'true');
  await shot(page, '2-missing-tool');
  // only reads went out
  expect(new Set(app.backend.sent.filter((c) => c.cmd.startsWith('daemon')).map((c) => c.cmd))).toEqual(new Set(['daemonStatus']));
});

test('gh not signed in: says the daemon needs gh\'s own sign-in and gives "gh auth login"', async () => {
  installByHand(w);
  const { page } = await openSection('Darwin', pathFor(w), { FAKE_GH_AUTH: '1' });
  const row = page.locator('[data-testid=daemon-check][data-id=gh]');
  await expect(row).toHaveAttribute('data-ok', 'false');
  await expect(row.getByTestId('daemon-command')).toHaveText('gh auth login');
  await expect(page.locator('[data-testid=daemon-check][data-id=tools]')).toHaveAttribute('data-ok', 'true');
  await shot(page, '3-gh-signed-out');
});

test('all fine: the project row; stop, start and disconnect go out only after the confirmation', async () => {
  installByHand(w);
  const path = pathFor(w);
  connect(w, 'widget', 'Darwin', path);
  const { app, page } = await openSection('Darwin', path);
  const row = page.locator('[data-testid=daemon-project][data-key=widget]');
  await expect(row).toHaveAttribute('data-state', 'running');
  await expect(row).toContainText('acme/widget');
  await expect(row).toContainText('claude');
  await expect(page.locator('[data-testid=daemon-check][data-id=tools]')).toHaveAttribute('data-ok', 'true');
  await expect(row.getByTestId('daemon-start')).toHaveCount(0);
  await shot(page, '4-ok');

  // stop: the dialog first; "取消" sends nothing
  const before = ldCalls();
  await row.getByTestId('daemon-stop').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  expect(sentDaemon(app, 'daemonService')).toEqual([]);
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  expect(sentDaemon(app, 'daemonService')).toEqual([]);
  expect(ldCalls()).toEqual(before);

  await row.getByTestId('daemon-stop').click();
  await page.getByTestId('confirm-ok').click();
  await expect(row).toHaveAttribute('data-state', 'stopped');
  expect(sentDaemon(app, 'daemonService').map((c) => c.args)).toEqual([{ key: 'widget', action: 'stop' }]);
  expect(ldCalls().slice(before.length)).toEqual([expect.stringMatching(/^bootout gui\/\d+\/dev\.luosky\.cavil-loop\.widget$/)]);

  // start: offered now that it is stopped, again only after the confirmation
  await expect(row.getByTestId('daemon-stop')).toHaveCount(0);
  await row.getByTestId('daemon-start').click();
  expect(sentDaemon(app, 'daemonService')).toHaveLength(1);
  await page.getByTestId('confirm-ok').click();
  await expect(row).toHaveAttribute('data-state', 'running');
  expect(sentDaemon(app, 'daemonService').map((c) => c.args)).toEqual([
    { key: 'widget', action: 'stop' },
    { key: 'widget', action: 'start' },
  ]);

  // the log and the config are handed to the system, not shown in the window
  await row.getByTestId('daemon-config').click();
  await expect(row.getByTestId('daemon-note')).toContainText('已打开');

  // disconnect
  await row.getByTestId('daemon-disconnect').click();
  await expect(page.getByTestId('daemon-confirm-text')).toContainText('配置文件');
  expect(sentDaemon(app, 'daemonDisconnect')).toEqual([]);
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('daemon-projects-empty')).toBeVisible();
  expect(sentDaemon(app, 'daemonDisconnect').map((c) => c.args)).toEqual([{ key: 'widget' }]);
  expect(existsSync(join(w.home, '.config', 'cavil-loop', 'widget.conf'))).toBe(false);
});

test('unreadable: jq missing — the reason, the missing tools with commands, nothing else; after installing it "重新检查" shows the daemon', async () => {
  installByHand(w);
  const path = pathFor(w, { missing: ['jq'] });
  const { page } = await openSection('Darwin', path);
  const sum = page.getByTestId('daemon-summary');
  await expect(sum).toHaveAttribute('data-state', 'unreadable');
  await expect(page.getByTestId('daemon-reason')).toContainText('缺 jq');
  const row = page.locator('[data-testid=daemon-check][data-id="tool:jq"]');
  await expect(row).toContainText('缺 jq');
  await expect(row.getByTestId('daemon-command')).toHaveText('brew install jq');
  await expect(page.getByTestId('daemon-install')).toHaveCount(0);
  await expect(page.getByTestId('daemon-projects')).toHaveCount(0);
  await expect(page.getByTestId('daemon-stop')).toHaveCount(0);
  await expect(page.getByTestId('daemon-start')).toHaveCount(0);
  await shot(page, '5-unreadable');
  // the person installs jq, then checks again
  addTool(path, 'jq', systemTool('jq'));
  await page.getByTestId('daemon-recheck').click();
  await expect(sum).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('[data-testid=daemon-check][data-id=tools]')).toHaveAttribute('data-ok', 'true');
});

test('unreadable for another reason: its words and "重新检查", no checklist', async () => {
  installByHand(w);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(w.skill, 'scripts', 'install-status.sh'), '#!/usr/bin/env bash\necho boom >&2\nexit 5\n');
  const { page } = await openSection('Darwin', pathFor(w));
  await expect(page.getByTestId('daemon-summary')).toHaveAttribute('data-state', 'unreadable');
  await expect(page.getByTestId('daemon-reason')).toContainText('boom');
  await expect(page.getByTestId('daemon-checks')).toHaveCount(0);
  await expect(page.getByTestId('daemon-recheck')).toBeVisible();
});

test('update: a project refresh that stops half-way says "没有确认恢复", never "已恢复原样"; one that worked says so', async () => {
  installByHand(w);
  const path = pathFor(w);
  connect(w, 'widgeta', 'Darwin', path);
  connect(w, 'widgetb', 'Darwin', path);
  pushDaemonChange(w, (d) => appendLine(join(d, 'launchd', 'dev.luosky.cavil-loop.plist.template'), '<dict>', '    <!-- v2 {{KEY}} -->'));
  wrapTool(path, 'mktemp', 'case "$*" in *.restore.*) echo "mktemp: recovery file: No space left on device" >&2; exit 1;; esac\nexec "$REAL" "$@"');
  const { page } = await openSection('Darwin', path, { FAKE_LD_REJECT: 'v2 widgetb' });
  await page.getByTestId('daemon-update-run').click();
  await expect(page.getByTestId('daemon-update-result')).toHaveAttribute('data-result', 'updated', { timeout: 30_000 });
  const a = page.locator('[data-testid=daemon-refresh][data-key=widgeta]');
  const b = page.locator('[data-testid=daemon-refresh][data-key=widgetb]');
  await expect(a).toHaveAttribute('data-result', 'replaced');
  await expect(a).toContainText('已换新');
  await expect(b).toHaveAttribute('data-result', 'unconfirmed');
  await expect(b).toContainText('没有确认恢复');
  await expect(b).not.toContainText('已恢复原样');
  await expect(b).toContainText('No space left on device');
  await shot(page, '7-update-unconfirmed');
});

test('a job whose state cannot be read: "读不到", and neither stop nor start is offered', async () => {
  installByHand(w);
  const path = pathFor(w);
  connect(w, 'widget', 'Darwin', path);
  const { page } = await openSection('Darwin', path, { FAKE_LD_PRINT: 'fail' });
  const row = page.locator('[data-testid=daemon-project][data-key=widget]');
  await expect(row).toHaveAttribute('data-state', 'unknown');
  await expect(row.getByTestId('daemon-project-state')).toHaveText('读不到');
  await expect(row.getByTestId('daemon-stop')).toHaveCount(0);
  await expect(row.getByTestId('daemon-start')).toHaveCount(0);
  await shot(page, '6-job-unknown');
});
