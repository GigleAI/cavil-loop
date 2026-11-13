// GitHub#466 / #471: the interface in English — the real window (test build) and the real back end
// against the fake GitHub. The run-time half of the language checks: every visible text and every
// hover / label / placeholder in the areas this sub-issue migrated is scanned for Chinese; Chinese
// is allowed only inside text shown as is (`data-verbatim`) and in the few kept words
// (`data-keep-lang`, KEEP_LANG). The source scan and the tables are test/unit/i18n.test.ts.
//
// The areas grow with each sub-issue of #466: today the top bar, the view bar, Settings (its
// contents, its headings and the sections migrated here), the sign-in page and its help page.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { KEEP_LANG } from '../../src/shared/i18n';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-i18n-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
}

/**
 * Chinese in `selectors` outside text shown as is and outside the kept words: text nodes, and the
 * title / aria-label / placeholder / alt of every element. `skip`: parts that belong to a later
 * sub-issue of #466 (named in the call, removed when that part is migrated).
 */
async function chineseIn(page: Page, selectors: string[], skip: string[] = []): Promise<string[]> {
  return page.evaluate(
    ({ selectors, skip, keep }) => {
      const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
      const out: string[] = [];
      const exempt = (el: Element) => Boolean(el.closest('[data-verbatim]')) || skip.some((s) => el.closest(s));
      const kept = (el: Element) => {
        const k = el.closest('[data-keep-lang]');
        return Boolean(k && keep.some((x) => x.text === k.textContent && x.lang === k.getAttribute('lang')));
      };
      let seen = 0;
      for (const sel of selectors)
        for (const root of Array.from(document.querySelectorAll(sel))) {
          seen++;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const el = n.parentElement;
            if (!el || exempt(el) || kept(el)) continue;
            if (CJK.test(n.textContent ?? '')) out.push(`${sel}: ${(n.textContent ?? '').trim()}`);
          }
          for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
            if (exempt(el)) continue;
            // the outside parts an element names (verbatimParts) come out of its attributes, nothing else
            const parts: string[] = el.hasAttribute('data-verbatim-parts') ? JSON.parse(el.getAttribute('data-verbatim-parts')!) : [];
            for (const a of ['title', 'aria-label', 'placeholder', 'alt']) {
              let v = el.getAttribute(a);
              if (!v) continue;
              for (const p of parts) v = v.split(p).join('');
              if (CJK.test(v)) out.push(`${sel} [${a}]: ${el.getAttribute(a)}`);
            }
          }
        }
      // a selector that matched nothing checked nothing: report it rather than pass
      if (seen === 0) out.push(`nothing matched ${selectors.join(', ')}`);
      return out;
    },
    { selectors, skip, keep: KEEP_LANG.map((k) => ({ ...k })) },
  );
}

/** the parts of Settings still in Chinese until sub-issue ③ (#473): the local / remote daemon and update sections' contents, "接上 daemon" */
const SETTINGS_LATER = ['#set-update > :not(h3)', '#set-daemon > :not(h3)', '#set-remote > :not(h3)', '[data-testid^="connect-"]', '[data-testid="source-failure"]'];
/** the settings page as this sub-issue migrated it */
const SETTINGS = ['.settings > .toolbar', '[data-testid="settings-nav"]', '.settings-main section'];

/** the choice has reached the back end's store (quitting right after a click could otherwise beat the write, as a killed app would) */
async function saved(app: RunningApp, value: string) {
  await expect.poll(async () => (await app.backend.call<any>('init')).settings.uiLanguage).toBe(value);
}

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

test('GitHub#471: 简体中文 by default; English at once, through Settings, the top bar and the view bar, kept across a restart; Chinese from GitHub and from the user shown as is', async () => {
  let app: RunningApp = await launchApp(env, { locale: 'en-US' });
  let page = app.page;
  // nothing set: Chinese, even on an English system
  await expect(page.getByTestId('start-login')).toHaveText('用 GitHub 登录');
  await signIn(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

  // the language section: first, named in both languages, 简体中文 chosen
  const section = page.getByTestId('language-settings');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('language-title')).toHaveText('语言 · Language');
  await expect(page.locator('[data-testid="settings-nav"] a').first()).toHaveText('语言 · Language');
  await expect(page.getByTestId('lang-zh')).toBeChecked();
  await expect(page.getByTestId('lang-auto-label')).toHaveText('跟随系统（现在：English）');
  await expect(page.locator('.settings .toolbar h2')).toHaveText('设置');
  // a waiting-for-human label named in Chinese by the user: shown as written in both languages
  await page.getByTestId('hand-back-human').fill('等人/处理');
  await page.getByTestId('hand-back-human').blur();
  await expect(page.getByTestId('pending-label')).toHaveText('等人/处理');
  await section.screenshot({ path: join(screens, '471-01-language-zh.png') });

  // English: at once, no restart
  await page.getByTestId('lang-en').check();
  await expect(page.locator('.settings .toolbar h2')).toHaveText('Settings');
  await expect(page.getByTestId('language-title')).toHaveText('Language · 语言');
  await expect(page.locator('[data-testid="settings-nav"] a').first()).toHaveText('Language · 语言');
  await expect(page.getByTestId('lang-en')).toBeChecked();
  await expect(page.getByTestId('lang-auto-label')).toHaveText('Follow system (now: English)');
  await expect(page.getByTestId('back')).toContainText('Back to board');
  await expect(page.getByTestId('pending-label')).toHaveText('等人/处理');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await saved(app, 'en');
  expect(await chineseIn(page, SETTINGS, SETTINGS_LATER)).toEqual([]);
  // the check sees what it should: the user's Chinese label is there, inside its as-is marker
  expect(await page.locator('[data-testid="pending-label"] [data-verbatim="user"]').textContent()).toBe('等人/处理');
  await section.screenshot({ path: join(screens, '471-02-language-en.png') });
  await shot(page, '471-03-settings-en');

  // the board: the top bar and the view bar in English, the items' Chinese titles as they are on GitHub
  await page.getByTestId('back').click();
  await expect(page.getByTestId('write-entry')).toContainText('New issue');
  await expect(page.getByTestId('open-view-panel')).toContainText('View settings');
  await expect(page.locator('[data-testid="tally"][data-kind="human"]')).toContainText('Waiting for human');
  expect(await chineseIn(page, ['header.hdr', '.vbar'])).toEqual([]);
  await shot(page, '471-04-board-en');
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await expect(page.locator('[data-testid="row"]').first()).toBeVisible({ timeout: 20_000 });
  const titles = await page.locator('[data-testid="title-cell"]').allTextContents();
  expect(titles.some((x) => /[一-鿿]/.test(x)), 'some recorded titles are Chinese and still shown').toBe(true);
  await shot(page, '471-05-table-en');
  for (const l of ['table', 'graph'] as const) {
    await page.locator(`[data-testid="layout"] button[data-value="${l}"]`).click();
    expect(await chineseIn(page, ['header.hdr', '.vbar']), l).toEqual([]);
  }
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  // the shortcut list's button and the hover of the sync state
  await expect(page.getByTestId('open-shortcuts')).toContainText('Shortcuts');
  await expect(page.getByTestId('sync-status')).toHaveAttribute('title', /Last reached GitHub/);

  // restart: still English, and before anything else is drawn
  await app.close();
  app = await launchApp(env, { locale: 'zh-CN' });
  page = app.page;
  await expect(page.getByTestId('write-entry')).toContainText('New issue', { timeout: 15_000 });
  expect(await chineseIn(page, ['header.hdr', '.vbar'])).toEqual([]);

  // back to Chinese: everything as it was
  await page.getByTestId('open-settings').click();
  await page.getByTestId('lang-zh').check();
  await expect(page.locator('.settings .toolbar h2')).toHaveText('设置');
  await expect(page.getByTestId('language-title')).toHaveText('语言 · Language');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('write-entry')).toContainText('新建 issue');
  await app.close();
});

test('GitHub#471: follow the system — zh-CN / zh-TW Chinese, en-US / ja-JP English; a stored value this version does not know is Chinese', async () => {
  let app = await launchApp(env, { locale: 'en-US' });
  await signIn(app.page);
  await app.page.getByTestId('lang-auto').check();
  await expect(app.page.locator('.settings .toolbar h2')).toHaveText('Settings');
  await expect(app.page.getByTestId('lang-auto-label')).toHaveText('Follow system (now: English)');
  await saved(app, 'auto');
  await app.close();
  for (const [locale, want] of [
    ['zh-CN', '设置'],
    ['zh-TW', '设置'],
    ['ja-JP', 'Settings'],
    ['en-US', 'Settings'],
  ] as const) {
    app = await launchApp(env, { locale });
    await app.page.getByTestId('open-settings').click({ timeout: 15_000 });
    await expect(app.page.locator('.settings .toolbar h2'), locale).toHaveText(want);
    await expect(app.page.getByTestId('lang-auto')).toBeChecked();
    if (locale === 'zh-TW') await expect(app.page.getByTestId('lang-auto-label')).toHaveText('跟随系统（现在：简体中文）');
    await app.close();
  }
  // a value written by some other version: Chinese, and Settings shows 简体中文 chosen
  app = await launchApp(env, { locale: 'en-US' });
  await app.backend.call('setSetting', { key: 'uiLanguage', value: 'fr' });
  await saved(app, 'fr');
  await app.close();
  app = await launchApp(env, { locale: 'en-US' });
  await app.page.getByTestId('open-settings').click({ timeout: 15_000 });
  await expect(app.page.locator('.settings .toolbar h2')).toHaveText('设置');
  await expect(app.page.getByTestId('lang-zh')).toBeChecked();
  await app.close();
});

test('GitHub#471: the sign-in page and its help page in English', async () => {
  let app = await launchApp(env, { locale: 'en-US' });
  await signIn(app.page);
  await app.page.getByTestId('lang-en').check();
  await app.page.getByTestId('logout').click();
  const page = app.page;
  await expect(page.getByTestId('start-login')).toHaveText('Sign in with GitHub');
  expect(await chineseIn(page, ['[data-testid="login"]'])).toEqual([]);
  // the Client ID box and its words, open
  await page.getByTestId('app-kind-github-app').check();
  await expect(page.getByTestId('client-id')).toBeVisible();
  expect(await chineseIn(page, ['[data-testid="login"]'])).toEqual([]);
  await shot(page, '471-06-login-en');
  await page.getByTestId('app-kind-help-link').click();
  await expect(page.getByTestId('app-kind-help')).toBeVisible();
  expect(await chineseIn(page, ['[data-testid="app-kind-help"]'])).toEqual([]);
  await shot(page, '471-07-login-help-en');
  await app.close();
});
