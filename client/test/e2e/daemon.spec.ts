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
import { addTool, appendLine, connect, daemonEnv, daemonWorld, installByHand, installOld, pathFor, plainOldCopy, pushDaemonChange, systemTool, wrapTool, type DaemonWorld, type Os } from '../support/daemon-world';

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

  // "配置" is a form now (GitHub#388, test/e2e/daemon-config.spec.ts); its "用编辑器打开配置文件" still hands the file to the system
  await row.getByTestId('daemon-config').click();
  await expect(page.getByTestId('config-dialog')).toHaveAttribute('data-phase', 'form');
  await page.getByTestId('config-open-editor').click();
  await expect(row.getByTestId('daemon-note')).toContainText('已打开');
  await page.getByTestId('config-cancel').click();
  await expect(page.getByTestId('config-dialog')).toHaveCount(0);

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

test('GitHub#357: "cannot read the daemon" is red; while "重新检查" reads again it is that read running (blue, spinner), red again when it fails too', async () => {
  installByHand(w);
  const { writeFileSync } = await import('node:fs');
  // slow enough to look at the bar while the read runs
  writeFileSync(join(w.skill, 'scripts', 'install-status.sh'), '#!/usr/bin/env bash\nsleep 2\necho boom >&2\nexit 5\n');
  const { page } = await openSection('Darwin', pathFor(w));
  const bar = page.getByTestId('daemon-unreadable');
  await expect(bar).toHaveAttribute('data-kind', 'error', { timeout: 15_000 });
  await expect(bar).toHaveClass(/\berror\b/);
  await expect(bar.locator('.spin')).toHaveCount(0);
  await page.getByTestId('daemon-recheck').click();
  await expect(bar).toHaveAttribute('data-kind', 'busy');
  await expect(bar).toHaveClass(/\bbusy\b/);
  await expect(bar.locator('.spin')).toHaveCount(1);
  await expect(bar).toContainText('正在重新检查');
  await expect(bar).toHaveAttribute('data-kind', 'error', { timeout: 15_000 });
  await expect(bar).not.toContainText('正在重新检查');
  await expect(page.getByTestId('daemon-reason')).toContainText('boom');
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

test('update: the job cannot be read after unloading and loading back fails — the row says a person is needed, not "已恢复原样"', async () => {
  installByHand(w);
  const path = pathFor(w);
  connect(w, 'widgeta', 'Darwin', path);
  pushDaemonChange(w, (d) => appendLine(join(d, 'launchd', 'dev.luosky.cavil-loop.plist.template'), '<dict>', '    <!-- v2 {{KEY}} -->'));
  wrapTool(path, 'launchctl', 'if [ "${1:-}" = print ] && [ -f "$FAKE_LD/after-bootout" ]; then echo "launchctl: connection unavailable" >&2; exit 1; fi\n[ "${1:-}" = bootout ] && touch "$FAKE_LD/after-bootout"\nexec "$REAL" "$@"');
  const { page } = await openSection('Darwin', path, { FAKE_LD_BOOTSTRAP: 'fail' });
  await page.getByTestId('daemon-update-run').click();
  await expect(page.getByTestId('daemon-update-result')).toHaveAttribute('data-result', 'updated', { timeout: 30_000 });
  const a = page.locator('[data-testid=daemon-refresh][data-key=widgeta]');
  await expect(a).toHaveAttribute('data-result', 'needs_human');
  await expect(a).toContainText('需要人处理');
  await expect(a).not.toContainText('已恢复原样');
  await expect(a).toContainText('connection unavailable');
  await shot(page, '8-update-needs-human');
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

// GitHub#320: a daemon from before the status script.
test('a daemon too old for the status script: a checkout gets "更新 daemon", and after it the section shows the daemon', async () => {
  installOld(w);
  const { page } = await openSection('Darwin', pathFor(w));
  const sum = page.getByTestId('daemon-summary');
  await expect(sum).toHaveAttribute('data-state', 'unreadable');
  await expect(page.getByTestId('daemon-reason')).toContainText('版本太旧');
  await expect(page.getByTestId('daemon-reason')).not.toContainText('git -C');
  await expect(page.getByTestId('daemon-outdated')).toHaveAttribute('data-form', 'checkout');
  await shot(page, '8-outdated-checkout');
  await page.getByTestId('daemon-update-run').click();
  // checked again by itself: the daemon is read now, and the result stays visible under it
  await expect(sum).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await expect(page.getByTestId('daemon-update-result')).toHaveAttribute('data-result', 'updated');
  await expect(page.getByTestId('daemon-version')).not.toHaveText('读不出');
  await shot(page, '9-outdated-updated');
});

test('a daemon too old for the status script on a branch that still has none: pulled, says why with the branch, still unreadable', async () => {
  const old = installOld(w, 'oldline');
  const { page } = await openSection('Darwin', pathFor(w));
  await expect(page.getByTestId('daemon-outdated')).toHaveAttribute('data-form', 'checkout');
  await page.getByTestId('daemon-update-run').click();
  const res = page.getByTestId('daemon-update-result');
  await expect(res).toHaveAttribute('data-result', 'still_old', { timeout: 30_000 });
  await expect(page.getByTestId('daemon-update-branch')).toHaveText('oldline');
  await expect(res).toContainText('已拉取');
  await expect(res).toContainText(old.slice(0, 12));
  await expect(res).toContainText('没有状态脚本');
  await expect(res).not.toContainText('没有更新');
  await expect(res).not.toContainText('已更新');
  await expect(res).not.toContainText('换到');
  // checked again by itself: still unreadable, never shown as a working daemon
  await expect(page.getByTestId('daemon-summary')).toHaveAttribute('data-state', 'unreadable');
  await expect(page.getByTestId('daemon-version')).toHaveCount(0);
  await shot(page, '12-outdated-still-old');
});

test('a daemon too old for the status script, already on main whose origin is old too: pulled, still unreadable, no advice to switch to main', async () => {
  const old = installOld(w, 'main', { originOld: true });
  const { page } = await openSection('Darwin', pathFor(w));
  await page.getByTestId('daemon-update-run').click();
  const res = page.getByTestId('daemon-update-result');
  await expect(res).toHaveAttribute('data-result', 'still_old', { timeout: 30_000 });
  await expect(page.getByTestId('daemon-update-branch')).toHaveText('main');
  await expect(res).toContainText('已拉取');
  await expect(res).toContainText(old.slice(0, 12));
  await expect(res).toContainText('Fast-forward');
  await expect(res).not.toContainText('换到');
  await expect(page.getByTestId('daemon-summary')).toHaveAttribute('data-state', 'unreadable');
  // the checkout really moved
  const { execFileSync } = await import('node:child_process');
  expect(execFileSync('git', ['-C', w.skill, 'rev-parse', 'HEAD']).toString().trim()).not.toBe(old);
});

test('a daemon too old for the status script, not a checkout: no button; managed does not guess why, a plain folder promises no waiting', async () => {
  // managed release
  const rel = plainOldCopy(w, join(w.home, '.agents', 'releases', 'cavil-loop', 'releases', 'abc123'));
  mkdirSync(dirname(w.skill), { recursive: true });
  const { symlinkSync, rmSync } = await import('node:fs');
  symlinkSync(rel, w.skill);
  const { page } = await openSection('Linux', pathFor(w));
  const box = page.getByTestId('daemon-outdated');
  await expect(box).toHaveAttribute('data-form', 'managed');
  await expect(box).toContainText('原因客户端判断不了');
  await expect(box).not.toContainText('说明 daemon 的定时任务没在跑');
  await expect(page.getByTestId('daemon-update-run')).toHaveCount(0);
  await shot(page, '10-outdated-managed');

  // a plain folder, through a link
  rmSync(w.skill);
  symlinkSync(plainOldCopy(w, join(w.dir, 'plain', 'daemon')), w.skill);
  await page.getByTestId('daemon-recheck').click();
  await expect(box).toHaveAttribute('data-form', 'directory');
  await expect(box).toContainText('不会自己更新');
  for (const promise of ['重新检查', '等几分钟', '稍后', '重新安装', '点「安装」', '点『安装』', '移走']) await expect(box).not.toContainText(promise);
  await expect(page.getByTestId('daemon-update-run')).toHaveCount(0);
  await shot(page, '11-outdated-directory');

  // cannot tell: a .git that git does not confirm
  mkdirSync(join(w.dir, 'plain', 'daemon', '.git'));
  await page.getByTestId('daemon-recheck').click();
  await expect(box).toHaveAttribute('data-form', 'unknown');
  await expect(page.getByTestId('daemon-outdated-error')).toContainText('git 没有确认');
  await expect(page.getByTestId('daemon-update-run')).toHaveCount(0);
});
