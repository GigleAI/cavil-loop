// GitHub#473 (sub-issue ③ of #466): Settings → 远程 daemon and this machine's own remote switch in
// English — the real window, the real back end, the daemon's real remote-access service behind the
// stand-in for Tailscale's HTTPS forwarding (test/support/remote-world.ts; fake tailscale and fake
// sudo first on PATH, never the real ones). Chinese the other machine sends back (its refusal, its
// poll log) and Chinese names of paired computers are shown as written; every word around them is
// English (the run-time language check, test/e2e/langCheck.ts).

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { connect, daemonEnv, daemonWorld, dropWorlds, installByHand, pathFor, type DaemonWorld } from '../support/daemon-world';
import { BOX, closeRemote, installFakeTailscale, pairCode, remoteWorld, setHosts, type RemoteWorld } from '../support/remote-world';
import { chineseIn } from './langCheck';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

let env: AppEnv;
let w: DaemonWorld;
let r: RemoteWorld;
let path: string;
const running: RunningApp[] = [];

test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-i18n-remote-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  w = daemonWorld(join(dir, 'machine'));
  installFakeTailscale(w);
  installByHand(w);
  path = pathFor(w);
  connect(w, 'widget', 'Linux', path);
  r = await remoteWorld(w, path);
  // this computer's Tailscale sees no other machine (the picker then asks for the name)
  writeFileSync(join(r.ts, 'peers.json'), '');
});
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close()));
  await closeRemote(r);
  await env.fake.close();
  dropWorlds();
});
test.afterAll(async () => {
  await closeEngine();
});

/**
 * Parts of these regions that belong to another sub-issue of #466 (removed when those are merged):
 * the confirmation dialog's own buttons and hint (ConfirmDialog, sub-issue ② #472 — the label of its
 * confirm button is this area's and is asserted separately).
 */
const LATER = ['[data-testid="confirm-cancel"]', '[data-testid="confirm-ok"]', '[data-testid="dialog-esc-hint"]'];

async function openEnglish(): Promise<{ app: RunningApp; page: Page }> {
  const app = await launchApp(env, { backendEnv: { ...daemonEnv(w, { os: 'Linux', path, extra: { FAKE_TS: r.ts } }), ...r.env } });
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
  await page.getByTestId('remote-settings').scrollIntoViewIfNeeded();
  return { app, page };
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(screens, `473-remote-${name}.png`) });

test('GitHub#473: the remote daemon section in English — a refusal and a poll log in the other machine’s Chinese shown as written, everything around them English', async () => {
  const { app, page } = await openEnglish();
  const section = page.getByTestId('remote-settings');
  await expect(section.locator('h3')).toHaveText('Remote daemons');
  await expect(page.getByTestId('remote-empty')).toHaveText('No remote machine paired yet.');
  await expect(page.getByTestId('remote-add')).toHaveText('Add a remote daemon…');
  expect(await chineseIn(page, ['[data-testid="remote-settings"]'], LATER)).toEqual([]);

  // a wrong code: the machine's own (Chinese) refusal, marked; the dialog around it English
  await page.getByTestId('remote-add').click();
  await expect(page.getByTestId('remote-pair-dialog')).toBeVisible();
  // no other machine in this computer's Tailscale: the name is typed
  await expect(page.getByTestId('remote-pair-host')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('remote-pair-host').fill(BOX);
  const code = pairCode(w, r);
  const wrong = String((Number(code) + 1) % 100000000).padStart(8, '0');
  await page.getByTestId('remote-pair-code').fill(wrong);
  await expect(page.getByTestId('confirm-ok')).toHaveText('Pair');
  await page.getByTestId('confirm-ok').click();
  const err = page.getByTestId('remote-pair-error');
  await expect(err).toHaveAttribute('data-reason', 'pairing_wrong');
  await expect(err).toContainText('Not paired: That machine answered: ');
  await expect(err.locator('[data-verbatim="remote"]')).toContainText('配对码不对');
  await expect(page.getByTestId('confirm-dialog').locator('h3')).toHaveText('Add a remote daemon');
  expect(await chineseIn(page, ['[data-testid="confirm-dialog"]'], LATER)).toEqual([]);
  await shot(page, '1-pair-refused');

  // paired: the machine and its project, English around what the machine reported
  await page.getByTestId('remote-pair-code').fill(`${code.slice(0, 4)} ${code.slice(4)}`);
  await page.getByTestId('confirm-ok').click();
  const host = page.locator(`[data-testid=remote-host][data-id="${BOX}:47387"]`);
  await expect(host).toHaveAttribute('data-state', 'ok');
  await expect(host.getByTestId('remote-pill')).toHaveText('connected');
  await expect(host.locator('thead')).toContainText('Repository / folder (on that machine)');
  await expect(host.getByTestId('remote-log')).toHaveText('Log');
  expect(await chineseIn(page, ['[data-testid="remote-settings"]'], LATER)).toEqual([]);
  await shot(page, '2-connected');

  // the poll log, in Chinese as that machine wrote it
  const stateDir = (await app.backend.call<any>('remoteStatus', { id: `${BOX}:47387` })).status.projects[0].state_dir;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'poll.log'), '[widget] 轮询：没有要派的活\n[widget] 派工 #7：新 issue\n');
  await host.getByTestId('remote-log').click();
  const log = page.getByTestId('remote-log-dialog');
  await expect(page.getByTestId('remote-log-text')).toContainText('[widget] 派工 #7：新 issue');
  await expect(log.locator('h3')).toHaveText(`Log · box / widget`);
  await expect(page.getByTestId('remote-log-close')).toHaveText('Close');
  expect(await chineseIn(page, ['[data-testid="remote-log-dialog"]'])).toEqual([]);
  await shot(page, '3-log');
  await page.getByTestId('remote-log-close').click();

  // off Tailscale: why, in English; the last status kept below
  setHosts(r, {});
  await host.getByTestId('remote-reload').click();
  await expect(host).toHaveAttribute('data-state', 'failed');
  const problem = host.getByTestId('remote-problem');
  await expect(problem).toContainText('Could not confirm that this connection goes over Tailscale');
  await expect(problem).toContainText('Below is what was read last time; no actions.');
  expect(await chineseIn(page, ['[data-testid="remote-settings"]'], LATER)).toEqual([]);
  // unpairing now: the offline question, its reason in English
  await host.getByTestId('remote-unpair').click();
  await expect(page.getByTestId('remote-unpair-text')).toHaveAttribute('data-offline', 'true');
  await expect(page.getByTestId('confirm-ok')).toHaveText('Unpair on this computer only');
  expect(await chineseIn(page, ['[data-testid="confirm-dialog"]'], LATER)).toEqual([]);
  await shot(page, '4-unpair-offline');
  await page.getByTestId('confirm-ok').click();
  await expect(host).toHaveAttribute('data-state', 'pending');
  await expect(host.getByTestId('remote-pill')).toHaveText('Unpairing not finished');
  await host.getByTestId('remote-retry').click();
  await expect(host.getByTestId('remote-note')).toContainText('That machine still could not confirm the revocation: ');
  expect(await chineseIn(page, ['[data-testid="remote-settings"]'], LATER)).toEqual([]);
  await shot(page, '5-pending');
});

test('GitHub#473: this machine’s own remote switch in English — a pairing code, a paired computer with a Chinese name shown as written', async () => {
  const { page } = await openEnglish();
  const block = page.getByTestId('local-remote');
  await block.scrollIntoViewIfNeeded();
  await expect(block).toHaveAttribute('data-state', 'closed', { timeout: 30_000 });
  await expect(block.locator('b').first()).toHaveText('Allow other computers to connect');
  await expect(page.getByTestId('local-remote-summary')).toContainText('Off · 0 paired');
  expect(await chineseIn(page, ['[data-testid="local-remote"]'])).toEqual([]);
  await page.getByTestId('local-remote-switch').click();
  await expect(block).toHaveAttribute('data-state', 'open', { timeout: 60_000 });
  await expect(page.getByTestId('local-remote-summary')).toContainText(`Over Tailscale only, at ${BOX}`);
  await page.getByTestId('local-remote-code-make').click();
  await expect(page.getByTestId('local-remote-code')).toHaveText(/^\d{4} \d{4}$/, { timeout: 30_000 });
  await expect(page.getByTestId('local-remote-code-left')).toContainText('expires in ');
  expect(await chineseIn(page, ['[data-testid="local-remote"]'])).toEqual([]);
  await block.screenshot({ path: join(screens, '473-remote-6-host-code.png') });
  await page.getByTestId('local-remote-cancel').click();
  await expect(page.getByTestId('local-remote-note')).toHaveText('The pairing code was voided.', { timeout: 30_000 });

  // a computer paired with a Chinese name: the name as written, the dialog English
  writeFileSync(join(r.state, 'devices.json'), JSON.stringify([{ id: '0123456789abcdef', name: '张三的笔记本', node: 'n1', node_name: 'laptop', key: '0'.repeat(64), paired_at: 1 }]));
  await page.getByTestId('local-remote-devices').click();
  await expect(page.getByTestId('local-remote-device')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('local-remote-device').locator('[data-verbatim="daemon"]').first()).toHaveText('张三的笔记本');
  await expect(page.getByTestId('confirm-dialog').locator('h3')).toHaveText('Paired computers');
  await expect(page.getByTestId('local-remote-revoke')).toHaveText('Revoke…');
  expect(await chineseIn(page, ['[data-testid="confirm-dialog"]'], LATER)).toEqual([]);
  await shot(page, '7-host-devices');
  await page.getByTestId('confirm-ok').click();
  await page.getByTestId('local-remote-switch').click();
  await expect(block).toHaveAttribute('data-state', 'closed', { timeout: 60_000 });
  expect(await chineseIn(page, ['[data-testid="local-remote"]'])).toEqual([]);
});
