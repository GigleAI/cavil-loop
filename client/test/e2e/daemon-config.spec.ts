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
// GitHub#523: reading and saving run the real config script (bash parses the file, compares fingerprints, rewrites
// it); on a loaded machine that takes longer than the default 5 s. Waits for what the script answered get this
// limit — the condition is the same, the wait ends as soon as the answer is on screen.
const SCRIPT = { timeout: 30_000 };
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
  await expect(page.getByTestId('config-dialog')).toHaveAttribute('data-phase', 'form', SCRIPT);
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
  await expect(result).toHaveAttribute('data-kind', 'saved', SCRIPT);
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
  await expect(page.getByTestId('config-result')).toHaveAttribute('data-kind', 'saved', SCRIPT);
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
  await expect(result).toHaveAttribute('data-kind', 'conflict', SCRIPT);
  await expect(result).toContainText('没有保存，配置文件一个字都没动');
  await expect(page.getByTestId('config-sent')).toContainText('同时最多几个 worker → 2');
  expect(readFileSync(config, 'utf8')).toBe(outside);
  await shot(page, '5-conflict');

  await page.getByTestId('config-reload').click();
  await expect(page.getByTestId('config-dialog')).toHaveAttribute('data-phase', 'form', SCRIPT);
  // the outside edit is what the form shows now, and the typed change is still there
  await expect(input(page, 'REVIEW_MAX_ROUNDS')).toHaveValue('9');
  await expect(input(page, 'MAX_CONCURRENT_WORKERS')).toHaveValue('2');
  await page.getByTestId('config-save').click();
  await expect(page.getByTestId('config-result')).toHaveAttribute('data-kind', 'saved', SCRIPT);
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
  await expect(page.getByTestId('config-result')).toHaveAttribute('data-kind', 'saved', SCRIPT);
  expect(lines('POLL_IDLE_PROBE')).toEqual(['POLL_IDLE_PROBE="false"']);
  expect(lines('BLOCKED_RECHECK_SECS')).toEqual(['BLOCKED_RECHECK_SECS=$((5 * 60))']);
  expect(lines('MAX_CONCURRENT_WORKERS')).toEqual(['MAX_CONCURRENT_WORKERS=2']);
});

test('flow labels, label lists, a branch and a field name are read-only plain text in their topic groups; the numbers, agent and model registered with them can be changed (GitHub#555)', async () => {
  const { page } = await openSection();
  await openDialog(page);
  const groupOf = async (name: string) => (await page.locator('[data-testid=config-group]').filter({ has: row(page, name) }).getAttribute('data-title'))!;
  expect(await groupOf('LABEL_AGENT_DOING')).toBe('流程标签');
  expect(await groupOf('LABEL_PENDING_AGENT')).toBe('流程标签');
  expect(await groupOf('GREEDY_SCAN_LIMIT')).toBe('派工挑选');
  expect(await groupOf('PRIORITY_SOURCE')).toBe('派工挑选');
  expect(await groupOf('FABLE_MODEL')).toBe('agent 与模型');
  expect(await groupOf('AUTOPILOT_MERGE_METHOD')).toBe('托管（自动合并）');
  expect(await groupOf('CI_FAILURE_REPORT_BRANCH')).toBe('CI 失败报告');
  // a flow label is a name, not a switch: shown as written, never as "开，标签 …"
  await expect(row(page, 'LABEL_AGENT_DOING').getByTestId('config-readonly')).toHaveText('doing/agent');
  await expect(row(page, 'LABEL_PENDING_AGENT').getByTestId('config-readonly')).toHaveText('pending/agent');
  await expect(row(page, 'PRIORITY_LABELS').getByTestId('config-readonly')).toHaveText('priority/p0,priority/p1,priority/p2');
  await expect(row(page, 'GREEDY_SKIP_LABELS').getByTestId('config-readonly')).toHaveText('（空）');
  await expect(row(page, 'CI_FAILURE_REPORT_BRANCH').getByTestId('config-readonly')).toHaveText('main');
  await expect(row(page, 'AUTOPILOT_MERGE_METHOD').getByTestId('config-readonly')).toHaveText('压成一个提交（squash）');
  await expect(row(page, 'LABEL_PENDING_AGENT_EXTRA').getByTestId('config-why')).toContainText('另一台机器');
  for (const name of ['LABEL_PENDING_AGENT', 'LABEL_AGENT_DOING', 'LABEL_DONE', 'GREEDY_SKIP_LABELS', 'PRIORITY_LABELS', 'PRIORITY_SOURCE', 'PROJECT_PRIORITY_FIELD', 'AUTOPILOT_MERGE_METHOD', 'CI_FAILURE_REPORT_BRANCH']) {
    await expect(row(page, name)).toHaveAttribute('data-editable', 'false');
    await expect(input(page, name)).toHaveCount(0);
  }
  for (const name of ['FABLE_WORKER_AGENT', 'FABLE_MODEL', 'AUTOPILOT_CHECKS_TIMEOUT_HOURS', 'USAGE_LIMIT_FALLBACK_SECS', 'HEAVY_TEST_LOCK_WAIT', 'PENDING_HUMAN_CONFLICT_MAX_TRIES', 'CHECKOUT_STALE_ALERT_COMMITS', 'GREEDY_SCAN_LIMIT', 'CI_FAILURE_REPORT_MAX_FIX_ATTEMPTS']) {
    await expect(row(page, name)).toHaveAttribute('data-editable', 'true');
  }
  await row(page, 'LABEL_AGENT_DOING').scrollIntoViewIfNeeded();
  await shot(page, '8-flow-labels');

  // the daemon's own range: the fallback pause takes 60–604800 seconds
  await input(page, 'USAGE_LIMIT_FALLBACK_SECS').fill('30');
  await expect(row(page, 'USAGE_LIMIT_FALLBACK_SECS').getByTestId('config-problem')).toHaveText('只能是 60 到 604800 之间的整数');
  await expect(page.getByTestId('config-save')).toBeDisabled();
  await input(page, 'USAGE_LIMIT_FALLBACK_SECS').fill('7200');
  await input(page, 'GREEDY_SCAN_LIMIT').fill('250');
  await page.getByTestId('config-save').click();
  await expect(page.getByTestId('config-result')).toHaveAttribute('data-kind', 'saved', SCRIPT);
  expect(lines('GREEDY_SCAN_LIMIT')).toEqual(['GREEDY_SCAN_LIMIT=250']);
  expect(lines('USAGE_LIMIT_FALLBACK_SECS')).toEqual(['USAGE_LIMIT_FALLBACK_SECS=7200']);
  await page.getByTestId('config-close').click();
});

test('preview and poll-pace settings are in their groups; the port modulo may be left blank; the back-off ladder shows what the daemon uses for a missing line and for an empty one (GitHub#556)', async () => {
  const { page } = await openSection(() => {
    const t = readFileSync(config, 'utf8');
    expect(t).toContain('\nPREVIEW_PORT_MODULO=""\n');
    expect(t).toContain('\nPOLL_BACKOFF_LADDER="86400:300,259200:600,604800:1800"\n');
    // written as an empty value: back-off is off (only a missing line means the default ladder)
    writeFileSync(config, t.replace('\nPOLL_BACKOFF_LADDER="86400:300,259200:600,604800:1800"\n', '\nPOLL_BACKOFF_LADDER=""\n'));
  });
  await openDialog(page);
  const groupOf = async (name: string) => (await page.locator('[data-testid=config-group]').filter({ has: row(page, name) }).getAttribute('data-title'))!;
  for (const name of ['PREVIEW_PORT_BASE', 'PREVIEW_PORT_MODULO', 'PREVIEW_BACKEND_OFFSET', 'PREVIEW_IDLE', 'PREVIEW_READY_TIMEOUT']) expect(await groupOf(name)).toBe('预览');
  for (const name of ['POLL_BACKOFF_LADDER', 'POLL_FORCE_SYNC_SECS', 'POLL_IDLE_PROBE_MAX_SECS', 'POLL_FAIL_BACKOFF_MAX_SECS', 'POLL_DUE_SLACK_SECS', 'POLL_RUN_LOG_ROUNDS', 'POLL_RUN_LOG_SNAPSHOTS', 'POLL_RUN_LOG_INFLIGHT', 'POLL_RUN_LOG_SLOW_SECS']) {
    expect(await groupOf(name)).toBe('轮询');
  }
  // the poll interval stays out of the window: the installer writes it into the timer
  await expect(row(page, 'POLL_INTERVAL_SECS')).toHaveCount(0);
  for (const name of ['PREVIEW_IDLE', 'POLL_BACKOFF_LADDER']) {
    await expect(row(page, name)).toHaveAttribute('data-editable', 'false');
    await expect(input(page, name)).toHaveCount(0);
  }
  await expect(row(page, 'PREVIEW_IDLE').getByTestId('config-readonly')).toHaveText('30min');
  await expect(row(page, 'POLL_BACKOFF_LADDER').getByTestId('config-readonly')).toHaveText('（空）');
  await expect(row(page, 'POLL_BACKOFF_LADDER').getByTestId('config-why')).toContainText('秒:秒');
  // the modulo: blank in the file, and blank is allowed; 0 is not
  await expect(input(page, 'PREVIEW_PORT_MODULO')).toHaveValue('');
  await expect(row(page, 'PREVIEW_PORT_MODULO')).toContainText('（1–65535，可留空）');
  await input(page, 'PREVIEW_PORT_MODULO').fill('0');
  await expect(row(page, 'PREVIEW_PORT_MODULO').getByTestId('config-problem')).toHaveText('只能是 1 到 65535 之间的整数，或者留空');
  await expect(page.getByTestId('config-save')).toBeDisabled();
  await input(page, 'PREVIEW_PORT_MODULO').fill('1000');
  await input(page, 'POLL_RUN_LOG_ROUNDS').fill('500');
  await row(page, 'PREVIEW_PORT_MODULO').scrollIntoViewIfNeeded();
  await shot(page, '9-preview-poll');
  await page.getByTestId('config-save').click();
  await expect(page.getByTestId('config-result')).toHaveAttribute('data-kind', 'saved', SCRIPT);
  expect(lines('PREVIEW_PORT_MODULO').map((l) => l.replace(/"/g, ''))).toEqual(['PREVIEW_PORT_MODULO=1000']);
  expect(lines('POLL_RUN_LOG_ROUNDS').map((l) => l.replace(/"/g, ''))).toEqual(['POLL_RUN_LOG_ROUNDS=500']);
  await page.getByTestId('config-close').click();
  // back to blank: no problem, saved as an empty value
  await openDialog(page);
  await input(page, 'PREVIEW_PORT_MODULO').fill('');
  await expect(row(page, 'PREVIEW_PORT_MODULO').getByTestId('config-problem')).toHaveCount(0);
  await page.getByTestId('config-save').click();
  await expect(page.getByTestId('config-result')).toHaveAttribute('data-kind', 'saved', SCRIPT);
  expect(lines('PREVIEW_PORT_MODULO').map((l) => l.replace(/"/g, ''))).toEqual(['PREVIEW_PORT_MODULO=']);
  await page.getByTestId('config-close').click();

  // the ladder line taken out: the default ladder the daemon then uses, marked as not in the file
  writeFileSync(config, readFileSync(config, 'utf8').replace('\nPOLL_BACKOFF_LADDER=""\n', '\n'));
  await openDialog(page);
  // (a read-only row carries no "not in the file" pill: that mark is only on rows the form can write)
  await expect(row(page, 'POLL_BACKOFF_LADDER').getByTestId('config-readonly')).toHaveText('86400:300,259200:600,604800:1800');
});

test('read-only rows sit in their own topic groups, each saying its own reason; the run-log switch follows the daemon\'s rule for an empty line and for a missing one (GitHub#554)', async () => {
  const { page } = await openSection(() => {
    const t = readFileSync(config, 'utf8');
    expect(t).toContain('\nENABLE_POLL_RUN_LOG=true\n');
    // an empty value: the daemon does not record rounds (only a missing line means "on")
    writeFileSync(config, t.replace('\nENABLE_POLL_RUN_LOG=true\n', '\nENABLE_POLL_RUN_LOG=""\n'));
  });
  await openDialog(page);
  const groupOf = async (name: string) => (await page.locator('[data-testid=config-group]').filter({ has: row(page, name) }).getAttribute('data-title'))!;
  expect(await groupOf('LABEL_AUTOPILOT')).toBe('托管（自动合并）');
  expect(await groupOf('LABEL_PENDING_MERGE')).toBe('托管（自动合并）');
  expect(await groupOf('AUTOPILOT_OUTSIDER_SCREEN')).toBe('托管（自动合并）');
  expect(await groupOf('DISPATCH_MODE')).toBe('派工与重试');
  expect(await groupOf('LABEL_PENDING_REVIEW')).toBe('复审');
  expect(await groupOf('LABEL_PENDING_BLOCKED')).toBe('等人期间');
  expect(await groupOf('RETROSPECTIVE_PROMOTION')).toBe('合并后复盘');
  const titles = await page.getByTestId('config-group').evaluateAll((gs) => gs.map((g) => g.getAttribute('data-title')));
  expect(titles.filter((x) => x?.includes('只显示'))).toEqual([]);
  // no shared note above a group's read-only rows any more: each row says why
  await expect(page.locator('[data-testid=config-group] .pcfg-note')).toHaveCount(0);
  await expect(row(page, 'LABEL_PENDING_MERGE').getByTestId('config-why')).toContainText('标签名要和仓库里建好的标签一致');
  await expect(row(page, 'LABEL_PENDING_MERGE').getByTestId('config-readonly')).toHaveText('开，标签 pending/merge');
  await expect(row(page, 'DISPATCH_MODE').getByTestId('config-why')).toContainText('开着的都派');
  await expect(row(page, 'AUTOPILOT_OUTSIDER_GUARD').getByTestId('config-readonly')).toHaveText('标出并拦住自动合并（block）');
  await expect(row(page, 'AUTOPILOT_OUTSIDER_GUARD').getByTestId('config-why')).toContainText('保护模式');
  for (const name of ['LABEL_PENDING_MERGE', 'AUTOPILOT_OUTSIDER_GUARD', 'RETROSPECTIVE_PROMOTION', 'LABEL_PENDING_REQUESTER_BOT']) {
    await expect(row(page, name)).toHaveAttribute('data-editable', 'false');
    await expect(input(page, name)).toHaveCount(0);
  }
  // the switches registered here are inputs; the screening switch's "off" is an empty value
  for (const name of ['ENABLE_USAGE_LIMIT_PAUSE', 'POST_MERGE_RETROSPECTIVE', 'AUTO_RELEASE_MAIN_CHECKOUT', 'SELFHEAL_ONLY_OWN_WORKERS']) {
    await expect(row(page, name)).toHaveAttribute('data-editable', 'true');
  }
  await expect(input(page, 'AUTOPILOT_OUTSIDER_SCREEN')).toHaveAttribute('data-on', 'true');
  // written as an empty value: off, and it is in the file
  await expect(input(page, 'ENABLE_POLL_RUN_LOG')).toHaveAttribute('data-on', 'false');
  await expect(row(page, 'ENABLE_POLL_RUN_LOG').getByTestId('config-absent')).toHaveCount(0);
  await row(page, 'LABEL_PENDING_MERGE').scrollIntoViewIfNeeded();
  await shot(page, '7-groups');

  // the screening switch off writes its empty "off" word
  await input(page, 'AUTOPILOT_OUTSIDER_SCREEN').click();
  await page.getByTestId('config-save').click();
  await expect(page.getByTestId('config-result')).toHaveAttribute('data-kind', 'saved', SCRIPT);
  expect(lines('AUTOPILOT_OUTSIDER_SCREEN')).toEqual(['AUTOPILOT_OUTSIDER_SCREEN=""']);
  await page.getByTestId('config-close').click();

  // the line taken out: the daemon records rounds, and the form says the file has no such line
  writeFileSync(config, readFileSync(config, 'utf8').replace('\nENABLE_POLL_RUN_LOG=""\n', '\n'));
  await openDialog(page);
  await expect(input(page, 'ENABLE_POLL_RUN_LOG')).toHaveAttribute('data-on', 'true');
  await expect(row(page, 'ENABLE_POLL_RUN_LOG').getByTestId('config-absent')).toBeVisible();
  await expect(input(page, 'AUTOPILOT_OUTSIDER_SCREEN')).toHaveAttribute('data-on', 'false');
});

test('a config that does not load shows no values at all; "用编辑器打开配置文件" still hands the file to the system', async () => {
  const { page } = await openSection(() => writeFileSync(config, readFileSync(config, 'utf8') + 'if then fi (\n'));
  await page.locator('[data-testid=daemon-project][data-key=widget]').getByTestId('daemon-config').click();
  await expect(page.getByTestId('config-dialog')).toHaveAttribute('data-phase', 'failed', SCRIPT);
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
