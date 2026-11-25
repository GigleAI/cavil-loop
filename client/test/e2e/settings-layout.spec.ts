// GitHub#591: Settings and a project's settings dialog, 常用 / 高级 and the ⓘ explanations — the real window (test
// build), the real back end, and for the dialog the daemon's real scripts/project-config.sh on a project the real
// setup.sh connected (so where each setting goes comes from the daemon's own registry, scripts/config-fields.txt).
// The layout rule itself is unit-tested (test/unit/project-config.test.ts, configLayout; test/unit/info-tip.test.ts).

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { connect, daemonEnv, daemonWorld, dropWorlds, installByHand, pathFor, type DaemonWorld } from '../support/daemon-world';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = { timeout: 30_000 };

/** the daemon's registry as written: name → [tier, help] */
function registry(): Map<string, { tier: string; help: string }> {
  const out = new Map<string, { tier: string; help: string }>();
  for (const line of readFileSync(join(root, '..', 'scripts', 'config-fields.txt'), 'utf8').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const c = line.split('|').map((x) => x.trim());
    out.set(c[0], { tier: c[8], help: c[6] });
  }
  return out;
}

let env: AppEnv;
let w: DaemonWorld;
const running: RunningApp[] = [];
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-layout-'));
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

async function openSettings(): Promise<Page> {
  const path = pathFor(w);
  connect(w, 'widget', 'Darwin', path);
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
  await expect(page.getByTestId('settings')).toBeVisible();
  return page;
}

test('Settings: 常用 first, the 高级 cards folded at the bottom; going to one from the contents opens the block first', async () => {
  const page = await openSettings();
  const nav = page.getByTestId('settings-nav');
  await expect(nav.locator('a[data-tier=advanced]')).toHaveText(['流程标签', '顶栏计数', '快捷键', '远程 daemon']);
  await expect(nav.locator('a[data-tier=main]').first()).toContainText('语言');
  // folded: the cards are not on the page at all
  await expect(page.getByTestId('settings-advanced')).toHaveAttribute('data-open', 'false');
  for (const id of ['hand-back-settings', 'tally-settings', 'shortcut-settings', 'remote-settings']) await expect(page.getByTestId(id)).toHaveCount(0);
  // the common cards are there
  for (const id of ['language-settings', 'theme-settings', 'pending-settings', 'daemon-settings']) await expect(page.getByTestId(id)).toBeVisible();
  // the 本机 daemon card reads its status after the page is drawn and grows when it arrives: let it settle first, so
  // the jump below is not measured while the page above it is still changing length (GitHub#694)
  await expect(page.getByTestId('daemon-summary')).not.toHaveAttribute('data-state', 'loading', { timeout: 15_000 });
  // a click on 快捷键 in the contents: the block opens and the card is brought into view
  await nav.locator('a[href="#set-keys"]').click();
  await expect(page.getByTestId('settings-advanced')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('shortcut-settings')).toBeInViewport();
  for (const id of ['hand-back-settings', 'tally-settings', 'remote-settings']) await expect(page.getByTestId(id)).toHaveCount(1);
  // the block's own line closes it again
  await page.getByTestId('settings-advanced-toggle').click();
  await expect(page.getByTestId('shortcut-settings')).toHaveCount(0);
  // back to the board and in again: folded again
  await page.getByTestId('settings-advanced-toggle').click();
  await page.getByTestId('back').click();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-advanced')).toHaveAttribute('data-open', 'false');
});

test('Settings: a card\'s explanation is behind its ⓘ — hover, keyboard focus and a click show it; Esc hides it without leaving Settings', async () => {
  const page = await openSettings();
  const said = '窗口用浅色还是深色。看板、详情、讨论区、关系图、标签颜色和窗口标题栏一起换，选了立刻生效。';
  // no longer a line on the card, and the heading says only its own word
  await expect(page.getByTestId('theme-settings').getByText(said)).toHaveCount(0);
  await expect(page.getByTestId('theme-settings').locator('h3')).toHaveText('外观');
  const tip = page.getByTestId('theme-help-text');
  await expect(tip).toHaveText(said);
  await expect(tip).toBeHidden();
  await page.getByTestId('theme-help-button').hover();
  await expect(tip).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(tip).toBeHidden();
  // keyboard focus shows it (a real Shift+Tab from the first choice below the heading); Esc hides it and Settings stays
  // (Esc otherwise goes back to the board)
  await page.getByTestId('theme-system').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('theme-help-button')).toBeFocused();
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
  await expect(page.getByTestId('settings')).toBeVisible();
  // Tab away and back: keyboard focus opens it again
  await page.keyboard.press('Tab');
  await expect(tip).toBeHidden();
  await page.keyboard.press('Shift+Tab');
  await expect(tip).toBeVisible();
  await page.keyboard.press('Tab');
  // a click keeps it open after the pointer leaves
  const btn = page.getByTestId('theme-help-button');
  await btn.click();
  await expect(tip).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(tip).toBeVisible();
  // a second click closes it at once, with the pointer still resting on the ⓘ (PR #596 review round 1)
  await btn.click();
  await expect(tip).toBeHidden();
  await page.waitForTimeout(500);
  await expect(tip).toBeHidden();
  // also when both clicks happen without the pointer leaving in between (it leaves once, comes back, then clicks twice)
  await page.mouse.move(5, 5);
  await btn.hover();
  await expect(tip).toBeVisible();
  await btn.click();
  await expect(tip).toBeVisible();
  await btn.click();
  await expect(tip).toBeHidden();
  // the next hover opens it again
  await page.mouse.move(5, 5);
  await btn.hover();
  await expect(tip).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(tip).toBeHidden();
  // the screen reader reads it as the button's description
  const describedBy = await page.getByTestId('theme-help-button').getAttribute('aria-describedby');
  expect(await tip.getAttribute('id')).toBe(describedBy);
  // a field's own line too: 「运行中」 in the flow labels
  await page.getByTestId('settings-nav').locator('a[href="#set-hand-back"]').click();
  await expect(page.getByTestId('hand-back-running-hint')).toHaveText('顶栏「运行中」、标签页的运行图标；留空 = 不用');
  await expect(page.getByTestId('hand-back-running-hint')).toBeHidden();
  await page.getByTestId('hand-back-running-help-button').hover();
  await expect(page.getByTestId('hand-back-running-hint')).toBeVisible();
});

test('Settings: once closed (Esc or a second click), nothing already true reopens the ⓘ — not the pointer still on it, not the focus still on it; a new hover, Tab or click does (PR #596 review rounds 1–2)', async () => {
  const page = await openSettings();
  const btn = page.getByTestId('theme-help-button');
  const tip = page.getByTestId('theme-help-text');
  const leave = () => page.mouse.move(5, 5);
  // keyboard focus on the ⓘ: a real Shift+Tab from the first choice under the heading
  const keyboardIn = async () => {
    await page.getByTestId('theme-system').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(btn).toBeFocused();
  };
  const keyboardOut = () => page.keyboard.press('Tab');
  /** closed, and stays closed for a while — nothing reopens it by itself */
  const staysClosed = async () => {
    await expect(tip).toBeHidden();
    await page.waitForTimeout(400);
    await expect(tip).toBeHidden();
  };
  const reset = async () => {
    await leave();
    await page.getByTestId('theme-system').focus();
    await expect(tip).toBeHidden();
  };

  // ① keyboard focus + hover, Esc, then only the pointer leaves (the round-2 case): stays closed
  await reset();
  await keyboardIn();
  await btn.hover();
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await staysClosed();
  await leave();
  await staysClosed();
  await expect(btn).toBeFocused();
  // a new hover opens it; leaving again closes it (the old focus does not hold it open)
  await btn.hover();
  await expect(tip).toBeVisible();
  await leave();
  await staysClosed();
  // a new keyboard focus opens it
  await keyboardOut();
  await keyboardIn();
  await expect(tip).toBeVisible();

  // ② keyboard focus only, Esc: stays closed; the pointer passing over opens it, leaving closes it again
  await reset();
  await keyboardIn();
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await staysClosed();
  await btn.hover();
  await expect(tip).toBeVisible();
  await leave();
  await staysClosed();

  // ③ hover only, Esc: stays closed while the pointer rests there; leave and come back opens it
  await reset();
  await btn.hover();
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await staysClosed();
  await leave();
  await staysClosed();
  await btn.hover();
  await expect(tip).toBeVisible();

  // ④ kept open by a click with keyboard focus and the pointer on it; the second click closes it at once, and neither
  //    the pointer leaving nor the focus staying brings it back
  await reset();
  await keyboardIn();
  await btn.click();
  await expect(tip).toBeVisible();
  await btn.click();
  await staysClosed();
  await leave();
  await staysClosed();
  // a new click keeps it open again; a click elsewhere on the page lets it go
  await btn.click();
  await leave();
  await expect(tip).toBeVisible();
  await page.getByTestId('theme-settings').locator('h3').click({ position: { x: 2, y: 2 } });
  await staysClosed();

  // ⑤ kept open by a click, pointer gone; Esc closes it; hovering again opens it, leaving closes it (no longer kept)
  await reset();
  await btn.click();
  await leave();
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await staysClosed();
  await expect(page.getByTestId('settings')).toBeVisible();
  await btn.hover();
  await expect(tip).toBeVisible();
  await leave();
  await staysClosed();
});

test('Settings: a common card\'s less used option is under its own 「高级」', async () => {
  const page = await openSettings();
  await expect(page.getByTestId('clear-all-on-activate')).toHaveCount(0);
  await page.getByTestId('pending-card-more-toggle').click();
  await expect(page.getByTestId('clear-all-on-activate')).toBeVisible();
  await page.getByTestId('clear-all-on-activate').check();
  await expect(page.getByTestId('clear-all-on-activate')).toBeChecked();
  // the account card: sign-in method under 「高级」; the Client ID in use fits, so it is folded
  await expect(page.getByTestId('account-card-more')).toHaveAttribute('data-open', 'false');
  await expect(page.getByTestId('app-kind')).toHaveCount(0);
  await page.getByTestId('account-card-more-toggle').click();
  await expect(page.getByTestId('app-kind')).toBeVisible();
});

test('project settings: opens with the 18 common ones; each group\'s 「高级」 and the 高级设置 block hold the rest, all 86 there; a changed value keeps its fold open', async () => {
  const page = await openSettings();
  const reg = registry();
  await page.getByTestId('daemon-settings').scrollIntoViewIfNeeded();
  await page.locator('[data-testid=daemon-project][data-key=widget]').getByTestId('daemon-config').click();
  await expect(page.getByTestId('config-dialog')).toHaveAttribute('data-phase', 'form', SCRIPT);
  const rows = page.locator('[data-testid=config-row]');
  const names = async () => (await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-name') ?? ''))).sort();
  const want = (t: string[]) => [...reg].filter(([, v]) => t.includes(v.tier)).map(([k]) => k).sort();
  // at first: the main ones only, every one of them
  expect(await names()).toEqual(want(['main']));
  expect(want(['main']).length).toBe(18);
  // each row's explanation is the registry's help, behind its ⓘ
  const help = page.getByTestId('config-help-MAX_CONCURRENT_WORKERS-text');
  await expect(help).toHaveText(reg.get('MAX_CONCURRENT_WORKERS')!.help);
  await expect(help).toBeHidden();
  await page.locator('[data-testid=config-row][data-name=MAX_CONCURRENT_WORKERS]').getByTestId('config-help-MAX_CONCURRENT_WORKERS-button').hover();
  await expect(help).toBeVisible();
  // Esc hides the tip and keeps the dialog open
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(page.getByTestId('config-dialog')).toBeVisible();
  // a read-only row's reason stays in sight
  await expect(page.locator('[data-testid=config-row][data-name=DISPATCH_MODE] [data-testid=config-why]')).toBeVisible();
  // open every group's 「高级」: the more ones join
  const toggles = page.getByTestId('config-more-toggle');
  for (let i = 0; i < (await toggles.count()); i++) await toggles.nth(i).click();
  expect(await names()).toEqual(want(['main', 'more']));
  // the block at the bottom: the advanced groups, and now every registered setting is on the dialog
  await page.getByTestId('config-adv-toggle').click();
  expect(await names()).toEqual([...reg.keys()].sort());
  expect(reg.size).toBe(86);
  // change one in the block and one under a group's 「高级」: neither fold closes while the change is unsaved
  await page.getByTestId('config-input-POLL_DUE_SLACK_SECS').fill('20');
  await page.getByTestId('config-input-DISPATCH_MAX_RETRIES').fill('5');
  await page.getByTestId('config-adv-toggle').click();
  await expect(page.getByTestId('config-adv')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('config-adv-toggle-held')).toBeVisible();
  const retries = page.locator('[data-testid=config-group-more][data-group=派工与重试]');
  await retries.getByTestId('config-more-toggle').click();
  await expect(retries).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('config-pending')).toContainText('2');
  // undo both: the folds can close again
  await page.getByTestId('config-input-POLL_DUE_SLACK_SECS').fill('10');
  await page.getByTestId('config-input-DISPATCH_MAX_RETRIES').fill('3');
  await page.getByTestId('config-adv-toggle').click();
  await expect(page.getByTestId('config-adv')).toHaveAttribute('data-open', 'false');
  await expect(page.locator('[data-testid=config-row][data-name=POLL_DUE_SLACK_SECS]')).toHaveCount(0);
});
