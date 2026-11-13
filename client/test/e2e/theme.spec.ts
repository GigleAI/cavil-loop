// GitHub#516: light / dark chosen in Settings — the real window (test build) and the real back end
// against the fake GitHub. "跟随系统" (default) follows the system's light / dark as before; light or
// dark holds whatever the system does: the page's colours, the label chips (coloured in code) and
// the discussion (a document of its own) all take the choice at once, and it is kept across a
// restart. The controller's half (the rule, the setting, the back end being told) is
// test/unit/theme-controller.test.ts; the contrast check under a forced choice is in app.spec.ts.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
/** the canvas / surface tokens of each look (styles.css) */
const CANVAS = { light: 'rgb(246, 248, 250)', dark: 'rgb(13, 17, 23)' };
const SURFACE = { light: 'rgb(255, 255, 255)', dark: 'rgb(21, 27, 35)' };

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-theme-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

async function signIn(page: Page) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  for (const s of [PROJECT_URL, REPO]) {
    await page.getByTestId('source-input').fill(s);
    await page.getByTestId('source-add').click();
  }
}

/** the choice has reached the back end's store (quitting right after a click could otherwise beat the write) */
async function saved(app: RunningApp, value: string) {
  await expect.poll(async () => (await app.backend.call<any>('init')).settings.uiTheme, { timeout: 20_000 }).toBe(value);
}

/** what the window shows: the page mark, its canvas, every label chip (solid on light, a tint on dark) and the discussion's background */
async function looks(page: Page, look: 'light' | 'dark', where: string, opts: { detail?: boolean } = {}) {
  await expect(page.locator('html'), where).toHaveAttribute('data-theme', look);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor), { message: `${where}: canvas` }).toBe(CANVAS[look]);
  const chips = page.locator('[data-testid="card"] .label, [data-testid="detail"] .label');
  // with the detail open there must be chips and a discussion to look at (an empty page proves nothing)
  if (opts.detail) {
    expect(await chips.count(), `${where}: label chips on screen`).toBeGreaterThan(0);
    await expect(page.locator('[data-testid="timeline-frame"]'), `${where}: discussion on screen`).toBeVisible();
  }
  if (await chips.count()) {
    await expect
      .poll(
        () =>
          chips
            .evaluateAll((els) =>
              els.map((e) => {
                const p = getComputedStyle(e).backgroundColor.match(/rgba?\(([^)]+)\)/)![1].split(/[ ,/]+/).filter(Boolean).map(Number);
                return p.length > 3 ? p[3] : 1;
              }),
            )
            .then((alphas) => alphas.length > 0 && alphas.every((a) => (look === 'dark' ? a < 1 : a === 1))),
        { message: `${where}: label chips (solid on light, a tint on dark)` },
      )
      .toBe(true);
  }
  const frame = page.locator('[data-testid="timeline-frame"]');
  if (await frame.count()) {
    await expect
      .poll(() => page.frameLocator('[data-testid="timeline-frame"]').locator('body').evaluate((b) => getComputedStyle(b).backgroundColor), { message: `${where}: discussion` })
      .toBe(SURFACE[look]);
  }
}

async function openFirstCard(page: Page) {
  await page.getByTestId('back').click();
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  const first = page.locator('[data-testid="card"]:has(.label)').first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await first.click();
  await expect(page.getByTestId('detail')).toBeVisible();
  await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('body')).not.toBeEmpty({ timeout: 15_000 });
}

test('GitHub#516: 跟随系统 by default; dark on a light system and light on a dark system at once — page, label chips, discussion — holding against the system, kept across a restart', async () => {
  let app: RunningApp = await launchApp(env);
  let page = app.page;
  await page.emulateMedia({ colorScheme: 'light' });
  await signIn(page);

  // the section: second in the contents, after the language; follow the system chosen and saying what it is now
  await expect(page.locator('[data-testid="settings-nav"] a').nth(1)).toHaveText('外观');
  await expect(page.getByTestId('theme-settings').locator('h3')).toHaveText('外观');
  await expect(page.getByTestId('theme-system')).toBeChecked();
  await expect(page.getByTestId('theme-system-label')).toHaveText('跟随系统（默认，现在：浅色）');
  await expect(page.getByTestId('theme-light-label')).toHaveText('浅色');
  await expect(page.getByTestId('theme-dark-label')).toHaveText('深色');
  await looks(page, 'light', 'system light');
  // following: the system switches, the window follows (and the label says so)
  await page.emulateMedia({ colorScheme: 'dark' });
  await looks(page, 'dark', 'system switched to dark');
  await expect(page.getByTestId('theme-system-label')).toHaveText('跟随系统（默认，现在：深色）');
  await page.emulateMedia({ colorScheme: 'light' });
  await looks(page, 'light', 'system back to light');
  await page.getByTestId('theme-settings').screenshot({ path: join(screens, '516-01-theme-system.png') });

  // dark on a light system: at once, the system's "now" is no longer said
  await page.getByTestId('theme-dark').check();
  await looks(page, 'dark', 'dark chosen, system light');
  await expect(page.getByTestId('theme-dark')).toBeChecked();
  await expect(page.getByTestId('theme-system-label')).toHaveText('跟随系统（默认）');
  await saved(app, 'dark');
  await page.screenshot({ path: join(screens, '516-02-settings-dark.png') });
  await openFirstCard(page);
  await looks(page, 'dark', 'dark chosen: board and discussion', { detail: true });
  // the system switching back and forth changes nothing
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(300);
  await looks(page, 'dark', 'dark chosen, system switched', { detail: true });
  await page.screenshot({ path: join(screens, '516-03-board-dark.png') });

  // restart on a light system: still dark, from the first screen
  await app.close();
  app = await launchApp(env);
  page = app.page;
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await looks(page, 'dark', 'restarted');

  // light on a dark system
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByTestId('open-settings').click();
  await page.getByTestId('theme-light').check();
  await looks(page, 'light', 'light chosen, system dark');
  await saved(app, 'light');
  await openFirstCard(page);
  await looks(page, 'light', 'light chosen: board and discussion', { detail: true });

  // back to following the system: dark again, at once
  await page.getByTestId('open-settings').click();
  await page.getByTestId('theme-system').check();
  await looks(page, 'dark', 'system chosen again, system dark');
  await saved(app, 'system');
  await app.close();
});

test('GitHub#516: the section in English; a stored value this version does not know follows the system', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await page.emulateMedia({ colorScheme: 'dark' });
  await signIn(page);
  await page.getByTestId('lang-en').check();
  await expect(page.locator('[data-testid="settings-nav"] a').nth(1)).toHaveText('Appearance');
  await expect(page.getByTestId('theme-settings').locator('h3')).toHaveText('Appearance');
  await expect(page.getByTestId('theme-system-label')).toHaveText('Follow system (default, now: Dark)');
  await expect(page.getByTestId('theme-light-label')).toHaveText('Light');
  await expect(page.getByTestId('theme-dark-label')).toHaveText('Dark');
  await page.getByTestId('theme-settings').screenshot({ path: join(screens, '516-04-theme-en.png') });
  await page.getByTestId('lang-zh').check();
  await app.close();

  // some other version wrote a word this one does not know: follow the system, shown as chosen
  const again = await launchApp(env);
  await again.backend.call('setSetting', { key: 'uiTheme', value: 'sepia' });
  await again.close();
  const third = await launchApp(env);
  await third.page.emulateMedia({ colorScheme: 'dark' });
  await expect(third.page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await looks(third.page, 'dark', 'unknown stored value on a dark system');
  await third.page.getByTestId('open-settings').click();
  await expect(third.page.getByTestId('theme-system')).toBeChecked();
  await third.close();
});
