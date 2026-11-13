// Settings → 本机 daemon → a project's "配置" (GitHub#388): the real window, the
// real back end and the daemon's real scripts/project-config.sh in a fake HOME,
// on a project the real setup.sh connected. What a save did is read from the
// config file on disk.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { connect, daemonEnv, daemonWorld, dropWorlds, installByHand, pathFor, type DaemonWorld } from '../support/daemon-world';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

let env: AppEnv;
let w: DaemonWorld;
let config: string;
const running: RunningApp[] = [];

test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-config-'));
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

/** Connect "widget" with the real setup.sh, sign in, open settings at the daemon section. */
async function openSection(prepare?: () => void): Promise<{ app: RunningApp; page: Page }> {
  const path = pathFor(w);
  const host = connect(w, 'widget', 'Darwin', path);
  config = join(host, 'cavil-loop.config');
  prepare?.();
  const app = await launchApp(env, { backendEnv: daemonEnv(w, { os: 'Darwin', path }) });
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
  await expect(page.locator('[data-testid=daemon-project][data-key=widget]')).toBeVisible();
  return { app, page };
}

const openDialog = async (page: Page) => {
  await page.locator('[data-testid=daemon-project][data-key=widget]').getByTestId('daemon-config').click();
  await expect(page.getByTestId('config-dialog')).toHaveAttribute('data-phase', 'form');
};
const row = (page: Page, name: string) => page.locator(`[data-testid=config-row][data-name=${name}]`);
const input = (page: Page, name: string) => page.getByTestId(`config-input-${name}`);
const shot = (page: Page, name: string) => page.locator('.modal.pcfg').screenshot({ path: join(screens, `config-${name}.png`) });
const sent = (app: RunningApp, cmd: string) => app.backend.sent.filter((c) => c.cmd === cmd);
const lines = (name: string) => readFileSync(config, 'utf8').split('\n').filter((l) => l.startsWith(`${name}=`));

test('the form shows the config\'s values; changing two and saving writes exactly those, and says what changed', async () => {
  const { app, page } = await openSection();
  const before = readFileSync(config, 'utf8');
  await openDialog(page);
  await expect(page.getByTestId('config-path')).toHaveText(config);
  await expect(page.getByTestId('config-intro')).toContainText('不要同时在编辑器里改这个文件');
  await expect(page.getByTestId('config-group').first()).toHaveAttribute('data-title', 'agent 与模型');
  await expect(input(page, 'WORKER_AGENT')).toHaveValue('claude');
  await expect(input(page, 'MAX_CONCURRENT_WORKERS')).toHaveValue('1');
  await expect(input(page, 'OUTPUT_LANGUAGE')).toHaveValue('en');
  await expect(input(page, 'COMMENT_FOOTER')).toHaveAttribute('data-on', 'true');
  await expect(input(page, 'REVIEW_DESIGN_PROPOSALS')).toHaveAttribute('data-on', 'false');
  // nothing typed yet: nothing to save
  await expect(page.getByTestId('config-save')).toBeDisabled();
  await shot(page, '1-form');

  await input(page, 'WORKER_AGENT').selectOption('codex');
  await input(page, 'MAX_CONCURRENT_WORKERS').fill('2');
  await expect(row(page, 'WORKER_AGENT')).toHaveAttribute('data-changed', 'true');
  await expect(row(page, 'WORKER_AGENT').getByTestId('config-was')).toHaveText('原来：claude');
  await expect(row(page, 'MAX_CONCURRENT_WORKERS').getByTestId('config-was')).toHaveText('原来：1');
  await expect(page.getByTestId('config-pending')).toHaveText('已改 2 项，还没保存');
  await shot(page, '2-changed');
  // nothing is sent before "保存"
  expect(sent(app, 'daemonConfigSet')).toEqual([]);
  expect(readFileSync(config, 'utf8')).toBe(before);

  await page.getByTestId('config-save').click();
  const result = page.getByTestId('config-result');
  await expect(result).toHaveAttribute('data-kind', 'saved');
  await expect(result).toContainText('已保存 2 项');
  await expect(page.locator('[data-testid=config-change][data-name=WORKER_AGENT]')).toContainText('claude');
  await expect(page.locator('[data-testid=config-change][data-name=WORKER_AGENT]')).toContainText('codex');
  await expect(page.locator('[data-testid=config-change][data-name=MAX_CONCURRENT_WORKERS]')).toContainText('2');
  expect(sent(app, 'daemonConfigSet').map((c) => (c.args as { values: unknown }).values)).toEqual([{ WORKER_AGENT: 'codex', MAX_CONCURRENT_WORKERS: '2' }]);
  // on disk: those two lines, nothing else
  expect(lines('WORKER_AGENT')).toEqual(['WORKER_AGENT="codex"']);
  expect(lines('MAX_CONCURRENT_WORKERS')).toEqual(['MAX_CONCURRENT_WORKERS=2']);
  const a = before.split('\n');
  expect(readFileSync(config, 'utf8').split('\n').filter((l, i) => l !== a[i]).length).toBe(2);
  // the backup shown is the pre-save file
  const backup = (await page.getByTestId('config-backup').textContent())!;
  expect(readFileSync(backup, 'utf8')).toBe(before);
  // codex is not installed on this machine: said, with a command to copy
  await expect(page.getByTestId('config-missing')).toContainText('codex');
  await expect(page.getByTestId('config-missing').getByTestId('daemon-command')).toHaveText('npm install -g @openai/codex');
  await shot(page, '3-saved');

  await page.getByTestId('config-close').click();
  await expect(page.getByTestId('config-dialog')).toHaveCount(0);
  await expect(page.locator('[data-testid=daemon-project][data-key=widget]')).toContainText('codex');
});

test('a value that does not fit is marked, "保存" stays off and nothing is sent; fixing it saves', async () => {
  const { app, page } = await openSection();
  const before = readFileSync(config, 'utf8');
  await openDialog(page);
  await input(page, 'MAX_CONCURRENT_WORKERS').fill('99');
  await expect(row(page, 'MAX_CONCURRENT_WORKERS')).toHaveAttribute('data-bad', 'true');
  await expect(row(page, 'MAX_CONCURRENT_WORKERS').getByTestId('config-problem')).toHaveText('只能是 1 到 16 之间的整数');
  await input(page, 'WORKER_MODEL').fill('$(id)');
  await expect(row(page, 'WORKER_MODEL')).toHaveAttribute('data-bad', 'true');
  await expect(page.getByTestId('config-problems')).toHaveText('有 2 项填得不对，改好才能保存');
  await expect(page.getByTestId('config-save')).toBeDisabled();
  await shot(page, '4-invalid');
  await page.keyboard.press('ControlOrMeta+Enter');
  expect(sent(app, 'daemonConfigSet')).toEqual([]);
  expect(readFileSync(config, 'utf8')).toBe(before);

  await input(page, 'MAX_CONCURRENT_WORKERS').fill('3');
  await input(page, 'WORKER_MODEL').fill('');
  await expect(page.getByTestId('config-pending')).toHaveText('已改 1 项，还没保存');
  await page.getByTestId('config-save').click();
  await expect(page.getByTestId('config-result')).toHaveAttribute('data-kind', 'saved');
  expect(lines('MAX_CONCURRENT_WORKERS')).toEqual(['MAX_CONCURRENT_WORKERS=3']);
});

test('the file was edited elsewhere while the dialog was open: nothing is written; "重新读取" keeps what was typed', async () => {
  const { page } = await openSection();
  await openDialog(page);
  await input(page, 'MAX_CONCURRENT_WORKERS').fill('2');
  // an editor stores the file meanwhile
  writeFileSync(config, readFileSync(config, 'utf8').replace('REVIEW_MAX_ROUNDS=6', 'REVIEW_MAX_ROUNDS=9'));
  const outside = readFileSync(config, 'utf8');
  expect(outside).toContain('REVIEW_MAX_ROUNDS=9');
  await page.getByTestId('config-save').click();
  const result = page.getByTestId('config-result');
  await expect(result).toHaveAttribute('data-kind', 'conflict');
  await expect(result).toContainText('没有保存，配置文件一个字都没动');
  await expect(page.getByTestId('config-sent')).toContainText('同时最多几个 worker → 2');
  expect(readFileSync(config, 'utf8')).toBe(outside);
  await shot(page, '5-conflict');

  await page.getByTestId('config-reload').click();
  await expect(page.getByTestId('config-dialog')).toHaveAttribute('data-phase', 'form');
  // the outside edit is what the form shows now, and the typed change is still there
  await expect(input(page, 'REVIEW_MAX_ROUNDS')).toHaveValue('9');
  await expect(input(page, 'MAX_CONCURRENT_WORKERS')).toHaveValue('2');
  await page.getByTestId('config-save').click();
  await expect(page.getByTestId('config-result')).toHaveAttribute('data-kind', 'saved');
  expect(lines('MAX_CONCURRENT_WORKERS')).toEqual(['MAX_CONCURRENT_WORKERS=2']);
  expect(lines('REVIEW_MAX_ROUNDS')).toEqual(['REVIEW_MAX_ROUNDS=9']);
});

test('what cannot be changed here has no input: arithmetic and a line inside a condition say why and show the value in effect; a missing line is marked; the four switches are shown only', async () => {
  const { page } = await openSection(() => {
    const t = readFileSync(config, 'utf8');
    expect(t).toContain('\nBLOCKED_RECHECK_SECS=300\n');
    expect(t).toContain('\nPOLL_IDLE_PROBE=true\n');
    expect(t).toContain('\nMAX_CONCURRENT_WORKERS=1\n');
    writeFileSync(
      config,
      t
        .replace('\nBLOCKED_RECHECK_SECS=300\n', '\nBLOCKED_RECHECK_SECS=$((5 * 60))\n')
        .replace('\nPOLL_IDLE_PROBE=true\n', '\n')
        // inside a condition that does not run, not indented: the daemon works with its default (1), and the line is not for the form to change
        .replace('\nMAX_CONCURRENT_WORKERS=1\n', '\nif false; then\nMAX_CONCURRENT_WORKERS=2\nfi\n'),
    );
  });
  await openDialog(page);
  const cond = row(page, 'MAX_CONCURRENT_WORKERS');
  await expect(cond).toHaveAttribute('data-editable', 'false');
  await expect(cond.getByTestId('config-readonly')).toHaveText('1');
  await expect(cond.getByTestId('config-why')).toContainText('条件');
  await expect(input(page, 'MAX_CONCURRENT_WORKERS')).toHaveCount(0);
  const calc = row(page, 'BLOCKED_RECHECK_SECS');
  await expect(calc).toHaveAttribute('data-editable', 'false');
  await expect(calc.getByTestId('config-readonly')).toHaveText('300');
  await expect(calc.getByTestId('config-why')).toContainText('算式');
  await expect(input(page, 'BLOCKED_RECHECK_SECS')).toHaveCount(0);
  const absent = row(page, 'POLL_IDLE_PROBE');
  await expect(absent.getByTestId('config-absent')).toBeVisible();
  await expect(input(page, 'POLL_IDLE_PROBE')).toHaveAttribute('data-on', 'true');
  for (const name of ['DISPATCH_MODE', 'LABEL_PENDING_REVIEW', 'LABEL_AUTOPILOT', 'LABEL_PENDING_BLOCKED']) {
    await expect(row(page, name)).toHaveAttribute('data-editable', 'false');
    await expect(input(page, name)).toHaveCount(0);
  }
  await expect(row(page, 'LABEL_AUTOPILOT').getByTestId('config-readonly')).toHaveText('关');
  await expect(row(page, 'LABEL_PENDING_BLOCKED').getByTestId('config-readonly')).toHaveText('开，标签 pending/blocked');
  await expect(row(page, 'DISPATCH_MODE').getByTestId('config-readonly')).toHaveText('只派打了标签的（label）');
  await row(page, 'DISPATCH_MODE').scrollIntoViewIfNeeded();
  await shot(page, '6-readonly');
  // nowhere in the dialog: commands, hooks, the token
  const text = (await page.getByTestId('config-dialog').textContent())!;
  for (const s of ['WORKTREE_SETUP_CMD', 'npm ci', 'GH_TOKEN', 'dangerously']) expect(text).not.toContain(s);

  // saving the setting the file did not have appends its line
  await input(page, 'POLL_IDLE_PROBE').click();
  await page.getByTestId('config-save').click();
  await expect(page.getByTestId('config-result')).toHaveAttribute('data-kind', 'saved');
  expect(lines('POLL_IDLE_PROBE')).toEqual(['POLL_IDLE_PROBE="false"']);
  expect(lines('BLOCKED_RECHECK_SECS')).toEqual(['BLOCKED_RECHECK_SECS=$((5 * 60))']);
  expect(lines('MAX_CONCURRENT_WORKERS')).toEqual(['MAX_CONCURRENT_WORKERS=2']);
});

test('a config that does not load shows no values at all; "用编辑器打开配置文件" still hands the file to the system', async () => {
  const { page } = await openSection(() => writeFileSync(config, readFileSync(config, 'utf8') + 'if then fi (\n'));
  await page.locator('[data-testid=daemon-project][data-key=widget]').getByTestId('daemon-config').click();
  await expect(page.getByTestId('config-dialog')).toHaveAttribute('data-phase', 'failed');
  await expect(page.getByTestId('config-read-failed')).toContainText('读不出这个项目的配置');
  await expect(page.getByTestId('config-row')).toHaveCount(0);
  await expect(page.getByTestId('config-save')).toHaveCount(0);
  await page.getByTestId('config-open-editor').click();
  await expect.poll(() => (existsSync(env.opened!) ? readFileSync(env.opened!, 'utf8') : '')).toContain(`file:config:${config}`);
});

test('a daemon from before the config script: "配置" opens the editor as before and says an update brings the form', async () => {
  const { app, page } = await openSection(() => rmSync(join(w.skill, 'scripts', 'project-config.sh')));
  const r = page.locator('[data-testid=daemon-project][data-key=widget]');
  await r.getByTestId('daemon-config').click();
  await expect(r.getByTestId('daemon-note')).toContainText('已用编辑器打开');
  await expect(r.getByTestId('daemon-note')).toContainText('更新 daemon');
  await expect(page.getByTestId('config-dialog')).toHaveCount(0);
  expect(sent(app, 'daemonConfigSet')).toEqual([]);
  await expect.poll(() => (existsSync(env.opened!) ? readFileSync(env.opened!, 'utf8') : '')).toContain(`file:config:${config}`);
});

test('Esc does not throw typed changes away; "取消" does, and nothing is written', async () => {
  const { app, page } = await openSection();
  const before = readFileSync(config, 'utf8');
  await openDialog(page);
  await input(page, 'MAX_CONCURRENT_WORKERS').fill('4');
  await page.locator('.pcfg-head').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('config-dialog')).toBeVisible();
  await expect(page.getByTestId('dialog-esc-hint')).toBeVisible();
  await page.getByTestId('config-cancel').click();
  await expect(page.getByTestId('config-dialog')).toHaveCount(0);
  expect(sent(app, 'daemonConfigSet')).toEqual([]);
  expect(readFileSync(config, 'utf8')).toBe(before);
});
