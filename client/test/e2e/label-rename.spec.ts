// GitHub#569: project settings → a flow label's 「改名…」 and 「跟进另一台的改名…」, in the real window
// with the real back end and the daemon's real scripts/label-rename.sh + project-config.sh on projects
// the real setup.sh connected (a fake HOME). GitHub's label list and the rename request go to a small
// stand-in for `gh` (labels kept in a file); everything else is the daemon's own fake gh. What a rename
// did is read from the config file, the label file and the client's own settings view.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { connect, daemonEnv, daemonWorld, dropWorlds, installByHand, pathFor, wrapTool, type DaemonWorld } from '../support/daemon-world';

// the real scripts run under bash with a poll lock and several gh calls
const SCRIPT = { timeout: 45_000 };

let env: AppEnv;
let w: DaemonWorld;
let labels: string;
const running: RunningApp[] = [];

/** GitHub's labels for acme/widget, kept in a file: list, rename (PATCH), and "open items carrying a label" (none). */
const GH_LABELS = `
L="\${FAKE_LABELS:?}"
args="$*"
case "$args" in
  *"repos/acme/widget/labels?per_page=100"*)
    cat "$L"; exit 0 ;;
  *"-X PATCH repos/acme/widget/labels/"*)
    old="$(printf '%s\\n' "$args" | sed -n 's#.*repos/acme/widget/labels/\\([^ ]*\\).*#\\1#p' | python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()))')"
    new="$(printf '%s\\n' "$args" | sed -n 's#.*new_name=\\([^ ]*\\).*#\\1#p')"
    if [ -f "$L.noanswer" ]; then echo "Post https://api.github.com: net/http: timeout" >&2; exit 1; fi
    awk -F'\\t' -v o="$old" -v n="$new" 'BEGIN{OFS="\\t"} $2 == o { $2 = n } { print }' "$L" > "$L.tmp" && mv "$L.tmp" "$L"
    echo "$new"; exit 0 ;;
  *"repos/acme/widget/issues?state=open"*)
    echo 0; exit 0 ;;
esac
exec "$REAL" "$@"
`;

test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-rename-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  w = daemonWorld(join(dir, 'machine'));
  installByHand(w);
  labels = join(dir, 'labels.tsv');
  writeFileSync(labels, ['101\tpending/agent', '102\tpending/human', '103\tdoing/agent', '104\tpending/blocked', '105\tDone'].join('\n') + '\n');
});
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close()));
  await env.fake.close();
  dropWorlds();
});
test.afterAll(async () => {
  await closeEngine();
});

/** Connect the projects with the real setup.sh, put the label stand-in in front of gh, sign in, open settings. */
async function openSection(keys: string[]): Promise<{ app: RunningApp; page: Page; configs: Record<string, string> }> {
  const path = pathFor(w);
  const configs: Record<string, string> = {};
  for (const k of keys) configs[k] = join(connect(w, k, 'Linux', path), 'cavil-loop.config');
  wrapTool(path, 'gh', GH_LABELS);
  const app = await launchApp(env, { backendEnv: daemonEnv(w, { os: 'Linux', path, extra: { FAKE_LABELS: labels } }) });
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
  for (const k of keys) await expect(page.locator(`[data-testid=daemon-project][data-key=${k}]`)).toBeVisible(SCRIPT);
  return { app, page, configs };
}

const openConfig = async (page: Page, key: string) => {
  await page.locator(`[data-testid=daemon-project][data-key=${key}]`).getByTestId('daemon-config').click();
  await expect(page.getByTestId('config-dialog')).toHaveAttribute('data-phase', 'form', SCRIPT);
};
const row = (page: Page, name: string) => page.locator(`[data-testid=config-row][data-name=${name}]`);
const notice = (page: Page) => page.locator('[data-testid="notice-area"] [data-testid="rename-notice"]');
const lines = (file: string, name: string) => readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith(`${name}=`));
const labelNames = () => readFileSync(labels, 'utf8').trim().split('\n').map((l) => l.split('\t')[1]);
const check = (page: Page, id: string) => page.locator(`[data-testid=rename-check][data-id=${id}]`);

// PR 用的截图（只在设了 CAVIL_RENAME_SHOTS 时拍，平时什么都不做）
async function shot(page: import('@playwright/test').Page, name: string): Promise<void> {
  const dir = process.env.CAVIL_RENAME_SHOTS;
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${name}.png` });
}

test('改名: the checks are listed, the button waits for the tick; then GitHub, the config and the client get the new name, for that repository only', async () => {
  const { app, page, configs } = await openSection(['widget']);
  await openConfig(page, 'widget');
  const r = row(page, 'LABEL_PENDING_HUMAN');
  await expect(r.getByTestId('config-rename')).toHaveAttribute('data-ok', 'true');
  // a field the daemon cannot rename (a list) has no rename button
  await expect(row(page, 'LABEL_PENDING_AGENT_EXTRA').getByTestId('config-rename')).toHaveCount(0);
  await r.getByTestId('config-rename-open').click();
  const dialog = page.getByTestId('rename-dialog');
  await expect(dialog).toHaveAttribute('data-mode', 'rename');
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  await page.getByTestId('rename-new-name').fill('wait/human');
  await expect(check(page, 'old_label')).toHaveAttribute('data-ok', 'true', SCRIPT);
  for (const id of ['name', 'config_value', 'config_line', 'other_settings', 'new_free', 'no_worker']) await expect(check(page, id)).toHaveAttribute('data-ok', 'true');
  await expect(check(page, 'others_stopped')).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('rename-pollers-none')).toBeVisible();
  await expect(page.getByTestId('rename-missing')).toContainText('还没勾选「已确认」');
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  // nothing changing went out yet
  expect(app.backend.sent.filter((c) => c.cmd === 'daemonLabelRename').map((c) => (c.args as { cmd: string }).cmd)).not.toContain('rename');
  await page.getByTestId('rename-others-stopped').check();
  await expect(check(page, 'others_stopped')).toHaveAttribute('data-ok', 'true', SCRIPT);
  await expect(page.getByTestId('rename-missing')).toHaveAttribute('data-count', '0');
  await page.getByTestId('confirm-ok').click();

  await expect(notice(page)).toHaveAttribute('data-state', 'done', SCRIPT);
  await expect(notice(page).getByTestId('rename-credential')).toHaveText('cavil-label-rename v1 acme/widget LABEL_PENDING_HUMAN pending/human wait/human 102');
  expect(labelNames()).toContain('wait/human');
  expect(labelNames()).not.toContain('pending/human');
  expect(lines(configs.widget, 'LABEL_PENDING_HUMAN')).toEqual(['LABEL_PENDING_HUMAN="wait/human"']);
  // the daemon goes on: no rename record left
  const status = app.backend.sent.filter((c) => c.cmd === 'daemonLabelRename').map((c) => (c.args as { cmd: string }).cmd);
  expect(status.filter((c) => c !== 'check')).toEqual(['rename', 'finish']);
  // the client: that repository has its own name now, the shared one is as it was
  await page.getByTestId('config-dialog').getByTestId('config-cancel').click();
  await page.getByTestId('hand-back-settings').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('hand-back-human')).toHaveValue('pending/human');
  // its "等人处理" name, and its other flow labels with the new name added (the shared pending/* no longer covers it)
  await expect(page.locator('[data-testid=repo-label-row][data-repo="acme/widget"][data-slot=human] code')).toHaveText('wait/human');
  await expect(page.locator('[data-testid=repo-label-row][data-repo="acme/widget"][data-slot=flow] code')).toHaveText('pending/*, doing/*, Done, wait/human');
  // 「改回共用」 drops it again
  await page.locator('[data-testid=repo-label-row][data-slot=human]').getByTestId('repo-label-drop').click();
  await expect(page.locator('[data-testid=repo-label-row][data-slot=human]')).toHaveCount(0);
});

test('the paired machines\' list still being read, or not readable, keeps 改名 off; read again, it lets it through (PR #571 review round 2)', async () => {
  const { app, page } = await openSection(['widget']);
  // hold every remoteList the window asks for until the test says how it ends
  let mode: 'hold' | 'fail' | 'pass' = 'hold';
  const held: (() => void)[] = [];
  await page.route('**/call', async (route) => {
    const body = route.request().postData() ?? '';
    if (!body.includes('"remoteList"')) return route.continue();
    if (mode === 'pass') return route.continue();
    if (mode === 'fail') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ err: 'remote list unreadable' }) });
    await new Promise<void>((r) => held.push(r));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ err: 'remote list unreadable' }) });
  });
  await openConfig(page, 'widget');
  await row(page, 'LABEL_PENDING_HUMAN').getByTestId('config-rename-open').click();
  await page.getByTestId('rename-new-name').fill('wait/human');
  await page.getByTestId('rename-others-stopped').check();
  await expect(check(page, 'others_stopped')).toHaveAttribute('data-ok', 'true', SCRIPT);
  // still reading: off, and says so
  await expect(page.getByTestId('rename-remotes-loading')).toBeVisible();
  await expect(page.getByTestId('rename-missing')).toContainText('还在读取配对过的远程机器');
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  // the read fails: never "no paired machines"
  mode = 'fail';
  for (const r of held.splice(0)) r();
  await expect(page.getByTestId('rename-remotes-failed')).toBeVisible(SCRIPT);
  await expect(page.getByTestId('rename-pollers-none')).toHaveCount(0);
  await expect(page.getByTestId('rename-missing')).toContainText('读不到配对过的远程机器列表');
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  // read again, it answers: an empty list is a real "none" and the button comes on
  mode = 'pass';
  await page.getByTestId('rename-remotes-retry').click();
  await expect(page.getByTestId('rename-pollers-none')).toBeVisible(SCRIPT);
  await expect(page.getByTestId('rename-missing')).toHaveAttribute('data-count', '0', SCRIPT);
  await expect(page.getByTestId('confirm-ok')).toBeEnabled();
  expect(app.backend.sent.filter((c) => c.cmd === 'daemonLabelRename').map((c) => (c.args as { cmd: string }).cmd)).not.toContain('rename');
  await page.unroute('**/call');
});

test('another project polling the same repository is listed and stopped first; it then follows with the credential', async () => {
  const { page, configs } = await openSection(['widget', 'widgetb']);
  await openConfig(page, 'widget');
  await row(page, 'LABEL_DONE').getByTestId('config-rename-open').click();
  await page.getByTestId('rename-new-name').fill('Shipped');
  const other = page.locator('[data-testid=rename-poller][data-key=widgetb]');
  await expect(other).toHaveAttribute('data-where', 'local', SCRIPT);
  await expect(other).toHaveAttribute('data-state', 'running');
  await page.getByTestId('rename-others-stopped').check();
  await expect(page.getByTestId('rename-missing')).toContainText('还有 1 个别处的轮询没停', SCRIPT);
  await shot(page, 'rename-dialog-other');
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  await other.getByTestId('rename-stop').click();
  await expect(other).toHaveAttribute('data-state', 'stopped', SCRIPT);
  await expect(page.getByTestId('rename-missing')).toHaveAttribute('data-count', '0', SCRIPT);
  await page.getByTestId('confirm-ok').click();
  await expect(notice(page)).toHaveAttribute('data-state', 'done', SCRIPT);
  await expect(notice(page).locator('[data-testid=rename-follower][data-key=widgetb]')).toBeVisible();
  await shot(page, 'rename-done-follow');
  expect(lines(configs.widget, 'LABEL_DONE')).toEqual(['LABEL_DONE="Shipped"']);
  expect(lines(configs.widgetb, 'LABEL_DONE')).toEqual(['LABEL_DONE="Done"']);
  // done with followers stays (its steps are needed); × puts it away
  await page.getByTestId('config-dialog').getByTestId('config-cancel').click();

  await openConfig(page, 'widgetb');
  await row(page, 'LABEL_DONE').getByTestId('config-follow-open').click();
  await expect(page.getByTestId('rename-dialog')).toHaveAttribute('data-mode', 'follow');
  // filled in from the rename this client just did
  await expect(page.getByTestId('rename-credential-input')).toHaveValue('cavil-label-rename v1 acme/widget LABEL_DONE Done Shipped 105');
  await expect(check(page, 'followed')).toHaveAttribute('data-ok', 'true', SCRIPT);
  await expect(check(page, 'old_gone')).toHaveAttribute('data-ok', 'true');
  await page.getByTestId('confirm-ok').click();
  await expect(page.locator('[data-testid=rename-notice][data-key=widgetb]')).toHaveAttribute('data-state', 'done', SCRIPT);
  expect(lines(configs.widgetb, 'LABEL_DONE')).toEqual(['LABEL_DONE="Shipped"']);
});

test('GitHub does not answer the rename: the notice offers only 「再查一次」 and 「重发改名」, no undo and no ×; a resend finishes it and the label check stays until ended', async () => {
  const { page, configs } = await openSection(['widget']);
  writeFileSync(`${labels}.noanswer`, '');
  await openConfig(page, 'widget');
  await row(page, 'LABEL_PENDING_HUMAN').getByTestId('config-rename-open').click();
  await page.getByTestId('rename-new-name').fill('wait/human');
  await page.getByTestId('rename-others-stopped').check();
  await expect(page.getByTestId('rename-missing')).toHaveAttribute('data-count', '0', SCRIPT);
  await page.getByTestId('confirm-ok').click();
  const n = notice(page);
  await expect(n).toHaveAttribute('data-state', 'no_answer', SCRIPT);
  await expect(n.getByTestId('rename-retry')).toHaveAttribute('data-retry', 'recheck');
  await expect(n.getByTestId('rename-resend')).toBeVisible();
  await expect(n.getByTestId('rename-undo')).toHaveCount(0);
  await expect(n.getByTestId('rename-notice-close')).toHaveCount(0);
  await shot(page, 'rename-no-answer');
  await expect(n.locator('[data-place=github]')).toHaveAttribute('data-value', 'unknown');
  await expect(n.locator('[data-place=polling]')).toHaveAttribute('data-value', 'paused');
  expect(lines(configs.widget, 'LABEL_PENDING_HUMAN')).toEqual(['LABEL_PENDING_HUMAN="pending/human"']);
  // closing the settings dialog leaves the notice (the controller holds the rename); opened again it shows the project paused
  await page.getByTestId('config-dialog').getByTestId('config-cancel').click();
  await openConfig(page, 'widget');
  await expect(page.getByTestId('config-rename-pending')).toContainText('pending/human');
  await expect(row(page, 'LABEL_PENDING_HUMAN').getByTestId('config-rename')).toHaveAttribute('data-ok', 'false');
  await page.getByTestId('config-dialog').getByTestId('config-cancel').click();
  // 「再查一次」 only reads: still no answer
  await n.getByTestId('rename-retry').click();
  await expect(n).toHaveAttribute('data-state', 'no_answer', SCRIPT);
  // GitHub answers again: 「重发改名」 goes through
  const { rmSync } = await import('node:fs');
  rmSync(`${labels}.noanswer`);
  await n.getByTestId('rename-resend').click();
  await expect(n).toHaveAttribute('data-state', 'done', SCRIPT);
  expect(lines(configs.widget, 'LABEL_PENDING_HUMAN')).toEqual(['LABEL_PENDING_HUMAN="wait/human"']);
  const watch = page.locator('[data-testid=rename-watch][data-key=widget]');
  await expect(watch).toBeVisible();
  await watch.getByTestId('rename-watch-end').click();
  await expect(watch).toHaveCount(0, SCRIPT);
  expect(existsSync(join(w.home, '.local/state/cavil-loop/widget/label-watch.json'))).toBe(false);
});
