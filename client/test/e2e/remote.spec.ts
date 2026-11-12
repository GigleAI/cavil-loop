// Settings → 远程 daemon (GitHub#387): the real window, the real back end, and the daemon's real
// remote-access service behind a stand-in for Tailscale's HTTPS forwarding
// (test/support/remote-world.ts). Pairing, the machine's projects, stop / start only after the
// confirmation, the log, a machine that cannot be reached (old status greyed out, no actions),
// and the two ways unpairing ends — confirmed by the machine, or left as "取消配对未完成".

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { connect, daemonWorld, installByHand, pathFor, type DaemonWorld } from '../support/daemon-world';
import { BOX, arrived, closeRemote, devices, installFakeTailscale, pairCode, remoteWorld, setHosts, type RemoteWorld } from '../support/remote-world';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

let env: AppEnv;
let w: DaemonWorld;
let r: RemoteWorld;
const running: RunningApp[] = [];

test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-remote-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  w = daemonWorld(join(dir, 'machine'));
  installFakeTailscale(w);
  installByHand(w);
  const path = pathFor(w);
  connect(w, 'widget', 'Linux', path);
  r = await remoteWorld(w, path);
});
test.afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close()));
  await closeRemote(r);
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

async function openSection(): Promise<{ app: RunningApp; page: Page }> {
  const app = await launchApp(env, { backendEnv: r.env });
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
  await page.getByTestId('remote-settings').scrollIntoViewIfNeeded();
  return { app, page };
}

const shot = (page: Page, name: string) => page.getByTestId('remote-settings').screenshot({ path: join(screens, `remote-${name}.png`) });
const sent = (app: RunningApp, cmd: string) => app.backend.sent.filter((c) => c.cmd === cmd);
const offTailscale = () => setHosts(r, {});
const onTailscale = () => setHosts(r, { [BOX]: { resolves: ['100.64.0.5'], connect: `127.0.0.1:${r.frontPort}` } });
const active = () => readFileSync(join(w.sd, 'cavil-loop-poll@widget.timer.active'), 'utf8').trim();

async function pairInWindow(page: Page) {
  await page.getByTestId('remote-add').click();
  await page.getByTestId('remote-pair-host').fill(BOX);
  const code = pairCode(w, r);
  await page.getByTestId('remote-pair-code').fill(`${code.slice(0, 4)} ${code.slice(4)}`);
  await page.getByTestId('confirm-ok').click();
}

test('pair, see the machine’s projects, stop and start only after the confirmation, read the log', async () => {
  const { app, page } = await openSection();
  await expect(page.getByTestId('remote-empty')).toBeVisible();
  await shot(page, '1-empty');

  // the dialog: nothing is sent until "配对"; "配对" stays off until both fields are filled
  await page.getByTestId('remote-add').click();
  await expect(page.getByTestId('remote-pair-dialog')).toBeVisible();
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  await page.getByTestId('remote-pair-host').fill(BOX);
  await page.getByTestId('remote-pair-code').fill('1234');
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  await page.screenshot({ path: join(screens, 'remote-2-pair-dialog.png') });
  expect(sent(app, 'remotePair')).toEqual([]);
  // a wrong code: that machine's words, the dialog stays
  const code = pairCode(w, r);
  const wrong = String((Number(code) + 1) % 100000000).padStart(8, '0');
  await page.getByTestId('remote-pair-code').fill(wrong);
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('remote-pair-error')).toHaveAttribute('data-reason', 'pairing_wrong');
  await expect(page.getByTestId('remote-host')).toHaveCount(0);
  await page.getByTestId('remote-pair-code').fill(`${code.slice(0, 4)} ${code.slice(4)}`);
  await page.getByTestId('confirm-ok').click();

  const host = page.locator(`[data-testid=remote-host][data-id="${BOX}:47387"]`);
  await expect(host).toHaveAttribute('data-state', 'ok');
  await expect(host.getByTestId('remote-pill')).toHaveText('已连接');
  const row = host.locator('[data-testid=remote-project][data-key=widget]');
  await expect(row).toHaveAttribute('data-state', 'running');
  await expect(row).toContainText('acme/widget');
  await expect(row).toContainText('claude');
  await expect(row.getByTestId('remote-start')).toHaveCount(0);
  expect(devices(r)).toHaveLength(1);
  await shot(page, '3-connected');

  // stop: the question first; "取消" sends nothing
  await row.getByTestId('remote-stop').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
  expect(sent(app, 'remoteService')).toEqual([]);
  expect(active()).toBe('active');
  await row.getByTestId('remote-stop').click();
  await page.getByTestId('confirm-ok').click();
  await expect(row).toHaveAttribute('data-state', 'stopped');
  expect(sent(app, 'remoteService').map((c) => c.args)).toEqual([{ id: `${BOX}:47387`, key: 'widget', action: 'stop' }]);
  expect(active()).toBe('inactive');
  await expect(row.getByTestId('remote-stop')).toHaveCount(0);
  await row.getByTestId('remote-start').click();
  await page.getByTestId('confirm-ok').click();
  await expect(row).toHaveAttribute('data-state', 'running');
  expect(active()).toBe('active');

  // the log: the last lines as that machine has them
  const stateDir = (await app.backend.call('remoteStatus', { id: `${BOX}:47387` })).status.projects[0].state_dir;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'poll.log'), '[widget] poll: idle\n[widget] dispatch-new-issue #7\n');
  await row.getByTestId('remote-log').click();
  await expect(page.getByTestId('remote-log-text')).toContainText('[widget] dispatch-new-issue #7');
  await page.screenshot({ path: join(screens, 'remote-4-log.png') });
  await page.getByTestId('remote-log-close').click();
  await expect(page.getByTestId('remote-log-dialog')).toHaveCount(0);
});

test('this computer is not on Tailscale: pairing is refused, says nothing was sent, and nothing arrived', async () => {
  const { page } = await openSection();
  offTailscale();
  await pairInWindow(page);
  const err = page.getByTestId('remote-pair-error');
  await expect(err).toHaveAttribute('data-reason', 'not_tailscale');
  await expect(err).toContainText('没有发出任何内容');
  await page.screenshot({ path: join(screens, 'remote-5-pair-refused.png') });
  expect(arrived(r)).toEqual([]);
  expect(devices(r)).toEqual([]);
  // an address instead of a name
  await page.getByTestId('remote-pair-host').fill('100.64.0.5');
  await page.getByTestId('confirm-ok').click();
  await expect(err).toHaveAttribute('data-reason', 'bad_host');
  expect(arrived(r)).toEqual([]);
  // back on Tailscale, the same dialog pairs
  onTailscale();
  await page.getByTestId('remote-pair-host').fill(BOX);
  await page.getByTestId('remote-pair-code').fill(pairCode(w, r));
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('remote-host')).toHaveAttribute('data-state', 'ok');
});

test('a machine that cannot be reached: the reason, the last status greyed out with no actions; unpairing then stays "未完成" until the machine confirms', async () => {
  const { app, page } = await openSection();
  await pairInWindow(page);
  const host = page.getByTestId('remote-host');
  await expect(host).toHaveAttribute('data-state', 'ok');

  offTailscale();
  await host.getByTestId('remote-reload').click();
  await expect(host).toHaveAttribute('data-state', 'failed');
  await expect(host.getByTestId('remote-problem')).toHaveAttribute('data-kind', 'not_tailscale');
  await expect(host.getByTestId('remote-problem')).toContainText('下面是上次读到的内容，不能操作');
  await expect(host.getByTestId('remote-projects')).toHaveAttribute('data-live', 'false');
  await expect(host.getByTestId('remote-project-state')).toContainText('在跑（上次读到）');
  await expect(host.getByTestId('remote-stop')).toHaveCount(0);
  await expect(host.getByTestId('remote-start')).toHaveCount(0);
  await expect(host.getByTestId('remote-log')).toHaveCount(0);
  await shot(page, '6-unreachable');

  // unpair while unreachable: the question says the machine's authorization cannot be revoked now
  await host.getByTestId('remote-unpair').click();
  const text = page.getByTestId('remote-unpair-text');
  await expect(text).toHaveAttribute('data-offline', 'true');
  await expect(text).toContainText('它上面的授权这次撤销不了');
  await page.screenshot({ path: join(screens, 'remote-7-unpair-offline.png') });
  await page.getByTestId('confirm-cancel').click();
  expect(sent(app, 'remoteUnpair')).toEqual([]);
  await host.getByTestId('remote-unpair').click();
  await page.getByTestId('confirm-ok').click();
  await expect(host).toHaveAttribute('data-state', 'pending');
  await expect(host.getByTestId('remote-pill')).toHaveText('取消配对未完成');
  await expect(host.getByTestId('remote-pending')).toContainText('那台机器上的授权还没有撤销');
  await expect(host.getByTestId('remote-command')).toHaveText(`bash ~/.agents/skills/cavil-loop/scripts/remote-access.sh revoke ${devices(r)[0].id}`);
  await expect(host.getByTestId('remote-projects')).toHaveCount(0);
  expect(devices(r)).toHaveLength(1);
  await shot(page, '8-pending');

  // still unreachable: "再试一次" says so and the row stays
  await host.getByTestId('remote-retry').click();
  await expect(host.getByTestId('remote-note')).toContainText('还是没能让那台机器确认撤销');
  await expect(host).toHaveAttribute('data-state', 'pending');
  // the command shown is the one that works on that machine: run it there as written
  onTailscale();
  await host.getByTestId('remote-retry').click();
  await expect(page.getByTestId('remote-host')).toHaveCount(0);
  await expect(page.getByTestId('remote-empty')).toBeVisible();
  expect(devices(r)).toEqual([]);
});

test('unpairing a reachable machine: asked first, confirmed by the machine, then gone on both sides', async () => {
  const { app, page } = await openSection();
  await pairInWindow(page);
  const host = page.getByTestId('remote-host');
  await expect(host).toHaveAttribute('data-state', 'ok');
  await host.getByTestId('remote-unpair').click();
  await expect(page.getByTestId('remote-unpair-text')).toHaveAttribute('data-offline', 'false');
  await page.screenshot({ path: join(screens, 'remote-9-unpair-online.png') });
  expect(sent(app, 'remoteUnpair')).toEqual([]);
  expect(devices(r)).toHaveLength(1);
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('remote-host')).toHaveCount(0);
  expect(devices(r)).toEqual([]);
  expect(sent(app, 'remoteUnpair').map((c) => c.args)).toEqual([{ id: `${BOX}:47387`, localOnly: false }]);
});

test('"已在那台机器上取消": the revoke command shown really revokes there, and the row can then be dropped', async () => {
  const { page } = await openSection();
  await pairInWindow(page);
  const host = page.getByTestId('remote-host');
  await expect(host).toHaveAttribute('data-state', 'ok');
  // the window still shows it as connected when the network goes: the first question is the "reachable" one
  offTailscale();
  await host.getByTestId('remote-unpair').click();
  await expect(page.getByTestId('remote-unpair-text')).toHaveAttribute('data-offline', 'false');
  await page.getByTestId('confirm-ok').click();
  // the machine did not confirm: nothing changed here yet, and the question is asked again with what that means
  await expect(page.getByTestId('remote-unpair-text')).toHaveAttribute('data-offline', 'true');
  await expect(page.getByTestId('remote-unpair-reason')).toContainText('无法确认这条连接经过 Tailscale');
  expect(devices(r)).toHaveLength(1);
  await page.getByTestId('confirm-ok').click();
  await expect(host).toHaveAttribute('data-state', 'pending');
  // run the command the window shows, on "that machine", as written (~ is its HOME)
  const cmd = await host.getByTestId('remote-command').innerText();
  const { spawnSync } = await import('node:child_process');
  const out = spawnSync('bash', ['-c', cmd], { env: { HOME: w.home, PATH: pathFor(w), FAKE_TS: r.ts, FAKE_SD: w.sd, FAKE_LD: w.ld }, encoding: 'utf8' });
  expect(out.stdout).toContain('已撤销');
  expect(devices(r)).toEqual([]);
  await host.getByTestId('remote-forget').click();
  await expect(page.getByTestId('remote-host')).toHaveCount(0);
});
