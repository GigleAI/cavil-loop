// "接上 daemon" on a repository in Settings → 数据来源 (GitHub#315): the real
// window, the real back end, the daemon's real setup.sh in a fake HOME with the
// fake scheduler (test/support/daemon-world.ts).
//
//   - setup.sh's output shows while it is still running (it is held half-way
//     until the test lets it go);
//   - a failing setup.sh shows its own words and never "已接上";
//   - a missing program for the chosen agent, or a folder of another
//     repository, keeps "开始" off and nothing is sent.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { daemonEnv, daemonWorld, githubRewrite, installByHand, localCopy, pathFor, wrapTool, type DaemonWorld, type Os } from '../support/daemon-world';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

// the repository the fake GitHub serves; the fake gh answers it for `gh repo view` (FAKE_GH_REPO)
const REPO = 'GigleAI/cavil-loop';
let env: AppEnv;
let w: DaemonWorld;
const running: RunningApp[] = [];

test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-connect-'));
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

async function openSettings(os: Os, path: string, extra: Record<string, string> = {}): Promise<{ app: RunningApp; page: Page }> {
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
  await page.getByTestId('source-input').fill(REPO);
  await page.getByTestId('source-add').click();
  await expect(page.getByTestId('source-row')).toHaveCount(1);
  await expect(page.getByTestId('daemon-summary')).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  return { app, page };
}

const copy = () => localCopy(join(w.home, 'github', 'cavil-loop'), 'https://github.com/GigleAI/cavil-loop.git');
const sent = (app: RunningApp, cmd: string) => app.backend.sent.filter((c) => c.cmd === cmd);
const shot = (page: Page, name: string) => page.getByTestId('connect-dialog').locator('.modal').screenshot({ path: join(screens, `connect-${name}.png`) });

test('a local copy is found; setup.sh\'s output shows while it runs; then "已接上" here and in the daemon section', async () => {
  installByHand(w);
  const host = copy();
  const path = pathFor(w);
  // hold setup.sh at its first GitHub write (creating the labels) until the test lets it go
  const gate = join(w.dir, 'gate');
  wrapTool(path, 'gh', `case "$*" in "label create"*) while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.1; done;; esac\nexec "$REAL" "$@"`);
  const { page } = await openSettings('Linux', path);
  const row = page.locator(`[data-testid=source-row][data-key="repo:gigleai/cavil-loop"]`);
  await row.getByTestId('connect-open').click();
  const dlg = page.getByTestId('connect-dialog');
  await expect(dlg.getByTestId('connect-candidate')).toBeChecked();
  await expect(dlg.getByTestId('connect-dir')).toHaveValue(host);
  await expect(dlg.getByTestId('connect-dir-check')).toHaveAttribute('data-ok', 'true');
  await expect(dlg.getByTestId('connect-agent')).toHaveValue('claude');
  await expect(dlg.getByTestId('connect-precheck')).toHaveAttribute('data-ready', 'true');
  await shot(page, '1-ready');
  await dlg.getByTestId('connect-start').click();

  // live: setup.sh's first lines are on screen while it is still held
  const out = dlg.getByTestId('connect-output');
  await expect(out).toContainText('cavil-loop setup', { timeout: 30_000 });
  await expect(out).toContainText('依赖齐全');
  await expect(dlg.getByTestId('connect-result')).toHaveCount(0);
  await expect(out).not.toContainText('setup 完成');
  await expect(dlg.getByTestId('connect-close')).toBeDisabled();
  await shot(page, '2-running');
  writeFileSync(gate, '');

  const res = dlg.getByTestId('connect-result');
  await expect(res).toHaveAttribute('data-result', 'connected', { timeout: 60_000 });
  await expect(res).toContainText('已接上：cavil-loop');
  await expect(out).toContainText('setup 完成');
  await shot(page, '3-connected');
  await dlg.getByTestId('connect-close').click();
  await expect(dlg).toHaveCount(0);
  await expect(row.getByTestId('connect-connected')).toHaveAttribute('data-state', 'running');
  await expect(row.getByTestId('connect-connected')).toHaveText('已接上');
  const project = page.locator('[data-testid=daemon-project][data-key=cavil-loop]');
  await expect(project).toHaveAttribute('data-state', 'running');
  await expect(project).toContainText(REPO);
});

test('setup.sh fails: its own words are shown, never "已接上"', async () => {
  installByHand(w);
  copy();
  const { page } = await openSettings('Darwin', pathFor(w), { FAKE_LD_BOOTSTRAP: 'fail' });
  const row = page.locator(`[data-testid=source-row][data-key="repo:gigleai/cavil-loop"]`);
  await row.getByTestId('connect-open').click();
  const dlg = page.getByTestId('connect-dialog');
  await expect(dlg.getByTestId('connect-precheck')).toHaveAttribute('data-ready', 'true');
  await expect(dlg.getByTestId('connect-dir-check')).toHaveAttribute('data-ok', 'true');
  await dlg.getByTestId('connect-start').click();
  const res = dlg.getByTestId('connect-result');
  await expect(res).toHaveAttribute('data-result', 'failed', { timeout: 60_000 });
  await expect(dlg.getByTestId('connect-failure')).toContainText('setup.sh 没有成功（退出码 5）');
  await expect(dlg.getByTestId('connect-output')).toContainText('Bootstrap failed: 5: Input/output error');
  await expect(dlg).not.toContainText('已接上');
  await shot(page, '4-failed');
  await dlg.getByTestId('connect-close').click();
  // the half-made registration is not "已接上" either
  await expect(row.getByTestId('connect-connected')).not.toHaveText('已接上');
  await expect(row.getByTestId('connect-connected')).toHaveAttribute('data-state', /stopped|unknown/);
});

test('the chosen agent\'s program is missing: listed with a command, "开始" stays off, nothing is sent', async () => {
  installByHand(w);
  copy();
  const { app, page } = await openSettings('Linux', pathFor(w, { agents: ['claude'] }));
  await page.locator(`[data-testid=source-row][data-key="repo:gigleai/cavil-loop"]`).getByTestId('connect-open').click();
  const dlg = page.getByTestId('connect-dialog');
  await expect(dlg.getByTestId('connect-precheck')).toHaveAttribute('data-ready', 'true');
  await dlg.getByTestId('connect-agent').selectOption('codex');
  await expect(dlg.getByTestId('connect-precheck')).toHaveAttribute('data-ready', 'false');
  const miss = dlg.locator('[data-testid=connect-check][data-id="tool:codex"]');
  await expect(miss).toContainText('缺 codex');
  await expect(miss.getByTestId('connect-command')).toHaveText('npm install -g @openai/codex');
  await expect(dlg.getByTestId('connect-start')).toBeDisabled();
  await shot(page, '5-missing-agent');
  // back to claude, which is here: ready again
  await dlg.getByTestId('connect-agent').selectOption('claude');
  await expect(dlg.getByTestId('connect-precheck')).toHaveAttribute('data-ready', 'true');
  await dlg.getByTestId('connect-close').click();
  expect(sent(app, 'daemonConnect')).toEqual([]);
});

test('a folder of another repository is refused with the reason; no copy found offers a clone', async () => {
  installByHand(w);
  const other = localCopy(join(w.home, 'work', 'other'), 'https://github.com/acme/other.git');
  mkdirSync(join(w.home, 'github'));
  const { app, page } = await openSettings('Linux', pathFor(w));
  await page.locator(`[data-testid=source-row][data-key="repo:gigleai/cavil-loop"]`).getByTestId('connect-open').click();
  const dlg = page.getByTestId('connect-dialog');
  // nothing found: the clone is offered, into ~/github by default
  await expect(dlg.getByTestId('connect-mode-clone')).toBeChecked();
  await expect(dlg.getByTestId('connect-clone-into')).toHaveValue(join(w.home, 'github'));
  await expect(dlg.getByTestId('connect-clone-target')).toContainText(join(w.home, 'github', 'cavil-loop'));
  await dlg.getByTestId('connect-mode-existing').check();
  await dlg.getByTestId('connect-dir').fill(other);
  const check = dlg.getByTestId('connect-dir-check');
  await expect(check).toHaveAttribute('data-ok', 'false');
  await expect(check).toContainText('origin 是 acme/other，不是 GigleAI/cavil-loop');
  await expect(dlg.getByTestId('connect-start')).toBeDisabled();
  await dlg.getByTestId('connect-close').click();
  expect(sent(app, 'daemonConnect')).toEqual([]);
});

test('a project config left in the folder: another repository blocks "开始"; its agent (as the daemon reads it) is the one shown', async () => {
  installByHand(w);
  const host = copy();
  const cfg = (repo: string, agentLine: string) =>
    writeFileSync(
      join(host, 'cavil-loop.config'),
      readFileSync(join(w.skill, 'cavil-loop.config.example'), 'utf8').replace('myorg/myrepo', repo).replace(/^WORKER_AGENT="claude"$/m, agentLine),
    );
  cfg('acme/other', 'WORKER_AGENT="claude"');
  const { app, page } = await openSettings('Linux', pathFor(w, { agents: ['claude', 'codex'] }));
  await page.locator(`[data-testid=source-row][data-key="repo:gigleai/cavil-loop"]`).getByTestId('connect-open').click();
  const dlg = page.getByTestId('connect-dialog');
  const check = dlg.getByTestId('connect-dir-check');
  await expect(check).toHaveAttribute('data-ok', 'false');
  await expect(check).toContainText('里面的仓库是 acme/other');
  await expect(dlg.getByTestId('connect-start')).toBeDisabled();
  await dlg.getByTestId('connect-close').click();
  expect(sent(app, 'daemonConnect')).toEqual([]);

  // the same folder, its config now naming this repository with `export WORKER_AGENT="codex"`
  cfg(REPO, 'export WORKER_AGENT="codex"');
  await page.locator(`[data-testid=source-row][data-key="repo:gigleai/cavil-loop"]`).getByTestId('connect-open').click();
  await expect(dlg.getByTestId('connect-dir-check')).toHaveAttribute('data-ok', 'true');
  await expect(dlg.getByTestId('connect-agent')).toHaveValue('codex');
  await expect(dlg.getByTestId('connect-agent')).toBeDisabled();
  await expect(dlg.getByTestId('connect-config-note')).toContainText('codex');
});
