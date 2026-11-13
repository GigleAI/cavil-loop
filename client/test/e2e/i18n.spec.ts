// GitHub#466 / #471: the interface in English — the real window (test build) and the real back end
// against the fake GitHub. The run-time half of the language checks: every visible text and every
// hover / label / placeholder in the areas this sub-issue migrated is scanned for Chinese; Chinese
// is allowed only inside text shown as is (`data-verbatim`) and in the few kept words
// (`data-keep-lang`, KEEP_LANG). The source scan and the tables are test/unit/i18n.test.ts.
//
// The areas grow with each sub-issue of #466: today the top bar, the view bar, Settings (its
// contents, its headings and the sections migrated here), the sign-in page and its help page.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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

/** the parts of Settings still in Chinese until sub-issue ③ (#473) — the local / remote daemon and update sections' contents, "接上 daemon" (the shortcut section's rows came with sub-issue ②, #472) */
const SETTINGS_LATER = ['#set-update > :not(h3)', '#set-daemon > :not(h3)', '#set-remote > :not(h3)', '[data-testid^="connect-"]', '[data-testid="source-failure"]'];
/** the settings page as this sub-issue migrated it */
const SETTINGS = ['.settings > .toolbar', '[data-testid="settings-nav"]', '.settings-main section'];

/** the choice has reached the back end's store (quitting right after a click could otherwise beat the write, as a killed app would) */
async function saved(app: RunningApp, value: string) {
  await expect.poll(async () => (await app.backend.call<any>('init')).settings.uiLanguage, { timeout: 20_000 }).toBe(value);
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
  // GitHub#514: what that change wrote or moved inside the sections still waiting for their own migration is English already
  await expect(page.getByTestId('keys-more').locator('summary')).toHaveText('Which keys are fixed, and when a single key works');
  await expect(page.getByTestId('keys-more')).toContainText('Ctrl+1 … Ctrl+9, Ctrl+W and the zoom keys are fixed');
  await expect(page.locator('#set-keys .fixed').first()).toHaveText('Fixed');
  await expect(page.locator('#set-keys > p.muted').first()).toHaveText('Click "Change", then press the new key; it applies on this computer only.');
  await expect(page.getByTestId('daemon-more').locator('summary')).toHaveText('What the client does with it');
  await expect(page.getByTestId('remote-more').locator('summary')).toHaveText('How pairing works, and whether the GitHub sign-in leaves this computer');
  expect(await chineseIn(page, ['[data-testid="keys-more"]', '[data-testid="daemon-more"]', '[data-testid="remote-more"]', '#set-keys .fixed'])).toEqual([]);
  // the check sees what it should: the user's Chinese label is there, inside its as-is marker
  expect(await page.locator('[data-testid="pending-label"] [data-verbatim="user"]').textContent()).toBe('等人/处理');
  await section.screenshot({ path: join(screens, '471-02-language-en.png') });
  await shot(page, '471-03-settings-en');

  // the board: the top bar and the view bar in English, the items' Chinese titles as they are on GitHub
  await page.getByTestId('back').click();
  await expect(page.getByTestId('write-entry')).toHaveAttribute('aria-label', 'New issue');
  await expect(page.getByTestId('open-view-panel')).toContainText('View settings');
  await expect(page.locator('[data-testid="tally"][data-kind="human"]')).toContainText('Waiting for human');
  expect(await chineseIn(page, ['[data-testid="topbar"]', '.vbar'])).toEqual([]);
  await shot(page, '471-04-board-en');
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await expect(page.locator('[data-testid="row"]').first()).toBeVisible({ timeout: 20_000 });
  const titles = await page.locator('[data-testid="title-cell"]').allTextContents();
  expect(titles.some((x) => /[一-鿿]/.test(x)), 'some recorded titles are Chinese and still shown').toBe(true);
  await shot(page, '471-05-table-en');
  for (const l of ['table', 'graph'] as const) {
    await page.locator(`[data-testid="layout"] button[data-value="${l}"]`).click();
    expect(await chineseIn(page, ['[data-testid="topbar"]', '.vbar']), l).toEqual([]);
  }
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  // the shortcut list's button and the hover of the sync state
  await expect(page.getByTestId('open-shortcuts')).toContainText('Shortcuts');
  await expect(page.getByTestId('sync-status')).toHaveAttribute('title', /Last reached GitHub/);

  // restart: still English, and before anything else is drawn
  await app.close();
  app = await launchApp(env, { locale: 'zh-CN' });
  page = app.page;
  await expect(page.getByTestId('write-entry')).toHaveAttribute('aria-label', 'New issue', { timeout: 15_000 });
  expect(await chineseIn(page, ['[data-testid="topbar"]', '.vbar'])).toEqual([]);

  // back to Chinese: everything as it was
  await page.getByTestId('open-settings').click();
  await page.getByTestId('lang-zh').check();
  await expect(page.locator('.settings .toolbar h2')).toHaveText('设置');
  await expect(page.getByTestId('language-title')).toHaveText('语言 · Language');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('write-entry')).toHaveAttribute('aria-label', '新建 issue');
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

test("GitHub#471 (PR #480 review round 1): sign-in failures in English — declined, expired, GitHub's own reason, a refused request; GitHub's words shown as written, the reason never twice", async () => {
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  await page.getByTestId('lang-en').check();
  await saved(app, 'en');
  await page.getByTestId('logout').click();
  const banner = page.getByTestId('login-error');
  const attempt = async () => {
    await page.getByTestId('start-login').click();
    await expect(page.getByTestId('user-code')).toBeVisible();
  };

  // declined on GitHub: one sentence, in English
  await attempt();
  env.fake.resolveGrant('denied');
  await expect(banner).toHaveAttribute('data-status', 'denied', { timeout: 15_000 });
  await expect(banner).toHaveText('You declined the authorization on GitHub.');
  expect(await chineseIn(page, ['[data-testid="login"]'])).toEqual([]);
  await shot(page, '471-08-login-denied-en');

  // the code expired
  await attempt();
  env.fake.resolveGrant('expired');
  await expect(banner).toHaveAttribute('data-status', 'expired', { timeout: 15_000 });
  await expect(banner).toHaveText('The code has expired.');
  expect(await chineseIn(page, ['[data-testid="login"]'])).toEqual([]);

  // GitHub gives a reason of its own (here in Chinese): the explanation in English, GitHub's words as written
  env.fake.state.tokenAnswers.push({ kind: 'poll', status: 200, body: { error: 'odd_failure', error_description: '组织不允许这个应用' } });
  await attempt();
  await expect(banner).toHaveAttribute('data-status', 'error', { timeout: 15_000 });
  await expect(banner).toHaveText('Sign-in did not complete. Authorization failed: 组织不允许这个应用');
  await expect(banner.locator('[data-verbatim="github"]')).toHaveText('组织不允许这个应用');
  expect(await chineseIn(page, ['[data-testid="login"]'])).toEqual([]);
  await shot(page, '471-09-login-github-reason-en');

  // the request for a code refused (a Client ID GitHub does not know)
  if (!(await page.getByTestId('client-id').isVisible())) await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill('Ov23liNotKnownHere00');
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(banner).toHaveAttribute('data-status', 'error', { timeout: 15_000 });
  await expect(banner).toHaveText('Sign-in did not complete. GitHub refused the authorization request: The client_id is not valid.');
  expect(await chineseIn(page, ['[data-testid="login"]'])).toEqual([]);
  await app.close();
});

test('GitHub#471 (PR #480 review round 1): the same failures in Chinese read as before, without the reason said twice', async () => {
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  await page.getByTestId('logout').click();
  const banner = page.getByTestId('login-error');
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('denied');
  await expect(banner).toHaveText('你在 GitHub 页面上拒绝了授权。', { timeout: 15_000 });
  env.fake.state.tokenAnswers.push({ kind: 'poll', status: 200, body: { error: 'odd_failure', error_description: 'org policy' } });
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  await expect(banner).toHaveText('登录没有完成。 授权失败：org policy', { timeout: 15_000 });
  await app.close();
});

/**
 * SQL straight on the file the back end uses, on a short-lived connection that waits for the back
 * end's own writes (a sign-out still writing holds the lock for a moment) instead of failing on them,
 * and is closed whatever happens (PR #480 review round 5: without the wait the trigger setup itself
 * failed with "database is locked" before the path under test was reached).
 */
function onFile<T>(run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(env.userData, 'cache.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    return run(db);
  } finally {
    db.close();
  }
}

const triggerCount = (name: string) =>
  onFile((db) => (db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(name) as { n: number }).n);

/** the database refuses one setting from now on (a trigger in the real file); returns the undo */
function refuseSetting(key: string): () => void {
  const name = `refuse_${key}`;
  onFile((db) => db.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON setting WHEN new.k = '${key}' BEGIN SELECT RAISE(ABORT, 'test storage unavailable'); END;`));
  // it is really in place before the step that should hit it
  expect(triggerCount(name)).toBe(1);
  return () => {
    onFile((db) => db.exec(`DROP TRIGGER IF EXISTS ${name};`));
    expect(triggerCount(name)).toBe(0);
  };
}

test("GitHub#471 (PR #480 review round 2): what the sign-in page says when this computer refuses — a sign-out whose keychain delete failed, a sign-in that could not be saved — in English, the system's words as written; the undone sign-in leaves nothing behind", async () => {
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  await page.getByTestId('lang-en').check();
  await saved(app, 'en');

  // the keychain delete of a sign-out fails (the stored credential cannot be removed)
  rmSync(env.cred, { force: true });
  mkdirSync(env.cred);
  await page.getByTestId('logout').click();
  const reason = page.getByTestId('login-reason');
  await expect(reason).toContainText('The old sign-in credential saved on this computer could not be deleted (', { timeout: 15_000 });
  // the marked part is the system's own words only: none of the client's sentence is inside it
  await expect(reason.locator('[data-verbatim="system"]')).toHaveCount(1);
  const os = (await reason.locator('[data-verbatim="system"]').textContent()) ?? '';
  expect(os).toMatch(/EISDIR|directory/);
  expect(os).not.toMatch(/credential|keychain|could not|[\u4e00-\u9fff]/);
  expect(await chineseIn(page, ['[data-testid="login"]'])).toEqual([]);
  await shot(page, '471-10-signout-not-deleted-en');
  rmSync(env.cred, { recursive: true, force: true });

  // GitHub approves, but the database refuses to record the sign-in: undone, said in English
  const allow = refuseSetting('grantClientId');
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  const banner = page.getByTestId('login-error');
  await expect(banner).toHaveAttribute('data-status', 'error', { timeout: 15_000 });
  // the save step was really reached and really failed: the database's own words are in the message
  await expect(banner).toHaveText('Sign-in did not complete. The sign-in could not be saved on this computer (Local storage error: test storage unavailable); it has been undone, try again');
  // only the database's own words are marked; the client's prefix is its own words
  await expect(banner.locator('[data-verbatim]')).toHaveCount(1);
  await expect(banner.locator('[data-verbatim="system"]')).toHaveText('test storage unavailable');
  expect(await chineseIn(page, ['[data-testid="login"]'])).toEqual([]);
  await shot(page, '471-11-signin-not-saved-en');
  allow();

  // the trust list refused (the first write of a sign-in): the store's prefix in English, its words marked
  const allowTrust = refuseSetting('trustedCredentials');
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(banner).toHaveText('Sign-in did not complete. Local storage error: test storage unavailable', { timeout: 15_000 });
  await expect(banner.locator('[data-verbatim]')).toHaveCount(1);
  await expect(banner.locator('[data-verbatim="system"]')).toHaveText('test storage unavailable');
  expect(await chineseIn(page, ['[data-testid="login"]'])).toEqual([]);
  await expect(page.getByTestId('board')).toHaveCount(0);
  allowTrust();
  // undone: still signed out, and nothing of it is trusted (a restart does not sign in)
  await expect(page.getByTestId('start-login')).toBeVisible();
  await app.close();
  const again = await launchApp(env, { locale: 'en-US' });
  await expect(again.page.getByTestId('start-login')).toHaveText('Sign in with GitHub', { timeout: 15_000 });
  // and a sign-in afterwards works
  await again.page.getByTestId('start-login').click();
  await expect(again.page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(again.page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await again.close();
});

test('GitHub#471 (PR #480 review round 2): the same refusals in Chinese read exactly as before', async () => {
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  await page.getByTestId('back').click();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('logout').click();
  const allow = refuseSetting('grantClientId');
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  // word for word what this build said before the language work (PR #480 review round 2 quotes it)
  await expect(page.getByTestId('login-error')).toHaveText('登录没有完成。 登录没能保存到本机（本地存储出错：test storage unavailable），已撤销这次登录，请重试', { timeout: 15_000 });
  allow();
  // the trust list refused (an earlier write of the same sign-in): before, the banner was the store's own line
  const allowTrust = refuseSetting('trustedCredentials');
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('login-error')).toHaveText('登录没有完成。 本地存储出错：test storage unavailable', { timeout: 15_000 });
  allowTrust();
  await app.close();
});
