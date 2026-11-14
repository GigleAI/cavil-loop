// Settings → 远程 daemon (GitHub#387): the real window, the real back end, and the daemon's real
// remote-access service behind a stand-in for Tailscale's HTTPS forwarding
// (test/support/remote-world.ts). Pairing, the machine's projects, stop / start only after the
// confirmation, the log, a machine that cannot be reached (old status greyed out, no actions),
// and the two ways unpairing ends — confirmed by the machine, or left as "取消配对未完成".

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { connect, daemonEnv, daemonWorld, dropWorlds, installByHand, keepTmp, pathFor, type DaemonWorld } from '../support/daemon-world';
import { BOX, arrived, closeRemote, devices, installFakeTailscale, pairCode, remoteWorld, setHosts, type RemoteWorld } from '../support/remote-world';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

let env: AppEnv;
let w: DaemonWorld;
let r: RemoteWorld;
let path: string;
const running: RunningApp[] = [];

test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-remote-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  w = daemonWorld(join(dir, 'machine'));
  installFakeTailscale(w);
  installByHand(w);
  path = pathFor(w);
  connect(w, 'widget', 'Linux', path);
  r = await remoteWorld(w, path);
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

/** `local`: the app also runs on the machine itself (its 本机 daemon section, its Tailscale) */
async function openSection(local = false, extra: Record<string, string> = {}): Promise<{ app: RunningApp; page: Page }> {
  const app = await launchApp(env, { backendEnv: { ...(local ? daemonEnv(w, { os: 'Linux', path, extra: { FAKE_TS: r.ts, ...extra } }) : {}), ...r.env } });
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

test("「配置…」on a project of that machine: the same form, saved there; no editor; a machine too old says so (GitHub#530)", async () => {
  const { app, page } = await openSection();
  await pairInWindow(page);
  const host = page.locator(`[data-testid=remote-host][data-id="${BOX}:47387"]`);
  await expect(host).toHaveAttribute('data-state', 'ok');
  const row = host.locator('[data-testid=remote-project][data-key=widget]');
  const st = await app.backend.call('remoteStatus', { id: `${BOX}:47387` });
  const config = st.status.projects[0].config as string;
  const before = readFileSync(config, 'utf8');
  await shot(page, '10-config-button');

  await row.getByTestId('remote-config').click();
  const dialog = page.getByTestId('config-dialog');
  await expect(dialog).toHaveAttribute('data-remote', 'true');
  await expect(dialog).toHaveAttribute('data-phase', 'form');
  await expect(page.getByTestId('config-remote')).toHaveText('（在远程机器 box 上）');
  await expect(page.getByTestId('config-path')).toHaveText(config);
  await expect(page.getByTestId('config-intro')).toContainText('不要同时在那台机器上用编辑器改这个文件');
  // the file is on the other machine: no editor button, a sentence instead
  await expect(page.getByTestId('config-open-editor')).toHaveCount(0);
  await expect(page.getByTestId('config-no-editor')).toBeVisible();
  const input = page.getByTestId('config-input-MAX_CONCURRENT_WORKERS');
  await expect(input).toHaveValue('1');
  await input.fill('3');
  await expect(page.getByTestId('config-pending')).toHaveText('已改 1 项，还没保存');
  await page.locator('.modal.pcfg').screenshot({ path: join(screens, 'remote-11-config-form.png') });
  // nothing is sent before "保存"
  expect(sent(app, 'remoteConfigSet')).toEqual([]);
  expect(readFileSync(config, 'utf8')).toBe(before);

  await page.getByTestId('config-save').click();
  const result = page.getByTestId('config-result');
  await expect(result).toHaveAttribute('data-kind', 'saved');
  await expect(page.locator('[data-testid=config-change][data-name=MAX_CONCURRENT_WORKERS]')).toContainText('3');
  expect(sent(app, 'remoteConfigSet').map((c) => c.args)).toEqual([{ id: `${BOX}:47387`, key: 'widget', rev: expect.any(String), values: { MAX_CONCURRENT_WORKERS: '3' } }]);
  // on that machine's disk: that one line, nothing else
  const a = before.split('\n');
  const now = readFileSync(config, 'utf8').split('\n');
  expect(now.filter((l) => l.startsWith('MAX_CONCURRENT_WORKERS='))).toEqual(['MAX_CONCURRENT_WORKERS=3']);
  expect(now.filter((l, i) => l !== a[i]).length).toBe(1);
  // the machine was read again after the save
  await expect.poll(() => sent(app, 'remoteStatus').length).toBeGreaterThan(1);

  // a save carried out whose answer cannot be verified (the signature lost on the way): "unknown", not "nothing written"
  await page.getByTestId('config-more').click();
  await expect(dialog).toHaveAttribute('data-phase', 'form');
  await page.getByTestId('config-input-MAX_CONCURRENT_WORKERS').fill('4');
  writeFileSync(r.replySig, 'drop');
  await page.getByTestId('config-save').click();
  await expect(result).toHaveAttribute('data-kind', 'unknown');
  await expect(result).toContainText('保存没有给出最终结果');
  await expect(result).not.toContainText('一个字都没动');
  rmSync(r.replySig, { force: true });
  expect(readFileSync(config, 'utf8').split('\n').filter((l) => l.startsWith('MAX_CONCURRENT_WORKERS='))).toEqual(['MAX_CONCURRENT_WORKERS=4']);
  await page.locator('.modal.pcfg').screenshot({ path: join(screens, 'remote-12-config-unknown.png') });
  await page.getByTestId('config-reload').click();
  await expect(page.getByTestId('config-input-MAX_CONCURRENT_WORKERS')).toHaveValue('4');
  await page.getByTestId('config-cancel').click();
  await expect(dialog).toHaveCount(0);

  // the same machine whose code on disk was updated while its resident entry still runs code from
  // before GitHub#530 (GitHub#533): said as "updated, not restarted" with the restart command — not
  // "update the daemon", not "cannot read". The stand-in entry knows no config request and reports
  // no running code (as one started before GitHub#533); the status still reads the code on disk.
  await closeRemote(r);
  const file = join(w.skill, 'scripts/remote-access/remote_access.py');
  const cur = readFileSync(file, 'utf8');
  const old = cur.replace('(stop|start|log|config)', '(stop|start|log)').replace(', "entry": svc.running}', '}');
  expect(old).not.toEqual(cur);
  writeFileSync(file, old);
  // restarted at the same place: the paired devices and this computer's key are kept
  r = await remoteWorld(w, path);
  await host.getByTestId('remote-reload').click();
  await expect(host).toHaveAttribute('data-state', 'ok');
  await row.getByTestId('remote-config').click();
  await expect(page.getByTestId('config-unsupported')).toContainText('远程入口还在跑更新前的代码');
  await expect(page.getByTestId('config-unsupported')).toContainText('systemctl --user try-restart cavil-loop-remote.service');
  await expect(page.getByTestId('config-unsupported')).not.toContainText('版本太旧');
  await expect(page.getByTestId('config-read-failed')).toHaveCount(0);
  await expect(page.getByTestId('config-save')).toHaveCount(0);
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
  const out = spawnSync('bash', ['-c', cmd], { env: { ...keepTmp(), HOME: w.home, PATH: pathFor(w), FAKE_TS: r.ts, FAKE_SD: w.sd, FAKE_LD: w.ld }, encoding: 'utf8' });
  expect(out.stdout).toContain('已撤销');
  expect(devices(r)).toEqual([]);
  await host.getByTestId('remote-forget').click();
  await expect(page.getByTestId('remote-host')).toHaveCount(0);
});

test('removing a "取消配对未完成" row that the back end cannot remove: the row stays, the reason stays on screen, a retry then works (PR #400 review)', async () => {
  const { page } = await openSection();
  await pairInWindow(page);
  const host = page.getByTestId('remote-host');
  await expect(host).toHaveAttribute('data-state', 'ok');
  offTailscale();
  await host.getByTestId('remote-unpair').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('remote-unpair-text')).toHaveAttribute('data-offline', 'true');
  await page.getByTestId('confirm-ok').click();
  await expect(host).toHaveAttribute('data-state', 'pending');
  // another connection holds the app's real database write lock: the back end's remove really fails
  const { spawn } = await import('node:child_process');
  const lock = spawn('python3', ['-I', '-c', [
    'import sqlite3, sys',
    'c = sqlite3.connect(sys.argv[1], isolation_level=None)',
    'c.execute("BEGIN IMMEDIATE")',
    'print("locked", flush=True)',
    'sys.stdin.readline()',
    'c.execute("ROLLBACK")',
  ].join('\n'), join(env.userData, 'cache.sqlite')], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((ok, bad) => {
      lock.stdout.on('data', (d) => String(d).includes('locked') && ok());
      lock.on('exit', (c) => bad(new Error(`lock holder exited ${c}`)));
    });
    await host.getByTestId('remote-forget').click();
    const note = host.getByTestId('remote-note');
    await expect(note).toContainText('没能从列表里移除', { timeout: 20_000 });
    await expect(note).toContainText('database is locked');
    await expect(note).toHaveAttribute('data-ok', 'false');
    // the list read that follows the failure has finished: the row and its reason are both still there
    await expect(host.getByTestId('remote-forget')).toBeEnabled();
    await page.waitForTimeout(500);
    await expect(host).toHaveAttribute('data-state', 'pending');
    await expect(note).toBeVisible();
    await page.screenshot({ path: join(screens, 'remote-13-forget-failed.png') });
  } finally {
    lock.stdin.end('\n');
    await new Promise((ok) => (lock.exitCode !== null ? ok(null) : lock.on('exit', ok)));
  }
  // the lock is gone: the same button now removes the row
  await host.getByTestId('remote-forget').click();
  await expect(page.getByTestId('remote-host')).toHaveCount(0);
  await expect(page.getByTestId('remote-empty')).toBeVisible();
});

// GitHub#387 round 7: pairing without a terminal
test('pick the machine from this computer’s Tailscale: open ones first, how to open a closed one, offline cannot be picked', async () => {
  writeFileSync(join(r.ts, 'certdomain'), 'me.tailnet.ts.net');
  const peer = (name: string, online: boolean) => ({ HostName: name, DNSName: `${name}.tailnet.ts.net.`, OS: 'linux', Online: online });
  writeFileSync(join(r.ts, 'peers.json'), JSON.stringify({ a: peer('shut', true), b: peer('box', true), c: peer('phone', false) }));
  setHosts(r, { [BOX]: { resolves: ['100.64.0.5'], connect: `127.0.0.1:${r.frontPort}` }, 'shut.tailnet.ts.net': { resolves: ['100.64.0.6'], connect: '127.0.0.1:1' } });
  const { app, page } = await openSection(true);
  await page.getByTestId('remote-add').click();
  const rows = page.getByTestId('remote-tailnet-device');
  await expect(rows).toHaveCount(3, { timeout: 20_000 });
  await expect(rows.nth(0)).toHaveAttribute('data-host', BOX);
  await expect(rows.nth(0)).toHaveAttribute('data-remote', 'open');
  await expect(rows.nth(1)).toHaveAttribute('data-remote', 'closed');
  await expect(rows.nth(2)).toHaveAttribute('data-remote', 'offline');
  // no name field to copy into while the list is there
  await expect(page.getByTestId('remote-pair-host')).toHaveCount(0);
  // a closed one: how to open it there, with the command
  await rows.nth(1).click();
  await expect(page.getByTestId('remote-not-open')).toHaveAttribute('data-remote', 'closed');
  await expect(page.getByTestId('remote-not-open').getByTestId('remote-command')).toHaveText('bash ~/.agents/skills/cavil-loop/scripts/remote-access.sh pair');
  // offline: cannot pair even with a code typed
  await rows.nth(2).click();
  await page.getByTestId('remote-pair-code').fill('1234 5678');
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  // the open one: pick, type the code, paired
  await rows.nth(0).click();
  await expect(page.getByTestId('remote-not-open')).toHaveCount(0);
  await page.screenshot({ path: join(screens, 'remote-9-pick.png') });
  const code = pairCode(w, r);
  await page.getByTestId('remote-pair-code').fill(code);
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('remote-host')).toHaveCount(1);
  expect(sent(app, 'remotePair').map((c) => (c.args as { host: string }).host)).toEqual([BOX]);
  expect(devices(r)).toHaveLength(1);
  // "手动输入机器名" is still there
  await page.getByTestId('remote-add').click();
  await page.getByTestId('remote-pair-manual').click();
  await expect(page.getByTestId('remote-pair-host')).toBeVisible();
});

test('this machine’s own switch: on, a code in the window, void it, the paired computers, off — no terminal', async () => {
  const { page } = await openSection(true);
  const block = page.getByTestId('local-remote');
  // GitHub#523: until its status is read the block is a placeholder that is then replaced; scroll to the real one
  await expect(block).toHaveAttribute('data-state', 'closed', { timeout: 30_000 });
  await block.scrollIntoViewIfNeeded();
  const sw = page.getByTestId('local-remote-switch');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  await expect(block).toHaveAttribute('data-state', 'open', { timeout: 60_000 });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('local-remote-code-make').click();
  const shown = page.getByTestId('local-remote-code');
  await expect(shown).toHaveText(/^\d{4} \d{4}$/, { timeout: 30_000 });
  await expect(page.getByTestId('local-remote-code-left')).toContainText('后失效');
  await block.screenshot({ path: join(screens, 'remote-10-host-code.png') });
  await page.screenshot({ path: join(screens, 'remote-11-host-page.png') });
  const code = (await shown.textContent())!.replace(/\D/g, '');
  const pending = JSON.parse(readFileSync(join(r.state, 'pairing.json'), 'utf8'));
  expect(pending.hash).toBe((await import('node:crypto')).createHash('sha256').update(code).digest('hex'));
  await page.getByTestId('local-remote-cancel').click();
  await expect(page.getByTestId('local-remote-code-make')).toBeVisible({ timeout: 30_000 });
  expect(existsSync(join(r.state, 'pairing.json'))).toBe(false);
  // the paired computers (one paired by hand), revoke it after the confirmation
  writeFileSync(join(r.state, 'devices.json'), JSON.stringify([{ id: '0123456789abcdef', name: 'MacBook', node: 'n1', node_name: 'macbook', key: '0'.repeat(64), paired_at: 1 }]));
  await page.getByTestId('local-remote-devices').click();
  await expect(page.getByTestId('local-remote-device')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('local-remote-revoke').click();
  await expect(page.getByTestId('local-remote-revoke-text')).toContainText('MacBook');
  expect(devices(r)).toHaveLength(1);
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('local-remote-devices-none')).toBeVisible({ timeout: 30_000 });
  expect(devices(r)).toEqual([]);
  await page.getByTestId('confirm-ok').click();
  await sw.click();
  await expect(block).toHaveAttribute('data-state', 'closed', { timeout: 60_000 });
});

test('a revoke that fails stays on screen after the list is read again; the computer is still listed (PR #400 review round 8)', async () => {
  // a thin wrapper in front of the real script: `revoke` fails the way the real script reports a
  // failure (exit 3), every other command — the list read included — is the real script
  const dir = join(w.skill, 'scripts');
  execFileSync('mv', [join(dir, 'remote-access.sh'), join(dir, 'remote-access.real.sh')]);
  writeFileSync(
    join(dir, 'remote-access.sh'),
    `#!/usr/bin/env bash
echo "$*" >> "$FAKE_TS/wrapper-calls"
d="$(cd "$(dirname "$0")" && pwd)"
[ "$1" = revoke ] && { echo "devices.json 写不进去"; exit 3; }
exec bash "$d/remote-access.real.sh" "$@"
`,
  );
  writeFileSync(join(r.state, 'devices.json'), JSON.stringify([{ id: '0123456789abcdef', name: 'MacBook', node: 'n1', node_name: 'macbook', key: '0'.repeat(64), paired_at: 1 }]));
  const { page } = await openSection(true);
  // GitHub#523: until its status is read the block is a placeholder that is then replaced (scrolling to it failed
  // with "not attached" when that happened mid-scroll); scroll to the real one
  await expect(page.getByTestId('local-remote')).not.toHaveAttribute('data-state', 'reading', { timeout: 30_000 });
  await page.getByTestId('local-remote').scrollIntoViewIfNeeded();
  await page.getByTestId('local-remote-devices').click();
  await expect(page.getByTestId('local-remote-device')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('local-remote-revoke').click();
  await page.getByTestId('confirm-ok').click();
  const err = page.getByTestId('local-remote-revoke-error');
  await expect(err).toContainText('没有确认撤销 MacBook', { timeout: 30_000 });
  await expect(err).toContainText('devices.json 写不进去');
  // the list was read again (successfully) and still shows the computer, which really is still authorized
  const calls = () => readFileSync(join(r.ts, 'wrapper-calls'), 'utf8').trim().split('\n');
  // GitHub#523: after a revoke the dialog reads the list again and then the block reads its status (the paired
  // count) — a fixed order, so look at what came right after the revoke, not at the last two calls: those are
  // the list and then the status once the status read has landed too
  const afterRevoke = () => {
    const c = calls();
    return c.slice(c.lastIndexOf('revoke 0123456789abcdef'));
  };
  await expect.poll(() => afterRevoke()).toEqual(['revoke 0123456789abcdef', 'list --machine', 'status']);
  await expect(page.getByTestId('local-remote-device')).toHaveCount(1);
  await expect(page.getByTestId('local-remote-devices-error')).toHaveCount(0);
  expect(devices(r)).toHaveLength(1);
  // …and the error is still there once that read has finished
  await page.waitForTimeout(500);
  await expect(err).toBeVisible();
  await page.screenshot({ path: join(screens, 'remote-12-revoke-failed.png') });
});
