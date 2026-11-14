// GitHub#474 (the last sub-issue of #466): the whole window in English, page by page — the real
// window (test build) and the real back end against the fake GitHub. The area files
// (i18n.spec.ts, i18n-areas / -daemon / -remote / -update) each scan the regions their sub-issue
// migrated; this one scans the *whole window* (`body`, plus the discussion's own frame) on every
// page a person reaches, so a word that sits outside every named region is still seen. Chinese is
// allowed only inside text shown as is (`data-verbatim`) and in the kept words (KEEP_LANG). Each
// page is also saved as a picture (test-results/screens/474-*.png, kept by CI with the run).
//
// The test data carries Chinese on purpose — recorded issue titles, a Chinese comment, a Chinese
// milestone, a label named in Chinese by the person — and the walk checks that it is really on
// screen inside its as-is marker, so "no Chinese found" cannot come from an empty page.
// Not here (not part of the window): the macOS menu and the system notifications, whose words go
// through tr() / t() and are covered by the source scan and the tables (test/unit/i18n.test.ts).

import { test, expect, type Frame, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { findCopies } from '../fake-github/writes';
import { launchApp, closeEngine, type AppEnv, type RunningApp } from './bridge';
import { chineseIn } from './langCheck';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const ISSUE = 137;
const CN_COMMENT = '这条评论是中文写的，应该原样显示';
const CN_LABEL = '等人/处理';

// a step that cannot happen names itself instead of using up the whole test's time
test.use({ actionTimeout: 20_000 });

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-i18n-walk-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  const w = env.fake.state.w;
  w.comments.set(`gigleai/cavil-loop#${ISSUE}`, [
    { id: 'C-cn', url: `https://github.com/GigleAI/cavil-loop/issues/${ISSUE}#c1`, createdAt: '2026-11-02T01:00:00Z', bodyHTML: `<p>${CN_COMMENT}</p>`, author: { login: 'user-2' } },
  ]);
  w.milestones.set('gigleai/cavil-loop', [{ number: 1, title: '第一版', state: 'open', due_on: null }]);
  // waiting for a human under the Chinese name the walk gives that label in Settings (not in another
  // flow), so "wait for…" can be opened on it — and a label named in Chinese on GitHub is on screen
  const copies = findCopies(env.fake.state as any, REPO, ISSUE)!;
  for (const r of copies.rest) r.labels = [{ name: CN_LABEL, color: 'ededed' }];
  for (const c of copies.gql) c.labels.nodes = c.labels.nodes.filter((l: any) => l.name !== 'pending/PR').concat([{ ...c.labels.nodes[0], name: CN_LABEL }]);
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

/** the whole window has no Chinese of the client's own; the picture is saved either way, to look at */
async function page_(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `474-${name}.png`) });
  expect(await chineseIn(page, ['body']), name).toEqual([]);
}

/** Chinese that is not the client's is really on screen, inside its as-is marker (the check saw it and let it through) */
async function outsideChineseShown(where: Page | Frame): Promise<boolean> {
  return where.evaluate(() => Array.from(document.querySelectorAll('body [data-verbatim]')).some((e) => /[一-鿿]/.test(e.textContent ?? '')));
}

const card = (page: Page, n: number) => page.locator(`[data-testid="card"][data-key="gigleai/cavil-loop#${n}"]`).first();
const layout = (page: Page, l: 'board' | 'table' | 'graph') => page.locator(`[data-testid="layout"] button[data-value="${l}"]`).click();

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

async function english(app: RunningApp) {
  await app.page.getByTestId('lang-en').check();
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'en');
  await expect.poll(async () => (await app.backend.call<any>('init')).settings.uiLanguage, { timeout: 20_000 }).toBe('en');
}

test('GitHub#474: the whole window in English, page by page — settings, board, view settings, table, dependency view, shortcuts, the open menu, the detail and its discussion, confirm, "wait for…", tab, notices, new issue', async () => {
  // sixteen pages, each one waited for, scanned and photographed: longer than one ordinary test
  test.setTimeout(300_000);
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  await english(app);

  // Settings, every section at once (the whole page is one scroll): a label the person named in Chinese is theirs
  await page.getByTestId('hand-back-human').fill(CN_LABEL);
  await page.getByTestId('hand-back-human').blur();
  await expect(page.getByTestId('pending-label')).toHaveText(CN_LABEL);
  await expect(page.locator('.settings .toolbar h2')).toHaveText('Settings');
  expect(await outsideChineseShown(page), 'the Chinese label is on the page, marked as the person\'s').toBe(true);
  await page_(page, '01-settings');
  for (const id of await page.locator('.settings-main section[id]').evaluateAll((s) => s.map((x) => x.id))) {
    const sec = page.locator(`.settings-main section#${id}`);
    await sec.scrollIntoViewIfNeeded();
    await sec.screenshot({ path: join(screens, `474-01-settings-${id}.png`) });
  }

  // the board, its view settings, the table, the dependency view
  await page.getByTestId('back').click();
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await layout(page, 'board');
  await page.getByTestId('search').fill('');
  await expect(card(page, ISSUE)).toBeVisible({ timeout: 20_000 });
  expect(await outsideChineseShown(page), 'recorded Chinese titles are on the board, marked as GitHub text').toBe(true);
  await page_(page, '02-board');

  await page.getByTestId('open-view-panel').click();
  await expect(page.getByTestId('view-panel')).toBeVisible();
  await page_(page, '03-view-settings');
  await page.getByTestId('open-view-panel').click();
  await expect(page.getByTestId('view-panel')).toHaveCount(0);

  await layout(page, 'table');
  await expect(page.locator('[data-testid="row"]').first()).toBeVisible({ timeout: 20_000 });
  await page_(page, '04-table');

  await layout(page, 'graph');
  await expect(page.getByTestId('graph')).toBeVisible();
  await page_(page, '05-graph');

  await layout(page, 'board');
  await expect(card(page, ISSUE)).toBeVisible();
  await page.getByTestId('open-shortcuts').click();
  await expect(page.getByTestId('shortcut-help')).toBeVisible();
  await page_(page, '06-shortcuts');
  await page.getByTestId('shortcut-help-close').click();

  // the right-click menu of a card
  await card(page, ISSUE).click({ button: 'right' });
  await expect(page.getByTestId('open-menu')).toBeVisible();
  await page_(page, '07-open-menu');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('open-menu')).toHaveCount(0);

  // the detail as a floating panel, and its discussion frame
  await card(page, ISSUE).click();
  const detail = page.getByTestId('detail');
  await expect(detail).toHaveAttribute('data-key', `gigleai/cavil-loop#${ISSUE}`);
  await expect(detail.getByTestId('quick-actions')).toBeVisible({ timeout: 15_000 });
  await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('body')).toContainText(CN_COMMENT, { timeout: 15_000 });
  const inner = (await (await page.getByTestId('timeline-frame').elementHandle())!.contentFrame())!;
  expect(await chineseIn(inner, ['body']), 'the discussion').toEqual([]);
  expect(await outsideChineseShown(inner), 'the Chinese comment is shown, marked as GitHub text').toBe(true);
  await page_(page, '08-detail');

  await detail.getByTestId('close-issue').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page_(page, '09-close-confirm');
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

  await detail.getByTestId('blocked-open').click();
  await expect(page.getByTestId('blocked-dialog')).toBeVisible();
  // the repository has no label of the person's Chinese name: the refusal is English around it, the
  // name shown as written inside its marker (it was once baked into the sentence — found by this walk)
  const refuse = page.getByTestId('blocked-refuse');
  await expect(refuse).toContainText('This repository has no label', { timeout: 15_000 });
  await expect(refuse.locator('[data-verbatim="user"]').filter({ hasText: CN_LABEL })).toHaveCount(1);
  await page_(page, '10-blocked');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('blocked-dialog')).toHaveCount(0);

  // the same item as a tab
  await page.getByTestId('detail-close').click();
  await card(page, ISSUE).click({ modifiers: ['Control'] });
  await expect(page.getByTestId('tab')).toHaveCount(1);
  await expect(page.getByTestId('detail')).toBeVisible();
  await expect(page.getByTestId('detail').getByTestId('quick-actions')).toBeVisible({ timeout: 15_000 });
  await page_(page, '11-tab');

  // an operation's result in the notice area: close the issue
  await page.getByTestId('detail').getByTestId('close-issue').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('notice-area')).toBeVisible({ timeout: 15_000 });
  await page_(page, '12-notice');

  // the new-issue dialog, a Chinese title typed by the person
  await expect(page.getByTestId('tab')).toHaveCount(0);
  await page.getByTestId('write-entry').click();
  await expect(page.getByTestId('new-issue')).toBeVisible();
  await page.getByTestId('new-issue-title').fill('新的中文标题');
  await page_(page, '13-new-issue');
  await app.close();
});

test('GitHub#474: the sign-in page and its help page, the whole window in English', async () => {
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  await english(app);
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('start-login')).toHaveText('Sign in with GitHub');
  await page_(page, '14-login');
  await page.getByTestId('app-kind-github-app').check();
  await expect(page.getByTestId('client-id')).toBeVisible();
  await page_(page, '15-login-client-id');
  await page.getByTestId('app-kind-help-link').click();
  await expect(page.getByTestId('app-kind-help')).toBeVisible();
  await page_(page, '16-login-help');
  await app.close();
});

test('GitHub#474: nothing set — the same walk reads Chinese, as before', async () => {
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('.settings .toolbar h2')).toHaveText('设置');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await layout(page, 'board');
  await page.getByTestId('search').fill('');
  await expect(card(page, ISSUE)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('open-view-panel')).toContainText('视图设置');
  await card(page, ISSUE).click();
  await expect(page.getByTestId('detail').getByTestId('close-issue')).toContainText('关闭 issue…');
  // the "wait for…" refusal, now worded with holes, reads word for word as the sentence it was
  await page.getByTestId('detail').getByTestId('blocked-open').click();
  await expect(page.getByTestId('blocked-refuse')).toHaveText('这个仓库没有标签 「pending/blocked」（客户端不会替仓库新建标签）', { timeout: 15_000 });
  await expect(page.locator('[data-testid="blocked-refuse"] [data-verbatim="user"]')).toHaveText('pending/blocked');
  // the check itself is not blind: in Chinese it finds the client's own words on the same page
  expect((await chineseIn(page, ['body'])).length).toBeGreaterThan(0);
  await app.close();
});

// PR #537 review round 1: reading the repository's labels fails, GitHub answering in Chinese with
// words that look like the sentence's own holes — the refusal is the client's words around it, the
// repository and GitHub's words as written in their markers, "{human}" in them left alone.
const NASTY = '服务器开小差了 {human} {blocked}';
for (const lang of ['en', 'zh'] as const)
  test(`GitHub#474 (PR #537 review round 1): "wait for…" when the labels cannot be read, ${lang === 'en' ? 'in English' : 'in Chinese (nothing set)'} — GitHub's words as written, never read as holes`, async () => {
    env.fake.state.w.failLabels.add('gigleai/cavil-loop');
    env.fake.state.w.failLabelsMessage = NASTY;
    const app = await launchApp(env, { locale: 'en-US' });
    const page = app.page;
    await signIn(page);
    if (lang === 'en') await english(app);
    // the person's Chinese name for the waiting label, so it is the item's flow label and fills a hole too
    await page.getByTestId('hand-back-human').fill(CN_LABEL);
    await page.getByTestId('hand-back-human').blur();
    await page.getByTestId('back').click();
    await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
    await layout(page, 'board');
    await page.getByTestId('search').fill('');
    await expect(card(page, ISSUE)).toBeVisible({ timeout: 20_000 });
    await card(page, ISSUE).click();
    await page.getByTestId('detail').getByTestId('blocked-open').click();
    const refuse = page.getByTestId('blocked-refuse');
    const sentence =
      lang === 'en'
        ? `Could not read this repository's labels (Reading the labels / milestones of ${REPO} failed: GitHub answered HTTP 502: ${NASTY}), so it cannot be confirmed that both "pending/blocked" and "${CN_LABEL}" exist`
        : `读不到这个仓库的标签（读取 ${REPO} 的标签 / 里程碑失败：GitHub 返回 HTTP 502：${NASTY}），不能确认「pending/blocked」「${CN_LABEL}」两个标签都在`;
    await expect(refuse).toHaveText(sentence, { timeout: 15_000 });
    // GitHub's words, whole and untouched, in GitHub's marker; the repository too; the labels the person's
    await expect(refuse.locator('[data-verbatim="github"]').filter({ hasText: NASTY })).toHaveText(NASTY);
    await expect(refuse.locator('[data-verbatim="github"]').filter({ hasText: REPO })).toHaveText(REPO);
    await expect(refuse.locator('[data-verbatim="user"]')).toHaveText(['pending/blocked', CN_LABEL]);
    if (lang === 'en') await page_(page, '17-blocked-labels-unread');
    await app.close();
  });

// PR #537 review round 2: the label list answers with a next-page link to another host, the link
// shaped like the sentence's own holes — the client refuses to follow it and says so in English,
// the link as written in GitHub's marker, "{human}" in it never replaced by the label name.
test('GitHub#474 (PR #537 review round 2): "wait for…" when the label list points its next page at another host — the link as written, never followed, never read as holes', async () => {
  const AWAY = 'https://evil.example/next/{human}?x={blocked}';
  env.fake.state.w.labelsNextLink = AWAY;
  const app = await launchApp(env, { locale: 'en-US' });
  const page = app.page;
  await signIn(page);
  await english(app);
  await page.getByTestId('hand-back-human').fill(CN_LABEL);
  await page.getByTestId('hand-back-human').blur();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await layout(page, 'board');
  await page.getByTestId('search').fill('');
  await expect(card(page, ISSUE)).toBeVisible({ timeout: 20_000 });
  await card(page, ISSUE).click();
  await page.getByTestId('detail').getByTestId('blocked-open').click();
  const refuse = page.getByTestId('blocked-refuse');
  await expect(refuse).toHaveText(
    `Could not read this repository's labels (Reading the labels / milestones of ${REPO} failed: Refused to follow a page link to another host: ${AWAY}), so it cannot be confirmed that both "pending/blocked" and "${CN_LABEL}" exist`,
    { timeout: 15_000 },
  );
  await expect(refuse.locator('[data-verbatim="github"]').filter({ hasText: AWAY })).toHaveText(AWAY);
  await expect(refuse.locator('[data-verbatim="user"]')).toHaveText(['pending/blocked', CN_LABEL]);
  // (that the other host is never asked is checked on the real client in test/unit/error-words.test.ts)
  await page_(page, '18-blocked-next-link');
  await app.close();
});
