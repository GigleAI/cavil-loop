// UI tests: the real window (built with --test-bridge) driven by Playwright,
// the real back end (Rust, the harness build of crates/core) behind a loopback
// bridge, talking to the local fake GitHub over loopback (test/e2e/bridge.ts).
// Screenshots of each step land in test-results/screens/ (uploaded by CI).

import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub, loadCavilProjectPages } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';
import { findCopies, gqlContent, handleGraphql, pullOf } from '../fake-github/writes';
import { TASK_CHANGED as TASK_CHANGED193 } from '../../src/data/actions';

/** GitHub#467: switch a source's 在看板显示 in Settings (the board's top row no longer has check boxes), then back to the board */
async function showSource(page: Page, selector: string, on: boolean) {
  await page.getByTestId('open-settings').click();
  const sw = page.locator(`[data-testid="source-shown"]${selector}`);
  if (on) await sw.check();
  else await sw.uncheck();
  await page.getByTestId('back').click();
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';

type Env = AppEnv;

async function launch(env: Env) {
  const app = await launchApp(env);
  return { app, page: app.page };
}

/**
 * GitHub#464: closed / merged items are hidden unless a view's "显示已关闭" switch is on. Most tests here were
 * written for a client that listed them once the search was cleared, and they count or click closed items
 * (#128, #137, #138 …): their sign-in turns every view's switch on. The tests of the switch's own default
 * (the first test, the imported table view, test/e2e/show-closed.spec.ts) do not call this.
 */
async function showClosedEverywhere(page: Page) {
  const all = { board: true, table: true, graph: true, running: true, agent: true, human: true, unlabeled: true };
  await page.evaluate((v) => (window as any).cavil.setView({ showClosed: v }), all);
  await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.view.showClosed)).toEqual(all);
  // (settings reach the back end's files a moment later; a test that "quits" next kills the back end outright)
  await page.waitForTimeout(500);
}

/** GitHub#489: a reply / edit / ticked box's notice in the window's notice area (the newest first) */
const sendNotice = (page: Page) => page.locator('[data-testid="notice-area"] [data-testid="send-notice"]');

async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
}

/** GitHub#405: the new-issue dialog keeps labels / milestone / iteration in a fold, shut when it opens */
async function openMoreFields(page: Page) {
  await expect(page.getByTestId('new-issue-more')).toHaveAttribute('data-open', 'no');
  await page.getByTestId('new-issue-more-toggle').click();
  await expect(page.getByTestId('new-issue-more')).toHaveAttribute('data-open', 'yes');
}

/** expected per-column counts straight from the recorded JSON */
function rawCount(field: string, key: 'title' | 'name') {
  const out: Record<string, number> = {};
  for (const p of loadCavilProjectPages())
    for (const n of p.items.nodes) {
      const v = n.fieldValues.nodes.find((x: any) => x.field?.name === field);
      const k = v ? v[key] : '(none)';
      out[k] = (out[k] ?? 0) + 1;
    }
  return out;
}

/**
 * GitHub#275: like rawCount, but a PR counts where the issue that links it is (a PR follows its issue
 * into the issue's column / group). Written from the recording, not from the client's code: the first
 * issue (in recording order) that lists the PR as linked; the recording has no PR descriptions, so
 * GitHub's links are the only ones here (no recorded PR is linked by two issues with different values).
 */
function rawCountFollowing(field: string, key: 'title' | 'name', none = '(none)') {
  const nodes = loadCavilProjectPages().flatMap((p) => p.items.nodes);
  const val = (n: any) => {
    const v = n.fieldValues.nodes.find((x: any) => x.field?.name === field);
    return v ? v[key] : none;
  };
  const byNum = new Map(nodes.map((n: any) => [n.content.number, n]));
  const host = new Map<number, any>();
  for (const n of nodes)
    if (n.content.__typename === 'Issue')
      for (const pr of n.content.closedByPullRequestsReferences?.nodes ?? [])
        if (byNum.get(pr.number)?.content.__typename === 'PullRequest' && !host.has(pr.number)) host.set(pr.number, n);
  const out: Record<string, number> = {};
  for (const n of nodes) {
    const k = val(host.get(n.content.number) ?? n);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

async function columnCounts(page: Page): Promise<Record<string, number>> {
  return page.$$eval('[data-testid="column"]', (cols) =>
    Object.fromEntries(cols.map((c) => [c.getAttribute('data-title'), Number(c.querySelector('[data-testid="column-count"]')!.textContent)])),
  );
}

/** Card count of one column; folded "ended iterations" are opened first (the fixture's dates age). */
async function countOf(page: Page, title: string): Promise<string> {
  const col = page.locator(`[data-testid="column"][data-title="${title}"] [data-testid="column-count"]`);
  await expect(page.locator('[data-testid="column"]').first()).toBeVisible({ timeout: 15_000 });
  if ((await col.count()) === 0 && (await page.getByTestId('ended-group').count()) > 0) await page.getByTestId('ended-group').click();
  return (await col.textContent()) ?? '';
}

let env: Env;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(async () => {
  await closeEngine();
});

test('browser login → board; restart skips login; sources; three column modes; swimlanes; offline restart; revoked credential', async () => {
  let { app, page } = await launch(env);
  await expect(page.getByTestId('login')).toBeVisible();
  await shot(page, '01-login');

  // configure the OAuth Client ID (no built-in one yet), start the device flow
  // the built-in Client ID is GitHub's real app; point the login at the fake's
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toHaveText(/^ABCD-\d+$/);
  await shot(page, '02-device-code');
  await page.getByTestId('open-browser').click();
  await expect.poll(() => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8').trim() : '')).toBe(`${env.fake.web}/login/device`);
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  expect(readFileSync(env.cred, 'utf8')).toMatch(/^gho_/);
  // GitHub#464: a new install starts with an empty search box; the "显示已关闭" switch (off) keeps closed items out
  await expect(page.getByTestId('search')).toHaveValue('');
  await expect(page.getByTestId('show-closed')).not.toBeChecked();

  // add a Project and a repository
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(PROJECT_URL);
  await page.getByTestId('source-add').click();
  await page.getByTestId('source-input').fill('GigleAI/cavil-loop');
  await page.getByTestId('source-add').click();
  await expect(page.getByTestId('source-row')).toHaveCount(2);
  await page.getByTestId('source-input').fill('not a source');
  await page.getByTestId('source-add').click();
  await expect(page.getByTestId('source-error')).toBeVisible();
  await shot(page, '03-settings');
  await page.getByTestId('back').click();

  // the Project brought its first saved web view along ("Pending": table, -label:Done -status:Done — words
  // that only hid finished items, left to the "显示已关闭" switch since GitHub#464, so the box stays empty);
  // this test is about the board and counts every item on it, so switch back to it and show the closed ones too
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('search')).toHaveValue('');
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await page.getByTestId('search').fill('');
  await page.getByTestId('show-closed').check();

  // iteration (default): each iteration column holds what the Project says, a PR counted where its issue is (GitHub#275)
  // 12 items say Iteration 25; PR #129 (no iteration) is shown under its issue there (GitHub#275)
  await expect.poll(() => countOf(page, 'Iteration 25'), { timeout: 15_000 }).toBe('13');
  const iter = rawCountFollowing('Iteration', 'title');
  if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').click();
  await expect(page.locator('[data-testid="column"][data-title="Iteration 24"]')).toBeVisible();
  const got = await columnCounts(page);
  for (const [t, n] of Object.entries(iter)) if (t !== '(none)') expect(got[t], t).toBe(n);
  expect(got['无迭代']).toBe(iter['(none)']);
  // repository items that are not on the board
  const projectKeys = new Set(loadCavilProjectPages().flatMap((p) => p.items.nodes.map((n: any) => n.content.number)));
  const repoOnly = env.fake.state.repos
    .get('gigleai/cavil-loop')!
    .filter((r) => (r.state === 'open' || Date.parse(r.updated_at) >= Date.now() - 14 * 86_400_000) && !projectKeys.has(r.number)).length;
  // the repository is a second source: its first full read can land after the Project's (PR #484, a busy machine)
  await expect.poll(async () => (await columnCounts(page))['未加入看板'] ?? 0, { timeout: 15_000 }).toBe(repoOnly);
  await shot(page, '04-by-iteration');

  await page.getByTestId('mode').selectOption('status');
  const status = rawCountFollowing('Status', 'name');
  await expect.poll(async () => (await columnCounts(page))['Done']).toBe(status['Done']);
  expect((await columnCounts(page))['Backlog']).toBe(status['Backlog']);
  await shot(page, '05-by-status');

  await page.getByTestId('mode').selectOption('milestone');
  await expect.poll(async () => Object.keys(await columnCounts(page))).toEqual(['无里程碑']);
  await page.getByTestId('swimlanes').click();
  await expect(page.getByTestId('swimlanes')).toBeChecked();
  await expect(page.getByTestId('lane')).toHaveCount(1);
  await expect(page.locator('[data-testid="lane"]').first()).toHaveAttribute('data-lane', 'GigleAI/cavil-loop');
  await shot(page, '06-milestone-swimlanes');
  await page.getByTestId('swimlanes').click();
  await expect(page.getByTestId('swimlanes')).not.toBeChecked();
  await page.getByTestId('mode').selectOption('iteration');

  // online: the write entry is a placeholder but not flagged offline
  await expect(page.getByTestId('write-entry')).toHaveAttribute('data-offline', 'no');
  await expect(page.getByTestId('offline')).toHaveCount(0);

  // a source that fails mid-pagination keeps last round's data; the ⚠️ next to refresh says so (GitHub#248)
  env.fake.state.failProjectPage.set('org/gigleai/11', 1);
  await page.getByTestId('refresh').click();
  // GitHub#374: the failing page is asked twice more (after 1 s and 3 s) before the board counts as failed
  await expect(page.getByTestId('sync-trouble')).toBeVisible({ timeout: 15_000 });
  expect(await countOf(page, 'Iteration 25')).toBe('13');
  await page.getByTestId('sync-trouble').click();
  await expect(page.getByTestId('sync-trouble-source')).toContainText('读取失败');
  // GitHub#374: how many failures in a row, and when it is tried again; a refresh by hand does not wait for it
  await expect(page.getByTestId('sync-trouble-retry')).toContainText('起连续失败 1 次 · 下次自动重试');
  await expect(page.getByTestId('sync-trouble-by-hand')).toContainText('重新同步');
  await shot(page, '07-incomplete');
  await page.getByTestId('sync-trouble').click();
  env.fake.state.failProjectPage.clear();

  // restart: no login needed
  await app.close();
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('sync-trouble')).toHaveCount(0, { timeout: 15_000 });
  await app.close();

  // offline restart: content from the cache, flagged offline, writes grey
  env.fake.state.offline = true;
  ({ app, page } = await launch(env));
  // GitHub#270: why, and when it is tried again
  await expect(page.getByTestId('offline')).toContainText('离线：无法连接 GitHub', { timeout: 15_000 });
  // GitHub#324: the bar says when the data was read in full; the header says when it was last checked,
  // and its hover lists every source's two times, the connection and what a check cannot see
  await expect(page.getByTestId('offline')).toContainText('· 数据整份读取：');
  await expect(page.getByTestId('sync-status')).toContainText('上次检查 ');
  const hover = (await page.getByTestId('sync-status').getAttribute('title')) ?? '';
  expect(hover).toMatch(/：整份读取 .+前 · 上次检查 .+前/);
  expect(hover).toContain('最后连上 GitHub：这次打开后还没有连上过');
  expect(hover).toContain('「检查」看不到');
  await expect(page.getByTestId('offline')).toContainText('每分钟自动重试，点刷新可立刻重试');
  expect(await countOf(page, 'Iteration 25')).toBe('13');
  await expect(page.getByTestId('write-entry')).toBeDisabled();
  await expect(page.getByTestId('write-entry')).toHaveAttribute('data-offline', 'yes');
  await shot(page, '08-offline');

  // back online, but the credential was revoked on GitHub
  env.fake.state.offline = false;
  env.fake.state.validTokens.clear();
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('login-reason')).toContainText('凭据已失效');
  expect(existsSync(env.cred)).toBe(false);
  await shot(page, '09-revoked');
  await app.close();
});

test('login: denied on GitHub shows why and stores nothing', async () => {
  const { app, page } = await launch(env);
  // the built-in Client ID is GitHub's real app; point the login at the fake's
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('denied');
  await expect(page.getByTestId('login-error')).toHaveAttribute('data-status', 'denied', { timeout: 15_000 });
  expect(existsSync(env.cred)).toBe(false);
  await shot(page, '10-denied');
  await app.close();
});

test('sign-in method: OAuth app by default; GitHub App needs its own ID; the "what is the difference" page', async () => {
  const { app, page } = await launch(env);
  await expect(page.getByTestId('login')).toBeVisible();
  await expect(page.getByTestId('app-kind-oauth')).toBeChecked();
  await expect(page.getByTestId('permission-text')).toContainText('repo');
  await shot(page, '11-login-method-oauth');

  // the small link opens the explanation page and comes back
  await page.getByTestId('app-kind-help-link').click();
  const help = page.getByTestId('app-kind-help');
  await expect(help).toBeVisible();
  await expect(help.locator('table.compare tbody tr')).toHaveCount(7);
  await expect(help).toContainText('看 App 的设置');
  await expect(help).not.toContainText('碰不到代码');
  await shot(page, '12-app-kind-help');
  await page.getByTestId('help-back').click();
  await expect(page.getByTestId('login')).toBeVisible();

  // GitHub App: no built-in one, so the ID box opens by itself and signing in says what is missing
  await page.getByTestId('app-kind-github-app').click(); // the choice is the app's state: it shows once the app confirms
  await expect(page.getByTestId('app-kind-github-app')).toBeChecked();
  await expect(page.getByTestId('client-id')).toBeVisible();
  await expect(page.getByTestId('client-id')).toHaveValue('');
  await expect(page.getByTestId('permission-text')).toContainText('授权页上列的才算数');
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('login-error')).toContainText('GitHub App');
  await shot(page, '13-login-method-github-app');

  // an OAuth app's ID typed into the GitHub App box: flagged at once, cannot be saved
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await expect(page.getByTestId('client-id-mismatch')).toContainText('不是 GitHub App 的');
  await expect(page.getByTestId('save-client-id')).toBeDisabled();
  await shot(page, '14-client-id-mismatch');

  // with the GitHub App's ID it signs in through that app
  await page.getByTestId('client-id').fill(env.fake.state.appClientId);
  await expect(page.getByTestId('client-id-mismatch')).toHaveCount(0);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  expect(env.fake.state.deviceClientIds).toEqual([env.fake.state.appClientId]);
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });

  // Settings shows the same choice and the same link
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await expect(page.getByTestId('app-kind-github-app')).toBeChecked();
  await page.getByTestId('app-kind-help-link').click();
  await expect(page.getByTestId('app-kind-help')).toBeVisible();
  await page.getByTestId('help-back').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await app.close();
});

// ---- sub-item #138: viewing and changing items, in the real window ----

async function signInWithSources(page: Page, iteration25 = '13') {
  pinLabels();
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(PROJECT_URL);
  await page.getByTestId('source-add').click();
  await page.getByTestId('source-input').fill('GigleAI/cavil-loop');
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  // adding the Project imported its saved web view (#137: table);
  // these tests are about the board and count every item on it, so switch back to it, clear the filter
  // and show the closed ones in every view (GitHub#464)
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await page.getByTestId('search').fill('');
  // the board's and the table's own switches, through the window (each layout keeps its own)
  await page.getByTestId('show-closed').check();
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await page.getByTestId('show-closed').check();
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await expect(page.getByTestId('show-closed')).toBeChecked();
  await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.view.showClosed)).toMatchObject({ board: true, table: true });
  // 12 items say Iteration 25; PR #129 (no iteration) is shown under its issue there (GitHub#275)
  await expect.poll(() => countOf(page, 'Iteration 25'), { timeout: 15_000 }).toBe(iteration25);
}

/**
 * The state these tests are written against: #137–#139 carry exactly
 * `pending/human` (as when they were written), set on the fake GitHub before
 * the first sync rather than taken from whatever a re-recording captured.
 */
function pinLabels() {
  for (const n of [137, 138, 139]) {
    for (const r of env.fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === n) r.labels = [{ name: 'pending/human', color: 'ededed' }];
    for (const p of env.fake.state.projects.get('org/gigleai/11')!)
      for (const node of p.items.nodes) if (node.content?.number === n) node.content.labels.nodes = [{ name: 'pending/human', color: 'ededed' }];
  }
}

/**
 * Add one label from the detail panel: "+ 加标签" opens the picker (GitHub#192), a click on the
 * name sends that one add, Esc puts the picker away again.
 */
async function pickLabel(page: Page, name: string) {
  const detail = page.getByTestId('detail');
  await detail.getByTestId('label-add').click();
  await detail.locator(`[data-testid="label-picker"] [data-testid="picker-item"][data-name="${name}"]`).click();
  await page.keyboard.press('Escape');
  await expect(detail.getByTestId('label-picker')).toHaveCount(0);
}

/** GitHub#488: operations and unsaved changes are said in the window's notice area (nothing to open first). */
async function openNotices(page: Page) {
  await expect(page.getByTestId('notice-area')).toBeVisible();
}

const card = (page: Page, n: number) => page.locator(`[data-testid="card"][data-key="gigleai/cavil-loop#${n}"]`).first();
/**
 * GitHub#488: a field change GitHub took (label / milestone / status / iteration) is said by the field itself:
 * once the write reached GitHub, no result note in the detail or above the board, nothing in the notice area
 */
async function savedQuietly(page: Page, sent: (w: unknown[]) => boolean, from = 0) {
  await expect.poll(() => writes().slice(from).some(sent), { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('action-result')).toHaveCount(0);
  await expect(page.getByTestId('board-action-result')).toHaveCount(0);
  await expect(page.locator('[data-testid="notice-area"] [data-testid="edit-issue"]')).toHaveCount(0);
}
const sentTo = (method: string, tail: string) => (w: unknown[]) => w[0] === method && String(w[1]).endsWith(tail);
const sentOp = (op: string) => (w: unknown[]) => w[0] === op;

const writes = () => env.fake.writes().map((w) => [w.method === 'POST' && w.path === '/api/graphql' ? w.operation : w.method, w.path, w.body ?? w.variables]);

test('detail newest first in an isolated view; labels, status, drag, reply + hand back, merge / refused merge, new issue; offline greys it all', async () => {
  // one recorded PR made open, with comments to order
  const node = env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((n: any) => n.content?.__typename === 'PullRequest')!;
  const prN = node.content.number as number;
  node.content.state = 'OPEN';
  node.content.merged = false;
  env.fake.state.w.comments.set('gigleai/cavil-loop#138', [
    { id: 'C-old', url: 'https://github.com/GigleAI/cavil-loop/issues/138#c1', createdAt: '2026-11-01T01:00:00Z', bodyHTML: '<p>older comment</p>', author: { login: 'user-2' } },
    { id: 'C-new', url: 'https://github.com/GigleAI/cavil-loop/issues/138#c2', createdAt: '2026-11-02T01:00:00Z', bodyHTML: '<p>newer comment <a href="https://github.com/GigleAI/cavil-loop">link</a></p>', author: { login: 'user-3' } },
  ]);
  env.fake.state.w.milestones.set('gigleai/cavil-loop', [{ number: 1, title: 'v1', state: 'open', due_on: null }]);

  const { app, page } = await launch(env);
  await signInWithSources(page);

  // ---- detail: newest first, GitHub's HTML in a sandboxed frame ----
  await card(page, 138).click();
  const detail = page.getByTestId('detail');
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#138');
  const frameEl = page.getByTestId('timeline-frame');
  // scripts on for the frame's own script only (GitHub#193: both policies allow just its hash), never same-origin
  await expect(frameEl).toHaveAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  await expect(frame.locator('details.entry')).toHaveCount(3);
  expect(await frame.locator('details.entry').evaluateAll((els) => els.map((e) => e.getAttribute('data-entry')))).toEqual(['C-new', 'C-old', expect.stringMatching(/^I_/)]);
  await shot(page, '20-detail-newest-first');
  // a link in GitHub's HTML opens the system browser; the frame itself never navigates
  await frame.locator('a', { hasText: 'link' }).click();
  await expect.poll(() => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '')).toContain('https://github.com/GigleAI/cavil-loop\n');
  await expect(frame.locator('details.entry')).toHaveCount(3);

  // ---- labels: add in the detail, remove on the card ----
  let w0 = writes().length;
  await pickLabel(page, 'Done');
  await savedQuietly(page, sentTo('POST', '/issues/138/labels'), w0);
  await expect(card(page, 138).locator('.label', { hasText: 'Done' })).toBeVisible();
  await card(page, 138).hover();
  w0 = writes().length;
  await card(page, 138).locator('[data-testid="card-label-remove"][data-label="Done"]').click();
  await savedQuietly(page, sentTo('DELETE', '/issues/138/labels/Done'), w0);
  await expect(card(page, 138).locator('.label', { hasText: 'Done' })).toHaveCount(0);

  // ---- status and milestone in the detail ----
  w0 = writes().length;
  await detail.getByTestId('status-select').selectOption('In progress');
  await savedQuietly(page, sentOp('CavilSetStatus'), w0);
  w0 = writes().length;
  await detail.getByTestId('milestone-select').selectOption('v1');
  await savedQuietly(page, sentTo('PATCH', '/issues/138'), w0);
  await shot(page, '21-detail-fields');

  // ---- reply with preview, then hand back to the agent ----
  await detail.getByTestId('reply-input').fill('看过了，按 **A** 做');
  await detail.getByTestId('reply-preview-toggle').click();
  await expect(page.frameLocator('[data-testid="reply-preview"]').locator('body')).toContainText('看过了');
  await detail.getByTestId('reply-send').click();
  // GitHub#489: the box is empty at once; the result is said in the window's notice area
  await expect(detail.getByTestId('reply-input')).toHaveValue('');
  await expect(sendNotice(page).first().getByTestId('send-notice-text')).toHaveText('评论已发出');
  await expect(frame.locator('details.entry').first()).toContainText('看过了');
  await shot(page, '22-replied');
  await detail.getByTestId('hand-back').click();
  await expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first().getByTestId('op-notice-text')).toContainText('已交给 agent');
  await expect(card(page, 138).locator('.label', { hasText: 'pending/agent' })).toBeVisible();
  await expect(card(page, 138).locator('.label', { hasText: 'pending/human' })).toHaveCount(0);
  await page.getByTestId('detail-close').click();

  // ---- drag a card to another iteration: only that Project's value changes ----
  const before137 = writes().length;
  await card(page, 137).dragTo(page.locator('[data-testid="column"][data-title="Iteration 26"]'));
  await expect(page.locator('[data-testid="column"][data-title="Iteration 26"] [data-testid="card"][data-key="gigleai/cavil-loop#137"]')).toBeVisible();
  // GitHub#229: the card moves before GitHub answers — wait for the write itself
  await expect.poll(() => writes().slice(before137).map((w) => w[0])).toEqual(['CavilSetIteration']);
  await shot(page, '23-dragged');

  // ---- PR: status next to the buttons; merge refused when a new commit was pushed; then merged ----
  await page.getByTestId('mode').selectOption('status');
  await card(page, prN).click();
  await expect(page.getByTestId('pr-status')).toContainText('可以合并');
  // GitHub#175: the merge method starts where it was last left in this repository
  await expect(page.getByTestId('merge-method')).toHaveValue('merge'); // nothing chosen yet: the first one allowed
  await page.getByTestId('merge-method').selectOption('squash');
  await page.getByTestId('detail-close').click();
  env.fake.state.w.mergeMethods.set('gigleai/cavil-loop', { merge: true, squash: false, rebase: true });
  await card(page, prN).click();
  await expect(page.getByTestId('pr-status')).toContainText('可以合并');
  await expect(page.getByTestId('merge-method')).toHaveValue('merge'); // squash switched off meanwhile: first allowed…
  await page.getByTestId('detail-close').click();
  env.fake.state.w.mergeMethods.delete('gigleai/cavil-loop');
  await card(page, prN).click();
  await expect(page.getByTestId('pr-status')).toContainText('可以合并');
  await expect(page.getByTestId('merge-method')).toHaveValue('squash'); // …and that fallback was not remembered
  const pull = env.fake.state.w.pulls.get(`gigleai/cavil-loop#${prN}`)!;
  const seen = pull.headOid;
  pull.headOid = 'f'.repeat(40); // somebody pushed after the detail was read
  const digest = env.fake.digest();
  await page.getByTestId('merge').click();
  // one sentence: what goes where, and how; no explanatory paragraph
  await expect(page.getByTestId('confirm-dialog').locator('p')).toHaveCount(1);
  await expect(page.getByTestId('confirm-dialog').locator('p')).toContainText('方式：压成一个提交（squash）');
  await shot(page, '24-merge-confirm');
  await page.getByTestId('confirm-ok').click();
  await expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first()).toHaveAttribute('data-kind', 'error');
  await expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first().getByTestId('op-notice-text')).toContainText('新提交');
  expect(env.fake.digest()).toBe(digest);
  await shot(page, '24-merge-refused');
  await page.getByTestId('detail-refresh').click();
  await expect(page.getByTestId('pr-status')).toContainText('fffffff');
  await expect(page.getByTestId('merge-method')).toHaveValue('squash');
  await page.getByTestId('merge').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first().getByTestId('op-notice-text')).toContainText('已合并');
  await expect(card(page, prN).getByTestId('card-state')).toContainText('已合并');
  expect(env.fake.writes().filter((w) => w.path.endsWith('/merge')).map((w) => w.body)).toEqual([
    { merge_method: 'squash', sha: seen },
    { merge_method: 'squash', sha: 'f'.repeat(40) },
  ]);
  await shot(page, '25-merged');
  await page.getByTestId('detail-close').click();

  // ---- new issue: labels from the picker (GitHub's colours), joins the Project ticked in the dialog (GitHub#205) ----
  await page.getByTestId('write-entry').click();
  await page.getByTestId('new-issue-title').fill('客户端里建的 issue');
  await page.getByTestId('new-issue-body').fill('正文');
  await openMoreFields(page);
  await page.getByTestId('new-issue-label-add').click();
  await page.locator('[data-testid="new-issue-label-picker"] [data-testid="picker-item"][data-name="pending/human"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="new-issue-label-chip"][data-label="pending/human"]')).toBeVisible();
  // the board holding this repository's items starts ticked (GitHub#231)
  await expect(page.getByTestId('new-issue-project')).toHaveCount(1);
  await expect(page.getByTestId('new-issue-projects')).toContainText('cavil project');
  await expect(page.getByTestId('new-issue-project')).toBeChecked();
  await shot(page, '26-new-issue');
  // GitHub gives the next number: one past the highest one in the recorded data
  const next =
    1 +
    Math.max(
      ...env.fake.state.repos.get('gigleai/cavil-loop')!.map((r: any) => r.number),
      ...env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes.map((n: any) => n.content?.number ?? 0)),
    );
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', `gigleai/cavil-loop#${next}`);
  expect(writes().filter((w) => w[0] === 'POST' && w[1] === '/api/repos/GigleAI/cavil-loop/issues')).toEqual([
    ['POST', '/api/repos/GigleAI/cavil-loop/issues', { title: '客户端里建的 issue', body: '正文', labels: ['pending/human'] }],
  ]);
  // joined the ticked board (and, GitHub#276, set its current iteration when today is in one — pinned in its own test below)
  await expect.poll(() => writes().some((w) => w[0] === 'CavilAddProjectItem')).toBe(true);
  await expect(card(page, next)).toBeVisible();

  // ---- offline: every change entry greys out, nothing is sent ----
  env.fake.state.offline = true;
  // from the keyboard: a click on the toolbar would put the panel away (GitHub#191)
  await page.getByTestId('refresh').press('Enter');
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('reply-input')).toBeDisabled();
  await expect(page.getByTestId('label-add')).toBeDisabled();
  await expect(page.getByTestId('write-entry')).toBeDisabled();
  await shot(page, '27-offline-detail');
  await app.close();
});

// ---- GitHub#177: after a change in the detail, the list follows ----

test('GitHub#177: merging in the detail shows the issue it closes closed at once; GitHub moving the cards later shows a few seconds after, without a manual sync', async () => {
  // recorded: PR #146 (Status Backlog) closes issue #139 (Status In progress); both made open in every copy
  for (const r of env.fake.state.repos.get('gigleai/cavil-loop')!) {
    if (r.number === 146) Object.assign(r, { state: 'open', pull_request: { ...r.pull_request, merged_at: null } });
    if (r.number === 139) r.state = 'open';
  }
  for (const p of env.fake.state.projects.get('org/gigleai/11')!)
    for (const n of p.items.nodes) {
      if (n.content?.number === 146) Object.assign(n.content, { state: 'OPEN', merged: false });
      if (n.content?.number === 139) n.content.state = 'OPEN';
    }
  // GitHub's Project automation (merged / closed → Done) runs on GitHub's side a second later
  env.fake.state.w.automation = { delayMs: 1000, status: 'Done' };
  const { app, page } = await launch(env);
  await signInWithSources(page);
  await page.getByTestId('mode').selectOption('status');
  const inColumn = (title: string, n: number) => page.locator(`[data-testid="column"][data-title="${title}"] [data-testid="card"][data-key="gigleai/cavil-loop#${n}"]`);
  await expect(inColumn('In progress', 139)).toBeVisible();
  await expect(card(page, 139).getByTestId('card-state')).toHaveClass(/\bopen\b/);
  const rounds = () => env.fake.log.filter((l) => l.operation === 'CavilProjectItems' && !(l.variables as any)?.after).length;
  const before = rounds();

  await card(page, 146).click();
  await expect(page.getByTestId('pr-status')).toContainText('可以合并');
  await page.getByTestId('merge').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first().getByTestId('op-notice-text')).toContainText('已合并');
  // at once, with no sync round: the PR merged and the issue it closes closed, both still in their old columns
  // colours follow GitHub (#174): an issue a merge closed (completed) and a merged PR are both purple ("done")
  await expect(card(page, 139).getByTestId('card-state')).toHaveAttribute('data-tone', 'done');
  await expect(card(page, 139).getByTestId('card-state')).toContainText('已关闭');
  await expect(card(page, 146).getByTestId('card-state')).toHaveAttribute('data-tone', 'done');
  await expect(card(page, 146).getByTestId('card-state')).toContainText('已合并');
  expect(rounds()).toBe(before);
  await expect(inColumn('In progress', 139)).toBeVisible();
  await shot(page, '27-merged-issue-closed');
  // a few seconds later the follow-up round reads what GitHub's automation did: both in Done
  await expect(inColumn('Done', 139)).toBeVisible({ timeout: 20_000 });
  await expect(inColumn('Done', 146)).toBeVisible();
  expect(rounds()).toBeGreaterThan(before);
  await shot(page, '28-follow-up-done');
  await app.close();
});

test('a slow answer for the item you left never lands on the one you are looking at; images only from GitHub\'s own hosts', async () => {
  const w = env.fake.state.w;
  w.bodies.set('gigleai/cavil-loop#138', '<p>BODY_138</p>');
  w.bodies.set('gigleai/cavil-loop#137', [
    '<p>BODY_137</p>',
    '<p><img alt="via proxy" src="https://camo.githubusercontent.com/probe-138"></p>',
    '<p><img alt="attachment" src="https://private-user-images.githubusercontent.com/probe.png?jwt=x"></p>',
    '<p><img alt="old attachment" src="https://user-images.githubusercontent.com/probe-old.png"></p>',
    '<p><img alt="on github" src="https://github.com/GigleAI/cavil-loop/raw/main/probe.png"></p>',
    '<p><img alt="look-alike" src="https://camo.githubusercontent.com.evil.example/probe.png"></p>',
    '<p><img alt="raw" src="https://raw.githubusercontent.com/o/r/main/probe.png"></p>',
    '<p><img alt="raw look-alike" src="https://raw.githubusercontent.com.evil.example/o/r/main/probe.png"></p>',
    '<p><img alt="s3" src="https://github-production-user-asset-6210df.s3.amazonaws.com/probe.png"></p>',
  ].join(''));
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const frame = page.frameLocator('[data-testid="timeline-frame"]');

  // 1. #138's detail is slow; #137 is opened meanwhile and finishes first
  const releaseDetail = env.fake.holdWhen((e) => e.operation === 'CavilItemDetail' && e.variables?.number === 138);
  await card(page, 138).click();
  await expect.poll(() => env.fake.log.some((l) => l.operation === 'CavilItemDetail' && l.variables?.number === 138)).toBe(true);
  await card(page, 137).click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  await expect(frame.locator('body')).toContainText('BODY_137');
  releaseDetail();
  await expect.poll(() => env.fake.log.find((l) => l.operation === 'CavilItemDetail' && l.variables?.number === 138)?.status).toBe(200);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  await expect(frame.locator('body')).toContainText('BODY_137');
  await expect(frame.locator('body')).not.toContainText('BODY_138');

  // 2. images (GitHub#205, a repo's raw files since GitHub#267): GitHub's own hosts are requested (and shown);
  //    the others are not even tried, and the entry says so
  await expect(frame.locator('[data-blocked]')).toHaveAttribute('data-blocked', '3');
  // (every request the window made outside its own bridge; the app's page policy is what stops the rest)
  const reqs = () => (existsSync(env.requests) ? readFileSync(env.requests, 'utf8') : '');
  for (const u of [
    'https://github.com/GigleAI/cavil-loop/raw/main/probe.png',
    'https://camo.githubusercontent.com/probe-138',
    'https://private-user-images.githubusercontent.com/probe.png?jwt=x',
    'https://user-images.githubusercontent.com/probe-old.png',
    'https://raw.githubusercontent.com/o/r/main/probe.png',
  ])
    await expect.poll(reqs).toContain(`request ${u}\n`);
  for (const alt of ['via proxy', 'attachment', 'old attachment', 'on github', 'raw'])
    await expect.poll(() => frame.locator(`img[alt="${alt}"]`).evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  const seen = reqs();
  // look-alikes (of the raw host too), the storage behind attachments: never even asked
  expect(seen).not.toContain('evil.example');
  expect(seen).not.toContain('amazonaws.com');
  expect(seen.split('\n').filter((l) => l && !/^request https:\/\/((api\.)?github\.com|(avatars|private-user-images|user-images|camo|raw)\.githubusercontent\.com)\//.test(l))).toEqual([]);
  await shot(page, '28-images-github-only');

  // 3. a change still in flight when another item is opened: its result goes to the board, not into the new item
  const releaseWrite = env.fake.holdWhen((e) => e.method === 'POST' && e.path.endsWith('/issues/137/labels'));
  await pickLabel(page, 'Done');
  await expect.poll(() => env.fake.log.some((l) => l.method === 'POST' && l.path.endsWith('/issues/137/labels'))).toBe(true);
  await card(page, 138).click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', 'gigleai/cavil-loop#138');
  await expect(frame.locator('body')).toContainText('BODY_138');
  await page.getByTestId('reply-input').fill('写给 138 的草稿');
  releaseWrite();
  // GitHub#488: the change is said by the card (it shows the label), no note in the new item nor above the board
  await expect(card(page, 137).locator('.label', { hasText: 'Done' })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('board-action-result')).toHaveCount(0);
  await expect(page.getByTestId('action-result')).toHaveCount(0);
  await expect(page.getByTestId('reply-input')).toHaveValue('写给 138 的草稿');
  await expect(frame.locator('body')).toContainText('BODY_138');
  await expect(card(page, 137).locator('.label', { hasText: 'Done' })).toBeVisible();
  await shot(page, '29-left-behind-result');
  await app.close();
});

/** hold only the first request matching `pred` (later ones go through) */
function holdFirst(pred: (e: any) => boolean): () => void {
  let taken = false;
  return env.fake.holdWhen((e) => {
    if (taken || !pred(e)) return false;
    taken = true;
    return true;
  });
}

test('leave an item and come back: nothing that was in flight lands on the new opening (detail, labels, preview, reply)', async () => {
  const w = env.fake.state.w;
  w.bodies.set('gigleai/cavil-loop#138', '<p>BODY_OLD</p>');
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  const detail = page.getByTestId('detail');
  const roundTrip = async () => {
    await card(page, 137).click();
    await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
    await card(page, 138).click();
    await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#138');
  };

  // the first opening of #138: its detail read and its label list are both slow
  const releaseDetail = holdFirst((e) => e.operation === 'CavilItemDetail' && e.variables?.number === 138);
  const releaseLabels = holdFirst((e) => e.method === 'GET' && /\/labels(\?|$)/.test(e.path));
  await card(page, 138).click();
  await expect.poll(() => env.fake.log.filter((l) => /\/labels(\?|$)/.test(l.path) && l.method === 'GET').length).toBe(1);
  // the data changes on GitHub; the slow answers already carry the old one
  w.bodies.set('gigleai/cavil-loop#138', '<p>BODY_NEW</p>');
  w.repoLabels.set('gigleai/cavil-loop', [...w.repoLabels.get('gigleai/cavil-loop')!, { name: 'NEW_LABEL', color: '00ff00' }]);
  await roundTrip();
  await expect(frame.locator('body')).toContainText('BODY_NEW');
  // the label candidates as the picker lists them (open it, count, put it away)
  const newLabelListed = async () => {
    await detail.getByTestId('label-add').click();
    const n = await detail.locator('[data-testid="label-picker"] [data-testid="picker-item"][data-name="NEW_LABEL"]').count();
    await page.keyboard.press('Escape');
    await expect(detail.getByTestId('label-picker')).toHaveCount(0);
    return n;
  };
  await expect.poll(newLabelListed).toBe(1);
  releaseDetail();
  releaseLabels();
  await expect.poll(() => env.fake.log.filter((l) => l.operation === 'CavilItemDetail' && l.variables?.number === 138).every((l) => l.status === 200)).toBe(true);
  await page.waitForTimeout(300);
  await expect(frame.locator('body')).toContainText('BODY_NEW'); // [detail] old read did not land
  expect(await newLabelListed()).toBe(1); // [options] old list did not land

  // [preview] asked in one opening, answered in the next
  const releasePreview = holdFirst((e) => e.path === '/api/markdown');
  await detail.getByTestId('reply-input').fill('PREVIEW_OLD');
  await detail.getByTestId('reply-preview-toggle').click();
  await expect.poll(() => env.fake.log.some((l) => l.path === '/api/markdown')).toBe(true);
  await roundTrip();
  await detail.getByTestId('reply-input').fill('PREVIEW_NEW');
  await detail.getByTestId('reply-preview-toggle').click();
  await expect(page.frameLocator('[data-testid="reply-preview"]').locator('body')).toContainText('PREVIEW_NEW');
  releasePreview();
  await expect.poll(() => env.fake.log.filter((l) => l.path === '/api/markdown').every((l) => l.status === 200)).toBe(true);
  await page.waitForTimeout(300);
  await expect(page.frameLocator('[data-testid="reply-preview"]').locator('body')).toContainText('PREVIEW_NEW');
  await expect(page.frameLocator('[data-testid="reply-preview"]').locator('body')).not.toContainText('PREVIEW_OLD');
  await detail.getByTestId('reply-preview-toggle').click(); // back to editing

  // [write] the reviewer's case: send, leave, come back, write a new draft, then the old send finishes
  const releaseSend = holdFirst((e) => e.method === 'POST' && e.path.endsWith('/issues/138/comments'));
  await detail.getByTestId('reply-input').fill('OLD_MESSAGE_SENT');
  await detail.getByTestId('reply-send').click();
  await expect.poll(() => env.fake.log.some((l) => l.method === 'POST' && l.path.endsWith('/issues/138/comments'))).toBe(true);
  await roundTrip();
  await detail.getByTestId('reply-input').fill('NEW_UNSENT_DRAFT_AFTER_RETURN');
  releaseSend();
  // GitHub#489: the controller sent it — said once, in the window's notice area, about #138
  await expect(sendNotice(page).first()).toHaveAttribute('data-key', 'gigleai/cavil-loop#138');
  await expect(sendNotice(page).first().getByTestId('send-notice-text')).toHaveText('评论已发出');
  await expect(page.getByTestId('board-action-result')).toHaveCount(0);
  await expect(detail.getByTestId('reply-input')).toHaveValue('NEW_UNSENT_DRAFT_AFTER_RETURN');
  await expect(detail.getByTestId('reply-send')).toBeEnabled(); // the new opening is not left "busy"
  await expect(page.getByTestId('action-result')).toHaveCount(0);
  expect(w.comments.get('gigleai/cavil-loop#138')!.map((c) => c.bodyHTML)).toEqual(['<p>OLD_MESSAGE_SENT</p>']);

  // within one opening, a newer call of the same kind wins: [detail] the re-read after a change vs. a slow refresh, [preview] typing after asking
  w.bodies.set('gigleai/cavil-loop#138', '<p>BODY_REFRESH_OLD</p>');
  const releaseRefresh = holdFirst((e) => e.operation === 'CavilItemDetail' && e.variables?.number === 138);
  await detail.getByTestId('detail-refresh').click();
  await expect.poll(() => env.fake.log.filter((l) => l.operation === 'CavilItemDetail' && l.variables?.number === 138).at(-1)?.status).toBe(0);
  w.bodies.set('gigleai/cavil-loop#138', '<p>BODY_REFRESH_NEW</p>');
  // a change made meanwhile re-reads the detail: that newer read must win
  await pickLabel(page, 'pending/PR');
  await expect(detail.locator('[data-testid="detail-label"][data-label="pending/PR"]')).toHaveAttribute('data-edit', '', { timeout: 15_000 });
  await expect(frame.locator('body')).toContainText('BODY_REFRESH_NEW');
  releaseRefresh();
  await page.waitForTimeout(300);
  await expect(frame.locator('body')).toContainText('BODY_REFRESH_NEW');
  await expect(frame.locator('body')).not.toContainText('BODY_REFRESH_OLD');

  const releasePreview2 = holdFirst((e) => e.path === '/api/markdown');
  await detail.getByTestId('reply-input').fill('TYPED_FIRST');
  await detail.getByTestId('reply-preview-toggle').click();
  await expect.poll(() => env.fake.log.filter((l) => l.path === '/api/markdown').at(-1)?.status).toBe(0);
  await detail.getByTestId('reply-input').fill('TYPED_AFTER');
  releasePreview2();
  await expect.poll(() => env.fake.log.filter((l) => l.path === '/api/markdown').every((l) => l.status === 200)).toBe(true);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('reply-preview')).toHaveCount(0); // the preview of text that is gone never shows
  await detail.getByTestId('reply-input').fill('');

  // close and reopen is a new opening too
  const releaseLabel = holdFirst((e) => e.method === 'POST' && e.path.endsWith('/issues/138/labels'));
  await pickLabel(page, 'Done');
  await expect.poll(() => env.fake.log.some((l) => l.method === 'POST' && l.path.endsWith('/issues/138/labels'))).toBe(true);
  await page.getByTestId('detail-close').click();
  await card(page, 138).click();
  await detail.getByTestId('reply-input').fill('DRAFT_AFTER_REOPEN');
  releaseLabel();
  await expect(detail.locator('[data-testid="detail-label"][data-label="Done"]')).toHaveAttribute('data-edit', '', { timeout: 15_000 });
  await page.waitForTimeout(300);
  await expect(page.getByTestId('board-action-result')).toHaveCount(0);
  await expect(detail.getByTestId('reply-input')).toHaveValue('DRAFT_AFTER_REOPEN');
  await expect(page.getByTestId('action-result')).toHaveCount(0);
  await shot(page, '30-round-trip');
  await app.close();
});

test('GitHub#226: the open detail follows the sync rounds — new comment without a click, draft / scroll / unfolded kept; no change no read; a failed source or read changes nothing; a change sent wins over an older read', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const w = env.fake.state.w;
  const at = (i: number) => new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();
  const comment = (id: string, i: number, text: string) => ({ id, url: `https://github.com/GigleAI/cavil-loop/issues/138#${id}`, createdAt: at(i), bodyHTML: `<p>${text}</p>`, author: { login: 'user-2' } });
  w.comments.set('gigleai/cavil-loop#138', Array.from({ length: 30 }, (_, i) => comment(`C-${i}`, i, `comment ${i} ` + 'words '.repeat(40))));
  /** GitHub changed the item: its update time moves on every copy (what the next round reads) */
  const touchItem = (n: number) => {
    const c = findCopies(store, 'GigleAI/cavil-loop', n)!;
    const now = new Date().toISOString();
    for (const r of c.rest) r.updated_at = now;
    for (const g of c.gql) g.updatedAt = now;
  };
  const reads = (n: number) => env.fake.log.filter((l) => l.operation === 'CavilItemDetail' && l.variables?.number === n);
  const rounds = () => env.fake.log.filter((l) => l.operation === 'CavilViewer').length;
  const { app, page } = await launch(env);
  /** one sync round from the shell's beat, waited until it is over (the board's refresh button is enabled again) */
  const round = async () => {
    const n = rounds();
    app.desktop.push({ kind: 'tick' });
    await expect.poll(rounds).toBeGreaterThan(n);
    await expect(page.getByTestId('refresh')).toBeEnabled();
    await page.waitForTimeout(400);
  };
  await signInWithSources(page);
  await card(page, 138).click();
  const detail = page.getByTestId('detail');
  const frameEl = page.getByTestId('timeline-frame');
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  await expect(frameEl).toHaveAttribute('data-ready', 'yes');
  await expect(frame.locator('details.entry')).toHaveCount(31);

  // ---- nothing changed on GitHub: no read, no redraw ----
  const render0 = await frameEl.getAttribute('data-render');
  const reads0 = reads(138).length;
  await round();
  expect(reads(138).length).toBe(reads0);
  await expect(frameEl).toHaveAttribute('data-render', render0!);

  // ---- a new comment arrives: shown after the next round, nothing clicked; draft, scroll and unfolded entries kept ----
  await detail.getByTestId('reply-input').fill('MY_UNSENT_DRAFT');
  await frame.locator('details.entry[data-entry="C-3"] > summary').click({ position: { x: 40, y: 10 } }); // unfold an older one by hand
  await expect(frame.locator('details.entry[data-entry="C-3"]')).toHaveAttribute('open', '');
  await frame.locator('body').evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(300); // the frame reports its view
  const scrolled = await frame.locator('body').evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(100);
  w.comments.get('gigleai/cavil-loop#138')!.push(comment('C-AGENT', 50, 'AGENT_REPLY_226'));
  touchItem(138);
  await round();
  await expect(frame.locator('details.entry[data-entry="C-AGENT"]')).toHaveCount(1);
  await expect(frame.locator('body')).toContainText('AGENT_REPLY_226');
  expect(reads(138).length).toBe(reads0 + 1);
  await expect(detail.getByTestId('reply-input')).toHaveValue('MY_UNSENT_DRAFT');
  await expect(frame.locator('details.entry[data-entry="C-3"]')).toHaveAttribute('open', '');
  expect(await frame.locator('body').evaluate(() => window.scrollY)).toBe(scrolled);
  await expect(page.getByTestId('detail-stale')).toHaveCount(0);
  await expect(page.getByTestId('detail-error')).toHaveCount(0);
  await shot(page, '226-detail-follows-round');

  // ---- every source carrying the item failed this round: its cached copy is no new data, no read ----
  env.fake.state.failProjectPage.set('org/gigleai/11', 0);
  env.fake.state.failRepoPage.set('gigleai/cavil-loop', 1);
  w.bodies.set('gigleai/cavil-loop#138', '<p>BODY_AFTER_FAILED_ROUND</p>');
  touchItem(138);
  const reads1 = reads(138).length;
  await round();
  expect(reads(138).length).toBe(reads1);
  env.fake.state.failProjectPage.clear();
  env.fake.state.failRepoPage.clear();
  // the next complete round brings it — GitHub#374: sources that just failed wait a minute for the
  // next automatic read, so this round is the refresh by hand (which never waits)
  {
    const n = rounds();
    await page.getByTestId('refresh').click();
    await expect.poll(rounds).toBeGreaterThan(n);
    await expect(page.getByTestId('refresh')).toHaveAttribute('data-syncing', 'no');
    await page.waitForTimeout(400);
  }
  await expect(frame.locator('body')).toContainText('BODY_AFTER_FAILED_ROUND');

  // ---- the automatic read fails: what is on screen stays, small print says from when, no error banner; the next round recovers ----
  w.failDetail.add('gigleai/cavil-loop#138');
  w.bodies.set('gigleai/cavil-loop#138', '<p>BODY_WHILE_READ_FAILS</p>');
  touchItem(138);
  await round();
  await expect(page.getByTestId('detail-stale')).toContainText('自动更新失败，显示的是');
  await expect(page.getByTestId('detail-error')).toHaveCount(0);
  await expect(frame.locator('body')).toContainText('BODY_AFTER_FAILED_ROUND');
  await expect(frame.locator('body')).toContainText('AGENT_REPLY_226');
  w.failDetail.delete('gigleai/cavil-loop#138');
  await round(); // nothing new on GitHub, but the failed read left the mark: tried again
  await expect(frame.locator('body')).toContainText('BODY_WHILE_READ_FAILS');
  await expect(page.getByTestId('detail-stale')).toHaveCount(0);

  // ---- an automatic read on its way, then a change is sent: the older read never lands ----
  // the failing pass first: a successful change schedules one more round 5 s later, which would read the detail by itself
  for (const ok of [false, true]) {
    const tag = ok ? 'OK' : 'FAILS';
    w.bodies.set('gigleai/cavil-loop#138', `<p>BODY_BEFORE_CHANGE_${tag}</p>`);
    touchItem(138);
    const release = holdFirst((e) => e.operation === 'CavilItemDetail' && e.variables?.number === 138);
    const before = reads(138).length;
    app.desktop.push({ kind: 'tick' });
    await expect.poll(() => reads(138).length).toBe(before + 1); // the automatic read was asked (and is held)
    w.bodies.set('gigleai/cavil-loop#138', `<p>BODY_AFTER_CHANGE_${tag}</p>`);
    w.failLabel = ok ? null : 'Done';
    // the change is held too: the old read answers while the change is still on its way
    const releaseWrite = holdFirst((e) => e.method === 'POST' && e.path.endsWith('/issues/138/labels'));
    await pickLabel(page, 'Done');
    await expect.poll(() => env.fake.log.some((l) => l.method === 'POST' && l.path.endsWith('/issues/138/labels') && l.status === 0)).toBe(true);
    release();
    await expect.poll(() => reads(138)[before]?.status).toBe(200); // the held automatic read has answered
    await page.waitForTimeout(400);
    await expect(frame.locator('body')).not.toContainText(`BODY_BEFORE_CHANGE_${tag}`); // it never landed
    releaseWrite();
    // GitHub#488: a refused field change is said in the window's notice area, a saved one by the field alone
    if (!ok) await expect(page.locator('[data-testid="notice-area"] [data-testid="edit-issue"]').first()).toHaveAttribute('data-edit', 'failed');
    await expect(frame.locator('body')).toContainText(`BODY_AFTER_CHANGE_${tag}`); // the read after the change, both ways
    await expect(page.getByTestId('action-result')).toHaveCount(0);
    await page.waitForTimeout(400);
    await expect(frame.locator('body')).toContainText(`BODY_AFTER_CHANGE_${tag}`);
    await expect(frame.locator('body')).not.toContainText(`BODY_BEFORE_CHANGE_${tag}`);
    await expect(page.getByTestId('detail-error')).toHaveCount(0);
  }
  w.failLabel = null;
  // after a failed and a successful change, rounds go on following GitHub
  w.bodies.set('gigleai/cavil-loop#138', '<p>BODY_LATER_ROUND</p>');
  touchItem(138);
  await round();
  await expect(frame.locator('body')).toContainText('BODY_LATER_ROUND');

  // ---- a change in flight when the round comes: no automatic read; the change's own read follows ----
  const releaseWrite = holdFirst((e) => e.method === 'POST' && e.path.endsWith('/issues/138/labels'));
  w.bodies.set('gigleai/cavil-loop#138', '<p>BODY_DURING_WRITE</p>');
  touchItem(138);
  const detailLabelAdd = pickLabel(page, 'pending/PR');
  await expect.poll(() => env.fake.log.some((l) => l.method === 'POST' && l.path.endsWith('/issues/138/labels') && l.status === 0)).toBe(true);
  await detailLabelAdd;
  const reads2 = reads(138).length;
  await round();
  expect(reads(138).length).toBe(reads2);
  releaseWrite();
  await expect(frame.locator('body')).toContainText('BODY_DURING_WRITE');
  await expect(page.getByTestId('action-result')).toHaveCount(0);
  expect(reads(138).length).toBe(reads2 + 1);
  await app.close();
});

test('GitHub#226: an open PR whose checks are still running is read every round until they finish', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const node = env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((n: any) => n.content?.__typename === 'PullRequest')!;
  const prN = node.content.number as number;
  const c = findCopies(store, 'GigleAI/cavil-loop', prN)!;
  for (const g of c.gql) Object.assign(g, { state: 'OPEN', merged: false });
  for (const r of c.rest) Object.assign(r, { state: 'open', pull_request: { ...(r.pull_request ?? {}), merged_at: null } });
  const pull = pullOf(store, c);
  pull.checks = 'PENDING';
  const reads = () => env.fake.log.filter((l) => l.operation === 'CavilItemDetail' && l.variables?.number === prN);
  const rounds = () => env.fake.log.filter((l) => l.operation === 'CavilViewer').length;
  const { app, page } = await launch(env);
  const round = async () => {
    const n = rounds();
    app.desktop.push({ kind: 'tick' });
    await expect.poll(rounds).toBeGreaterThan(n);
    await expect(page.getByTestId('refresh')).toBeEnabled();
    await page.waitForTimeout(400);
  };
  await signInWithSources(page);
  await card(page, prN).click();
  const detail = page.getByTestId('detail');
  await expect(detail).toHaveAttribute('data-key', `gigleai/cavil-loop#${prN}`);
  await expect(detail.getByTestId('pr-status')).toContainText('检查：进行中');
  // nothing about the PR changed (its update time is the same), but its checks were running: read every round
  const r0 = reads().length;
  const frameEl = page.getByTestId('timeline-frame');
  await expect(frameEl).toHaveAttribute('data-ready', 'yes');
  const render0 = await frameEl.getAttribute('data-render');
  await round();
  expect(reads().length).toBe(r0 + 1);
  await round();
  expect(reads().length).toBe(r0 + 2);
  // read twice, the same each time: the discussion was not drawn again (a text selection in it survives)
  await expect(frameEl).toHaveAttribute('data-render', render0!);
  pull.checks = 'SUCCESS';
  await round();
  expect(reads().length).toBe(r0 + 3);
  await expect(detail.getByTestId('pr-status')).toContainText('检查：全部通过');
  // finished: no more reads while nothing changes
  await round();
  await round();
  expect(reads().length).toBe(r0 + 3);
  await app.close();
});

test('GitHub#226 (PR #227 review round 1): a read with the same content still counts as confirmed — a later failed read says the time of that one, and nothing was redrawn', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const node = env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((n: any) => n.content?.__typename === 'PullRequest')!;
  const prN = node.content.number as number;
  const c = findCopies(store, 'GigleAI/cavil-loop', prN)!;
  for (const g of c.gql) Object.assign(g, { state: 'OPEN', merged: false });
  for (const r of c.rest) Object.assign(r, { state: 'open', pull_request: { ...(r.pull_request ?? {}), merged_at: null } });
  pullOf(store, c).checks = 'PENDING'; // read every round, the same content each time
  const reads = () => env.fake.log.filter((l) => l.operation === 'CavilItemDetail' && l.variables?.number === prN);
  const { app, page } = await launch(env);
  // the window's clock (where the read time is taken) at 09:00 local, then 09:05, then 09:10
  const local = (hh: number, mm: number) => {
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    return d;
  };
  await page.clock.setFixedTime(local(9, 0));
  await page.reload();
  await page.waitForSelector('[data-testid="app-root"]');
  /** one round from the shell's beat, waited until the detail read it started has answered */
  const round = async () => {
    const n = reads().length;
    app.desktop.push({ kind: 'tick' });
    await expect.poll(() => reads().length).toBeGreaterThan(n);
    await expect.poll(() => reads()[n]?.status ?? 0).toBeGreaterThanOrEqual(200);
    await expect(page.getByTestId('detail-refresh')).toBeEnabled();
    await page.waitForTimeout(300);
  };
  await signInWithSources(page);
  await card(page, prN).click();
  await expect(page.getByTestId('pr-status')).toContainText('检查：进行中');
  const frameEl = page.getByTestId('timeline-frame');
  await expect(frameEl).toHaveAttribute('data-ready', 'yes');
  const render0 = await frameEl.getAttribute('data-render');
  await page.clock.setFixedTime(local(9, 5));
  await round(); // succeeds, same content
  await expect(frameEl).toHaveAttribute('data-render', render0!);
  await page.clock.setFixedTime(local(9, 10));
  env.fake.state.w.failDetail.add(`gigleai/cavil-loop#${prN}`);
  await round(); // fails
  await expect(page.getByTestId('detail-stale')).toHaveText('自动更新失败，显示的是 09:05 的内容');
  await expect(page.getByTestId('detail-error')).toHaveCount(0);
  await app.close();
});

// ---- sub-item #137: search, table, imported views ----

const filterResults: { query: string; server: string[] }[] = JSON.parse(
  readFileSync(join(root, 'test/fixtures/cavil-project-11.filters.json'), 'utf8'),
).results;

/** raw recorded iteration title per item key, independent of the client code */
function rawIteration(): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of loadCavilProjectPages())
    for (const n of p.items.nodes) {
      const v = n.fieldValues.nodes.find((x: any) => x.iterationId);
      out.set(`${n.content.repository.nameWithOwner.toLowerCase()}#${n.content.number}`, v ? v.title : '无迭代');
    }
  return out;
}

/** per group, the rows that matched the search (not the sub-issues added under them, GitHub#368) */
async function matchedGroupCounts(page: Page): Promise<Record<string, number>> {
  return page.$$eval('[data-testid="group"]', (gs) =>
    Object.fromEntries(gs.map((g) => [g.getAttribute('data-title'), g.querySelectorAll('[data-testid="row"]:not([data-pulled])').length])),
  );
}
/** per group, every row it shows */
async function shownGroupRows(page: Page): Promise<Record<string, number>> {
  return page.$$eval('[data-testid="group"]', (gs) => Object.fromEntries(gs.map((g) => [g.getAttribute('data-title'), g.querySelectorAll('[data-testid="row"]').length])));
}

async function groupCounts(page: Page): Promise<Record<string, number>> {
  return page.$$eval('[data-testid="group"]', (gs) =>
    Object.fromEntries(gs.map((g) => [g.getAttribute('data-title'), Number(g.querySelector('[data-testid="group-count"]')!.textContent)])),
  );
}

test('saved web view imported as a table; search with GitHub syntax; yellow bar for unsupported words; table settings survive a restart', async () => {
  // sign in through the device flow against the fake GitHub
  let { app, page } = await launch(env);
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(`${PROJECT_URL}/views/1`);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();

  // no setting touched: the table equals what the view shows on GitHub —
  // same items as GitHub's own filter, grouped by the recorded iteration values
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  // GitHub#464: the view's filter only hid finished items — the box stays empty and the switch (off) keeps
  // closed items out; to compare with GitHub's own result for that filter, write it back with the switch on
  await expect(page.getByTestId('search')).toHaveValue('');
  await expect(page.getByTestId('show-closed')).not.toBeChecked();
  await page.getByTestId('show-closed').check();
  await page.getByTestId('search').fill('-label:Done -status:Done');
  const server = filterResults.find((r) => r.query === '-label:Done -status:Done')!.server;
  const iter = rawIteration();
  const want: Record<string, number> = {};
  for (const k of server) want[iter.get(k)!] = (want[iter.get(k)!] ?? 0) + 1;
  // GitHub#368: with "show hierarchy" on, sub-issues of a matched issue are added under it, faded
  // ("pulled"); what matched is exactly GitHub's own result, and each group's count is the rows it shows
  await expect.poll(() => matchedGroupCounts(page)).toEqual(want);
  const rows = await page.$$eval('[data-testid="row"]:not([data-pulled])', (rs) => rs.map((r) => r.getAttribute('data-key')!));
  expect([...rows].sort()).toEqual(server);
  expect(await groupCounts(page)).toEqual(await shownGroupRows(page));
  await expect(page.getByTestId('filter-unsupported')).toHaveCount(0);
  await shot(page, '10-table-imported');
  // a row's title opens the same detail panel as a card on the board (#138)
  await page.locator(`[data-testid="row"][data-key="${rows[0]}"] [data-testid="row-title"]`).click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', rows[0]);
  await page.getByTestId('detail-close').click();
  await expect(page.getByTestId('detail')).toHaveCount(0);

  // search: GitHub syntax, and Chinese in the middle of a word
  await page.getByTestId('search').fill('label:pending/human');
  await expect.poll(async () => (await page.$$eval('[data-testid="row"]:not([data-pulled])', (rs) => rs.length))).toBe(
    filterResults.find((r) => r.query === 'label:pending/human')!.server.length,
  );
  await page.getByTestId('search').fill('客户端');
  await expect.poll(async () => (await page.$$eval('[data-testid="row"]:not([data-pulled])', (rs) => rs.length))).toBeGreaterThan(
    filterResults.find((r) => r.query === '客户端')!.server.length,
  );

  // words this client does not support: a yellow bar naming them, never "0 results"
  await page.getByTestId('search').fill('label:pending/human updated:>2026-01-01 priority:High');
  await expect(page.getByTestId('filter-unsupported')).toContainText('updated:>2026-01-01');
  await expect(page.getByTestId('filter-unsupported')).toContainText('priority:High');
  await expect.poll(async () => (await page.$$eval('[data-testid="row"]:not([data-pulled])', (rs) => rs.length))).toBe(
    filterResults.find((r) => r.query === 'label:pending/human')!.server.length,
  );
  await shot(page, '11-unsupported-words');
  // a Chinese custom field is named and ignored too, not searched as text
  await page.getByTestId('search').fill('优先级:高 label:pending/human');
  await expect(page.getByTestId('filter-unsupported')).toContainText('优先级:高');
  await expect.poll(async () => (await page.$$eval('[data-testid="row"]:not([data-pulled])', (rs) => rs.length))).toBe(
    filterResults.find((r) => r.query === 'label:pending/human')!.server.length,
  );

  // customise: group by status, repository slices, fewer columns; then restart
  await page.getByTestId('search').fill('');
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('status');
  // the repository slices are on after an import (GitHub's API does not say whether the web view has them)
  await expect(page.getByTestId('slice-by-repo')).toBeChecked();
  // the boxes follow the saved settings (a round trip to the main process), so click and wait
  await page.locator('[data-testid="columns-pick"] input[data-col="labels"]').click();
  await expect(page.locator('[data-testid="columns-pick"] input[data-col="labels"]')).not.toBeChecked();
  await expect(page.getByTestId('slice-count')).toHaveText([String(rawIteration().size)]);
  await page.locator('[data-testid="slice"][data-value="GigleAI/cavil-loop"]').click();
  await expect.poll(() => groupCounts(page)).toEqual(rawCountFollowing('Status', 'name', '无状态'));
  await shot(page, '12-table-custom');
  await page.waitForTimeout(500); // the search box saves 300 ms after typing stops
  await app.close();

  ({ app, page } = await launch(env));
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('search')).toHaveValue('');
  await expect.poll(() => groupCounts(page)).toEqual(rawCountFollowing('Status', 'name', '无状态'));
  await expect(page.getByTestId('slices')).toBeVisible();
  await expect(page.locator('table.items th')).not.toContainText(['标签']);
  await app.close();
});

/** Groups of the table as shown: repository section (from the group key's prefix), title, rows. */
async function tableShape(page: Page) {
  return page.$$eval('[data-testid="group"]', (gs) =>
    gs.map((g) => ({
      key: g.getAttribute('data-key')!,
      title: g.getAttribute('data-title')!,
      rows: [...g.querySelectorAll('[data-testid="row"]')].map((r) => r.getAttribute('data-key')!),
    })),
  );
}
const repoHeads = (page: Page) =>
  page.$$eval('[data-testid="repo-group"]', (rs) => rs.map((r) => [r.getAttribute('data-title'), Number(r.querySelector('[data-testid="repo-count"]')!.textContent)] as [string, number]));

test('GitHub#213: "all repositories" in the table — repository first, then iteration; counts are distinct items; folding is per repository; picking one repository goes back to one level', async () => {
  // a second Project holding cavil-loop#22 in Iteration 25 (Project 11 has it without an iteration):
  // the item then shows in two iteration groups of the same repository
  const [p11] = loadCavilProjectPages();
  const node = p11.items.nodes.find((n: any) => n.content.number === 22 && n.content.__typename === 'Issue');
  const it25 = (p11.fields.nodes.find((f: any) => f.name === 'Iteration') as any).configuration.iterations[0];
  env.fake.state.projects.set('org/gigleai/24', [
    {
      ...p11,
      id: 'PVT_fixture_issue213',
      title: 'second board',
      url: 'https://github.com/orgs/GigleAI/projects/24',
      views: { nodes: [] },
      items: {
        totalCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ ...node, id: 'PVTI_fixture_issue213', fieldValues: { nodes: [...node.fieldValues.nodes, { __typename: 'ProjectV2ItemFieldIterationValue', iterationId: it25.id, title: it25.title, startDate: it25.startDate, duration: it25.duration, field: { id: 'PVTF_fixture_c418626aa793', name: 'Iteration' } }] } }],
      },
    },
  ]);
  // a second repository with two open issues, no Project, so both are "no iteration"
  const zeta = (n: number) => ({ number: n, node_id: `I_fixture_zeta${n}`, title: `zeta issue ${n}`, state: 'open', html_url: `https://github.com/GigleAI/zeta/issues/${n}`, updated_at: '2026-11-04T00:00:00Z', labels: [], assignees: [], milestone: null, user: { login: 'user-1' }, parent_issue_url: null, sub_issues_summary: null });
  env.fake.state.repos.set('gigleai/zeta', [zeta(1), zeta(2)]);

  const { app, page } = await launch(env);
  await signIn(page);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(`${PROJECT_URL}/views/1`); // a table grouped by iteration
  await page.getByTestId('source-add').click();
  // the view's filter (-label:Done -status:Done) only hid finished items: left to the switch (GitHub#464)
  await expect.poll(() => importedView(page), { timeout: 15_000 }).toBe(1);
  expect(await savedQuery(page)).toBe('');
  await page.getByTestId('source-input').fill('https://github.com/orgs/GigleAI/projects/24');
  await page.getByTestId('source-add').click();
  await page.getByTestId('source-input').fill('GigleAI/zeta');
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('search').fill('');
  await expect(page.locator('[data-testid="slice"][data-value=""]')).toHaveClass(/on/);

  // repository first, alphabetical; zeta has only its own "no iteration" group
  const C = 'repo:gigleai/cavil-loop', Z = 'repo:gigleai/zeta';
  await expect.poll(async () => (await repoHeads(page)).map(([t]) => t), { timeout: 15_000 }).toEqual(['GigleAI/cavil-loop', 'GigleAI/zeta']);
  await expect.poll(async () => (await tableShape(page)).some((g) => g.title === 'Iteration 25' && g.rows.includes('gigleai/cavil-loop#22'))).toBe(true);
  const shape = await tableShape(page);
  for (const g of shape) expect(g.key.startsWith(`${C}|`) || g.key.startsWith(`${Z}|`), g.key).toBe(true);
  // the sections come in the heading order: every cavil-loop group before every zeta group
  expect(shape.map((g) => g.key.startsWith(`${Z}|`))).toEqual([...shape.map((g) => g.key.startsWith(`${Z}|`))].sort());
  expect(shape.filter((g) => g.key.startsWith(`${Z}|`)).map((g) => [g.title, [...g.rows].sort()])).toEqual([['无迭代', ['gigleai/zeta#1', 'gigleai/zeta#2']]]);
  // cavil-loop#22 shows in two iteration groups, and the heading counts it once
  const cav = shape.filter((g) => g.key.startsWith(`${C}|`));
  // the "no iteration" group comes last, as on the web (GitHub#231)
  expect(cav.filter((g) => g.rows.includes('gigleai/cavil-loop#22')).map((g) => g.title)).toEqual(['Iteration 25', '无迭代']);
  const cavRows = cav.flatMap((g) => g.rows);
  const heads = Object.fromEntries(await repoHeads(page));
  expect(heads['GigleAI/cavil-loop']).toBe(new Set(cavRows).size);
  // two rows counted once each: #22 itself, and PR #23 that follows #22 into both of its groups (GitHub#275)
  expect(heads['GigleAI/cavil-loop']).toBe(cavRows.length - 2);
  expect(heads['GigleAI/zeta']).toBe(2);
  await shot(page, '213-table-by-repository');

  // folding "no iteration" in zeta leaves cavil-loop's group of the same name open
  const group = (key: string) => page.locator(`[data-testid="group"][data-key="${key}"]`);
  await group(`${Z}|none`).getByTestId('group-toggle').click();
  await expect(group(`${Z}|none`).getByTestId('row')).toHaveCount(0);
  await expect(group(`${C}|none`).getByTestId('row')).toHaveCount(cav.find((g) => g.key === `${C}|none`)!.rows.length);
  await group(`${Z}|none`).getByTestId('group-toggle').click();
  // folding the whole cavil-loop section hides all its groups; zeta stays
  await page.locator(`[data-testid="repo-group"][data-key="${C}"]`).getByTestId('repo-toggle').click();
  await expect(page.locator(`[data-testid="group"][data-key^="${C}|"]`)).toHaveCount(0);
  await expect(group(`${Z}|none`).getByTestId('row')).toHaveCount(2);
  await expect(page.locator(`[data-testid="repo-group"][data-key="${C}"]`)).toBeVisible();
  await page.locator(`[data-testid="repo-group"][data-key="${C}"]`).getByTestId('repo-toggle').click();
  await expect(page.locator(`[data-testid="group"][data-key^="${C}|"]`)).toHaveCount(cav.length);

  // picking one repository: one level again, no repository heading
  await page.locator('[data-testid="slice"][data-value="GigleAI/zeta"]').click();
  await expect(page.getByTestId('repo-group')).toHaveCount(0);
  await expect.poll(async () => (await tableShape(page)).map((g) => ({ ...g, rows: [...g.rows].sort() }))).toEqual([{ key: 'none', title: '无迭代', rows: ['gigleai/zeta#1', 'gigleai/zeta#2'] }]);
  await app.close();
});

test('a saved board view sorted by update time: the board shows each column newest first', async () => {
  const { app, page } = await launch(env);
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(`${PROJECT_URL}/views/2`);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();

  await expect(page.getByTestId('search')).toHaveValue('-label:nightly-failure', { timeout: 15_000 });
  // the Done column holds closed items: show them (GitHub#464)
  await showClosedEverywhere(page);
  await expect(page.locator('[data-testid="column"][data-title="Done"]')).toBeVisible();
  const updated = new Map<string, string>();
  for (const p of loadCavilProjectPages())
    for (const n of p.items.nodes) updated.set(`${n.content.repository.nameWithOwner.toLowerCase()}#${n.content.number}`, n.content.updatedAt);
  const cards = () =>
    page.$$eval('[data-testid="column"][data-title="Done"] [data-testid="card"]', (cs) => cs.map((c) => [c.getAttribute('data-key')!, c.getAttribute('data-under')] as const));
  // PRs go right under their issue (#155): an issue and the PRs under it move as one,
  // placed by the latest update among them — those units are newest first
  const nested = await cards();
  expect(nested.length).toBeGreaterThan(10);
  const units: string[] = [];
  for (const [k, under] of nested) {
    const t = updated.get(k)!;
    if (under === null) units.push(t);
    else units[units.length - 1] = t > units[units.length - 1] ? t : units[units.length - 1];
  }
  expect(units).toEqual([...units].sort().reverse());
  await shot(page, '13-board-imported-sort');
  // with "PRs under their issue" off: every card newest first by its own update
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('prs-under-issues').uncheck();
  await expect(page.locator('[data-testid="card"][data-under]')).toHaveCount(0);
  const order = (await cards()).map(([k]) => k);
  const ts = order.map((k) => updated.get(k)!);
  expect(ts).toEqual([...ts].sort().reverse());
  await app.close();
});

// ---- GitHub#155: avatars, folded discussion, floating detail, PRs under their issue ----

/** per column: [item key, key of the issue it is shown under] of every card, top to bottom */
const cardsByColumn = (page: Page) =>
  page.$$eval('[data-testid="column"]', (cs) =>
    cs.map((c) => [...c.querySelectorAll('[data-testid="card"]')].map((x) => [x.getAttribute('data-key')!, x.getAttribute('data-under')] as [string, string | null])),
  );

test('GitHub#155: avatars; the detail floats over the board, keeps its dragged width; only the newest entry unfolded; PRs under their issue', async () => {
  const author138 = loadCavilProjectPages().flatMap((p: any) => p.items.nodes).find((n: any) => n.content?.number === 138)!.content.author.login as string;
  env.fake.state.w.comments.set('gigleai/cavil-loop#138', [
    { id: 'C1', url: 'https://github.com/GigleAI/cavil-loop/issues/138#c1', createdAt: '2026-11-01T01:00:00Z', bodyHTML: '<p>FIRST comment</p>', author: { login: 'user-2' } },
    { id: 'C2', url: 'https://github.com/GigleAI/cavil-loop/issues/138#c2', createdAt: '2026-11-02T01:00:00Z', bodyHTML: '<p>SECOND comment</p>', author: { login: 'user-3' } },
    { id: 'C3', url: 'https://github.com/GigleAI/cavil-loop/issues/138#c3', createdAt: '2026-11-03T01:00:00Z', bodyHTML: '<p>NEWEST comment</p>', author: { login: 'user-4' } },
  ]);
  let { app, page } = await launch(env);
  // the avatar of #138's author does not load: its first letter stands in (the bridge's route still records it)
  const broken = (u: URL) => u.href.startsWith(`https://avatars.githubusercontent.com/${author138}?`);
  await page.context().route(broken, (r) => {
    appendFileSync(env.requests, `request ${r.request().url()}\n`);
    return r.abort();
  });
  await signInWithSources(page);

  // ---- 1. avatars on the cards, from the avatar host only ----
  await expect(card(page, 138).locator('[data-testid="card-author"] [data-testid="avatar"]')).toHaveAttribute('data-fallback', 'yes');
  await expect(card(page, 138).locator('[data-testid="card-author"] [data-testid="avatar"]')).toHaveText(author138.charAt(0).toUpperCase());
  const loaded = page.locator('[data-testid="card-author"] img[data-testid="avatar"][data-fallback="no"]');
  await expect.poll(() => loaded.count()).toBeGreaterThan(0);
  expect(await loaded.first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect.poll(() => (existsSync(env.requests) ? readFileSync(env.requests, 'utf8') : '')).toMatch(/request https:\/\/avatars\.githubusercontent\.com\/[^?]+\?s=40\n/);

  // ---- 2. the detail floats over the board, stuck to the right; the board keeps its width ----
  const boardBefore = await page.locator('.board').boundingBox();
  await card(page, 138).click();
  const detail = page.getByTestId('detail');
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#138');
  await expect(detail).toHaveAttribute('data-width', '560');
  expect(await page.locator('.board').boundingBox()).toEqual(boardBefore);
  let box = (await detail.boundingBox())!;
  expect(Math.round(box.x + box.width)).toBe(1280);
  expect(Math.round(box.width)).toBe(560);
  await expect(detail.getByTestId('detail-people').locator('[data-testid="avatar"]').first()).toHaveAttribute('data-login', author138);

  // ---- 3. only the newest entry is unfolded; a folded one opens on a click; unfold all / fold all ----
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  const folds = () => frame.locator('details.entry').evaluateAll((els) => els.map((e) => [e.getAttribute('data-entry'), (e as HTMLDetailsElement).open]));
  await expect.poll(folds).toEqual([
    ['C3', true],
    ['C2', false],
    ['C1', false],
    [expect.stringMatching(/^I_/), false],
  ]);
  await expect(frame.locator('details.entry[data-entry="C2"] > summary')).toContainText('SECOND comment');
  await expect(frame.locator('details.entry[data-entry="C2"] .md')).toBeHidden();
  await expect(frame.locator('details.entry[data-entry="C3"] .md')).toBeVisible();
  await shot(page, '40-detail-folded');
  // (near the start of the line, on the folded head itself)
  await frame.locator('details.entry[data-entry="C1"] > summary').click({ position: { x: 40, y: 10 } });
  await expect(frame.locator('details.entry[data-entry="C1"] .md')).toBeVisible();
  // the keyboard is now inside the isolated discussion: Esc stays there and does not close the panel
  // (PR #171: kept isolated by the maintainer's choice); a click on the panel outside it gives it back
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#138');
  await detail.locator('.detail-title').click();
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await card(page, 138).click();
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#138');
  await expect.poll(async () => (await folds())[0]).toEqual(['C3', true]);
  await page.getByTestId('unfold-toggle').click();
  await expect.poll(async () => (await folds()).every(([, open]) => open)).toBe(true);
  await page.getByTestId('unfold-toggle').click();
  await expect.poll(async () => (await folds()).every(([, open]) => !open)).toBe(true);
  // the people in the discussion have avatars too
  await expect.poll(() => readFileSync(env.requests, 'utf8')).toContain('request https://avatars.githubusercontent.com/user-4?s=40\n');

  // ---- 4. drag the left edge: wider; the board still does not move; the width is kept ----
  const h = (await page.getByTestId('detail-resize').boundingBox())!;
  const x0 = h.x + h.width / 2;
  await page.mouse.move(x0, h.y + 200);
  await page.mouse.down();
  await page.mouse.move(x0 - 100, h.y + 200, { steps: 4 });
  await page.mouse.move(x0 - 200, h.y + 200, { steps: 4 });
  await page.mouse.up();
  // 200px wider, give or take the sub-pixel position of the edge
  await expect.poll(async () => Math.abs(Number(await detail.getAttribute('data-width')) - 760)).toBeLessThanOrEqual(2);
  const dragged = (await detail.getAttribute('data-width'))!;
  expect(await page.locator('.board').boundingBox()).toEqual(boardBefore);
  await shot(page, '41-detail-wider');
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await card(page, 137).click();
  await expect(detail).toHaveAttribute('data-width', dragged);
  // a narrow window leaves a strip of the board uncovered; the kept width comes back when it is wide again
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(detail).toHaveAttribute('data-width', '680');
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(detail).toHaveAttribute('data-width', dragged);
  // Esc while typing a reply does not close the panel (and so does not drop the draft)
  await detail.getByTestId('reply-input').fill('草稿');
  await detail.getByTestId('reply-input').press('Escape');
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  await app.close();

  // a restart: the same width
  ({ app, page } = await launch(env));
  await expect(card(page, 138)).toBeVisible({ timeout: 15_000 });
  await card(page, 138).click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-width', dragged);
  // a card under the panel can still be reached: the board scrolls it out from under the panel
  const covered = page.locator('[data-testid="column"] [data-testid="card"]').last();
  await covered.click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', (await covered.getAttribute('data-key'))!);
  await page.getByTestId('detail-close').click();

  // ---- 5. PRs right under the issue they are linked to (columns by status: the recorded pairs share one) ----
  await page.getByTestId('mode').selectOption('status');
  const cols = await cardsByColumn(page);
  let pairs = 0;
  for (const col of cols) {
    col.forEach(([key, under], i) => {
      if (!under) return;
      pairs++;
      const at = col.findIndex(([k]) => k === under);
      expect(at, `${key} under ${under}`).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(i);
      expect(col.slice(at + 1, i).every(([, u]) => u === under), `${key} right under ${under}`).toBe(true);
    });
  }
  expect(pairs).toBeGreaterThan(0);
  const nestedCard = page.locator('[data-testid="card"][data-under]').first();
  const hostKey = (await nestedCard.getAttribute('data-under'))!;
  const nb = (await nestedCard.boundingBox())!;
  const hb = (await page.locator(`[data-testid="card"][data-key="${hostKey}"]`).first().boundingBox())!;
  expect(nb.x).toBeGreaterThan(hb.x);
  await nestedCard.scrollIntoViewIfNeeded();
  await shot(page, '42-pr-under-issue');
  // the table grouped the same way: the same pair, the PR right under its issue, one level deeper
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('status');
  const rows = await page.$$eval('[data-testid="row"]', (rs) => rs.map((r) => [r.getAttribute('data-key'), r.getAttribute('data-under'), Number(r.getAttribute('data-depth'))] as const));
  const pr = rows.findIndex(([, u]) => u === hostKey);
  expect(pr).toBeGreaterThan(0);
  const host = rows.findIndex(([k]) => k === hostKey);
  expect(host).toBeLessThan(pr);
  expect(rows.slice(host + 1, pr).every(([, u]) => u === hostKey)).toBe(true);
  expect(rows[pr][2]).toBe(rows[host][2] + 1);
  // switched off: nothing nested anywhere
  await page.getByTestId('prs-under-issues').uncheck();
  await expect(page.locator('[data-testid="row"][data-under]')).toHaveCount(0);
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await expect(page.locator('[data-testid="card"][data-under]')).toHaveCount(0);
  await app.close();
});

// ---- yellow bars can be closed with "×" (GitHub#153) ----

async function signIn(page: Page) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await showClosedEverywhere(page);
}

/** the saved search text as the main process holds it (the box saves 300 ms after typing stops) */
const savedQuery = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).state.view.query as string);
/** which saved web view was imported (null = none yet) — the import's own mark, since GitHub#464 leaves its filter out of the box */
const importedView = (page: Page) => page.evaluate(async () => ((await (window as any).cavil.get()).state.view.imported?.viewNumber ?? null) as number | null);

/** a copy of the recorded Project whose only saved web view uses `filter` */
function projectWithView(filter: string) {
  return loadCavilProjectPages().map((p: any) => ({ ...p, views: { nodes: [{ ...p.views.nodes[1], number: 1, filter }] } }));
}

const P11 = 'org/gigleai/11';
const sourceErr = (page: Page, key: string) => page.locator(`[data-testid="source-row"][data-key="${key}"] .err`);

/** the main process's sync state (to wait for a round's outcome without a bar on screen) */
const syncOf = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).state.sync as { syncing: boolean; offline: boolean });
const UNSUPPORTED = 'updated:>2026-01-01';

test('yellow bars: × closes one bar; time passing and page switches keep it closed; recovery, or a new filter shows it again', async () => {
  const { app, page } = await launch(env);
  // fake time in the window: "1 hour later" without waiting an hour
  await page.clock.install();
  await page.reload();
  await page.waitForSelector('[data-testid="app-root"]');
  await signIn(page);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(PROJECT_URL);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect.poll(() => importedView(page), { timeout: 15_000 }).toBe(1);
  // GitHub#464: the import leaves the view's filter (it only hid finished items) out of the box; write it back to search
  await page.getByTestId('search').fill('-label:Done -status:Done');

  // offline with an unsupported word in the box: two bars; × closes only the one clicked
  await page.getByTestId('search').fill(`-label:Done ${UNSUPPORTED}`);
  await expect(page.getByTestId('filter-unsupported')).toBeVisible();
  env.fake.state.offline = true;
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('offline-close')).toHaveAccessibleName('关闭提示');
  await shot(page, '14-bars-with-close');
  await page.getByTestId('offline-close').click();
  await expect(page.getByTestId('offline')).toHaveCount(0);
  await expect(page.getByTestId('filter-unsupported')).toBeVisible();

  // only time passes: the wording ("… 分钟前") changes, the problem does not → stays closed
  for (const step of ['00:15', '01:00', '59:00']) { // 15 s, 1 min, then past 1 h in all
    await page.clock.fastForward(step);
    await page.waitForTimeout(100);
  }
  await expect(page.getByTestId('sync-status')).toContainText('上次检查 1 小时前'); // the window's clock really moved
  await expect(page.getByTestId('offline')).toHaveCount(0);
  await expect(page.getByTestId('filter-unsupported')).toBeVisible();

  // board → settings → board: stays closed
  await page.getByTestId('open-settings').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('filter-unsupported')).toBeVisible();
  await expect(page.getByTestId('offline')).toHaveCount(0);

  // "unsupported words": closed → filter cleared (the bar is gone, so is the record) → same words again → back
  await page.getByTestId('filter-unsupported-close').click();
  await expect(page.getByTestId('filter-unsupported')).toHaveCount(0);
  await page.getByTestId('search').fill('');
  await page.getByTestId('search').fill(`-label:Done ${UNSUPPORTED}`);
  await expect(page.getByTestId('filter-unsupported')).toBeVisible();
  await expect(page.getByTestId('offline')).toHaveCount(0);

  // recovers, then goes offline again → shows again
  env.fake.state.offline = false;
  await page.getByTestId('refresh').click();
  await expect.poll(async () => (await syncOf(page)).offline, { timeout: 15_000 }).toBe(false); // the round really recovered
  env.fake.state.offline = true;
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });

  // closed, then recovers and goes offline again while the settings page is up → shows again back on the board
  await page.getByTestId('offline-close').click();
  await expect(page.getByTestId('offline')).toHaveCount(0);
  await page.getByTestId('open-settings').click();
  env.fake.state.offline = false;
  await page.evaluate(() => (window as any).cavil.restartSync());
  await expect.poll(async () => (await syncOf(page)).offline, { timeout: 15_000 }).toBe(false);
  env.fake.state.offline = true;
  await page.evaluate(() => (window as any).cavil.restartSync());
  await expect.poll(async () => (await syncOf(page)).offline, { timeout: 15_000 }).toBe(true);
  await page.getByTestId('back').click();
  await expect(page.getByTestId('offline')).toBeVisible();
  await shot(page, '15-bar-back-after-recovery');
  env.fake.state.offline = false;
  await app.close();
});

test('sync trouble: ⚠️ next to refresh instead of two bars; a click shows the details; click again, outside or Esc puts them away; offline and recovery (GitHub#248)', async () => {
  const { app, page } = await launch(env);
  await signIn(page);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(PROJECT_URL);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect.poll(() => importedView(page), { timeout: 15_000 }).toBe(1);
  // GitHub#464: the import leaves the view's filter (it only hid finished items) out of the box; write it back to search
  await page.getByTestId('search').fill('-label:Done -status:Done');
  await expect(page.getByTestId('sync-trouble')).toHaveCount(0);

  // a source fails while filtering: no full-width bar, a ⚠️ left of refresh, not opened by itself
  env.fake.state.failProjectPage.set(P11, 1);
  await page.getByTestId('refresh').click();
  const btn = page.getByTestId('sync-trouble');
  await expect(btn).toBeVisible({ timeout: 15_000 });
  await expect(btn).toHaveAccessibleName('同步不完整：1 个来源读取失败（点开看详情）');
  await expect(page.getByTestId('sync-trouble-panel')).toHaveCount(0);
  await expect(page.locator('.banner')).toHaveCount(0);
  const order = await page.locator('.hdr-right > *').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? e.querySelector('[data-testid]')?.getAttribute('data-testid')));
  expect(order.indexOf('sync-trouble')).toBe(order.indexOf('refresh') - 1);

  // click → details: the source, its reason, how old its data is, plus the filter line
  await btn.click();
  const panel = page.getByTestId('sync-trouble-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('sync-trouble-source')).toHaveCount(1);
  await expect(page.getByTestId('sync-trouble-source')).toContainText(/读取失败（.+），显示的是 .+前的数据/);
  await expect(page.getByTestId('sync-trouble-filter')).toContainText('筛选结果可能不全');
  await shot(page, '16-sync-trouble-open');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, '16-sync-trouble-open-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  // a narrow window hides the "上次检查" text; the ⚠️ and its details stay on screen
  const size = page.viewportSize();
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(btn).toBeInViewport({ ratio: 1 });
  await expect(panel).toBeInViewport({ ratio: 1 });
  await shot(page, '16-sync-trouble-open-narrow');
  if (size) await page.setViewportSize(size);
  // click again → away
  await btn.click();
  await expect(panel).toHaveCount(0);
  // click outside → away
  await btn.click();
  await expect(panel).toBeVisible();
  // an empty spot of the view bar (GitHub#404: its right end is the flow numbers, buttons that change the search)
  const vs = (await page.getByTestId('open-view-panel').boundingBox())!;
  await page.mouse.click(vs.x + vs.width + 40, vs.y + vs.height / 2);
  await expect(page.getByTestId('search')).toHaveValue('-label:Done -status:Done');
  await expect(panel).toHaveCount(0);
  // Esc → away
  await btn.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // no filter: the filter line goes, the source list stays (open while it changes)
  await btn.click();
  await page.getByTestId('search').fill('');
  await expect(page.getByTestId('sync-trouble-filter')).toHaveCount(0);
  await expect(page.getByTestId('sync-trouble-source')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // offline, not filtering: no ⚠️ (the offline bar says it); offline and filtering: ⚠️ with the filter line only
  env.fake.state.offline = true;
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(btn).toHaveCount(0);
  await page.getByTestId('search').fill('label:x');
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.getByTestId('sync-trouble-filter')).toBeVisible();
  await expect(page.getByTestId('sync-trouble-incomplete')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // back online, still failing: both parts; then it recovers with the details open → ⚠️ and details go together
  env.fake.state.offline = false;
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('offline')).toHaveCount(0, { timeout: 15_000 });
  await btn.click();
  await expect(page.getByTestId('sync-trouble-source')).toHaveCount(1);
  env.fake.state.failProjectPage.clear();
  await page.getByTestId('sync-trouble-resync').click();
  await expect(btn).toHaveCount(0, { timeout: 15_000 });
  await expect(panel).toHaveCount(0);

  // fails again: the ⚠️ comes back closed
  env.fake.state.failProjectPage.set(P11, 1);
  await page.getByTestId('refresh').click();
  await expect(btn).toBeVisible({ timeout: 15_000 });
  await expect(panel).toHaveCount(0);
  env.fake.state.failProjectPage.clear();
  await app.close();
});

test('sync trouble: "重新读取" / "重新同步" spin while the reread runs, then say what came of it; all read → a short green note (GitHub#455)', async () => {
  const { app, page } = await launch(env);
  await signIn(page);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(PROJECT_URL);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect.poll(() => importedView(page), { timeout: 15_000 }).toBe(1);
  // GitHub#464: the import leaves the view's filter (it only hid finished items) out of the box; write it back to search
  await page.getByTestId('search').fill('-label:Done -status:Done');
  env.fake.state.failProjectPage.set(P11, 1);
  await page.getByTestId('refresh').click();
  const btn = page.getByTestId('sync-trouble');
  await expect(btn).toBeVisible({ timeout: 15_000 });
  await btn.click();
  const panel = page.getByTestId('sync-trouble-panel');
  const retry = panel.getByTestId('failure-retry');
  const resync = page.getByTestId('sync-trouble-resync');
  const running = page.getByTestId('sync-trouble-running');
  const result = page.getByTestId('sync-trouble-result');
  await expect(retry).toHaveText('重新读取');
  await expect(running).toHaveCount(0);
  await expect(result).toHaveCount(0);
  const reads = () => env.fake.log.filter((e) => e.operation === 'CavilProjectItems').length;

  // 1. held at GitHub: both buttons say they are reading, at once, and stay clickable
  let release = env.fake.holdWhen((e) => e.operation === 'CavilProjectItems');
  let n = reads();
  await retry.click();
  await expect(retry).toHaveText('正在重新读取…');
  await expect(retry).toHaveAttribute('data-running', 'yes');
  await expect(retry).toBeEnabled();
  await expect(resync).toHaveText('正在重新同步…');
  await expect(resync).toBeEnabled();
  await expect(running).toContainText(/^\d\d:\d\d:\d\d 开始重新读取，连不上时每个请求最多等 30 秒。再点一次会放弃这一轮、重新开始。$/);
  await expect.poll(reads).toBeGreaterThan(n);
  await shot(page, '455-reread-running');

  // 2. answered, still failing: the outcome, to the second; the buttons are back
  release();
  await expect(result).toContainText(/^\d\d:\d\d:\d\d 重新读取完毕：这个来源仍然读取失败（原因见上）。$/, { timeout: 15_000 });
  await expect(result).toHaveAttribute('data-kind', 'failed');
  await expect(running).toHaveCount(0);
  await expect(retry).toHaveText('重新读取');
  await expect(resync).toHaveText('重新同步');
  await expect(panel).toBeVisible();
  await shot(page, '455-reread-still-failing');

  // 3. clicked again while it reads: the round starts over, one outcome only (the last click's), and it really read again
  release = env.fake.holdWhen((e) => e.operation === 'CavilProjectItems');
  n = reads();
  await resync.click();
  await expect(result).toHaveCount(0);
  await expect(running).toBeVisible();
  await expect.poll(reads).toBeGreaterThan(n);
  const second = reads();
  await resync.click();
  await expect(running).toBeVisible();
  release();
  await expect(result).toHaveCount(1, { timeout: 15_000 });
  await expect(result).toContainText('这个来源仍然读取失败');
  expect(reads()).toBeGreaterThan(second);
  await expect(running).toHaveCount(0);

  // 4. the panel put away and opened again: the old outcome is gone
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await btn.click();
  await expect(result).toHaveCount(0);

  // 5. the source reads again: ⚠️ and panel go, a green note says so for about 5 seconds
  env.fake.state.failProjectPage.clear();
  await resync.click();
  await expect(btn).toHaveCount(0, { timeout: 15_000 });
  const ok = page.getByTestId('sync-reread-ok');
  await expect(ok).toHaveText('已重新读取，所有来源都读到了');
  await shot(page, '455-reread-ok');
  await expect(ok).toHaveCount(0, { timeout: 10_000 });

  // 6. recovered by the refresh button (not from the panel): no green note
  env.fake.state.failProjectPage.set(P11, 1);
  await page.getByTestId('refresh').click();
  await expect(btn).toBeVisible({ timeout: 15_000 });
  env.fake.state.failProjectPage.clear();
  await page.getByTestId('refresh').click();
  await expect(btn).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(500);
  await expect(ok).toHaveCount(0);

  await app.close();
});

test('Settings: a failed source\'s "重新读取" spins while it runs and says what came of it, on its own (GitHub#455)', async () => {
  const { app, page } = await launch(env);
  await signIn(page);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(PROJECT_URL);
  await page.getByTestId('source-add').click();
  const row = page.getByTestId('source-row');
  await expect(row.locator('.kind')).not.toContainText(' 0 个条目', { timeout: 15_000 });
  env.fake.state.failProjectPage.set(P11, 1);
  await page.evaluate(() => (window as any).cavil.restartSync());
  const rowRetry = row.getByTestId('failure-retry');
  await expect(rowRetry).toHaveText('重新读取', { timeout: 15_000 });
  const release = env.fake.holdWhen((e) => e.operation === 'CavilProjectItems');
  await rowRetry.click();
  await expect(rowRetry).toHaveText('正在重新读取…');
  await expect(row.getByTestId('failure-reread-running')).toContainText('开始重新读取');
  release();
  await expect(row.getByTestId('failure-reread-result')).toContainText('重新读取完毕：这个来源仍然读取失败', { timeout: 15_000 });
  await expect(rowRetry).toHaveText('重新读取');
  env.fake.state.failProjectPage.clear();
  await rowRetry.click();
  await expect(row.getByTestId('source-failure')).toHaveCount(0, { timeout: 15_000 });
  await app.close();
});

test('yellow bars: a closed "unsupported words" bar comes back when an import in settings changes the filter and changes it back', async () => {
  env.fake.state.projects.set('org/gigleai/21', projectWithView('updated:>2026-01-01'));
  env.fake.state.projects.set('org/gigleai/22', projectWithView('label:bug')); // (a filter that only hides Done would be left out, GitHub#464)
  env.fake.state.projects.set('org/gigleai/23', projectWithView('updated:>2026-01-01'));
  const { app, page } = await launch(env);
  await signIn(page);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill('https://github.com/orgs/GigleAI/projects/21');
  await page.getByTestId('source-add').click();
  await expect.poll(() => savedQuery(page), { timeout: 15_000 }).toBe('updated:>2026-01-01');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('filter-unsupported')).toContainText('updated:>2026-01-01');
  await page.getByTestId('filter-unsupported-close').click();
  await expect(page.getByTestId('filter-unsupported')).toHaveCount(0);

  // only switching pages, filter unchanged → stays closed
  await page.getByTestId('open-settings').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('search')).toHaveValue('updated:>2026-01-01');
  await expect(page.getByTestId('filter-unsupported')).toHaveCount(0);

  // in settings: a Project whose view has a supported filter, then one with the old unsupported words
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill('https://github.com/orgs/GigleAI/projects/22');
  await page.getByTestId('source-add').click();
  await expect.poll(() => savedQuery(page), { timeout: 15_000 }).toBe('label:bug');
  await page.getByTestId('source-input').fill('https://github.com/orgs/GigleAI/projects/23');
  await page.getByTestId('source-add').click();
  await expect.poll(() => savedQuery(page), { timeout: 15_000 }).toBe('updated:>2026-01-01');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('search')).toHaveValue('updated:>2026-01-01');
  await expect(page.getByTestId('filter-unsupported')).toBeVisible();
  await app.close();
});

// GitHub#151 review: the app's logic now runs in the system WebKit, the oldest supported being
// macOS 11's (Safari 14). The window's code must not need what that engine lacks.
test('on an engine without the newer web APIs (macOS 11 / Safari 14): sign in, sync, detail, a change all work', async () => {
  const app = await launchApp(env, { oldEngine: true });
  const page = app.page;
  // "something did happen": the APIs really are gone in this window
  const removed = (await page.evaluate(() => (globalThis as any).__removedApis)) as string[];
  expect(removed).toEqual(expect.arrayContaining(['AbortSignal.timeout', 'Array.prototype.at', 'structuredClone', 'Object.hasOwn']));
  expect(await page.evaluate(() => typeof (AbortSignal as any).timeout)).toBe('undefined');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signInWithSources(page);
  // the round really reached GitHub through the back end
  expect(env.fake.log.some((l) => l.path === '/api/graphql' && l.auth)).toBe(true);
  await card(page, 138).click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', 'gigleai/cavil-loop#138');
  await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
  await pickLabel(page, 'Done');
  await expect.poll(() => env.fake.log.some((l) => l.method === 'POST' && l.path.endsWith('/issues/138/labels'))).toBe(true);
  await expect(card(page, 138).locator('.label', { hasText: 'Done' })).toBeVisible();
  await expect(page.locator('[data-testid="sync-problem"]')).toHaveCount(0);
  expect(errors).toEqual([]);
  await shot(page, '40-old-engine');
  await app.close();
});

// ---- "待处理" reminders (GitHub#139, rebuilt on Tauri in #169) ---------------------------

async function signInForReminders(page: Page, sources: string[]) {
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await showClosedEverywhere(page);
  await page.getByTestId('open-settings').click();
  for (const s of sources) {
    await page.getByTestId('source-input').fill(s);
    await page.getByTestId('source-add').click();
  }
}

/** Put `pending/human` on an item on the fake GitHub (every copy: Project pages and the repository list). */
function putPending(n: number) {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const c = findCopies(store, 'GigleAI/cavil-loop', n)!;
  const now = new Date().toISOString();
  for (const g of c.gql) if (!g.labels.nodes.some((l: any) => l.name === 'pending/human')) (g.labels.nodes.push({ name: 'pending/human', color: 'ededed' }), (g.updatedAt = now));
  for (const r of c.rest) if (!r.labels.some((l: any) => (l.name ?? l) === 'pending/human')) (r.labels.push({ name: 'pending/human', color: 'ededed' }), (r.updated_at = now));
}

/** Open issues of the repository without the label, from the recording as the fake serves it now. */
function openUnlabelled(): number[] {
  return env.fake.state.repos
    .get('gigleai/cavil-loop')!
    .filter((i: any) => i.state === 'open' && !i.pull_request && !i.labels.some((l: any) => (l.name ?? l) === 'pending/human'))
    .map((i: any) => i.number);
}

// GitHub#251: the badge is only the unread count; what the sources already have at start is
// history (no summary, no notification, not unread); the settings page no longer lists or counts
// what is pending. GitHub#462: closed / merged items carrying the label remind too.
test('pending/human: nothing about the history at start, one notification per new label at the next beat (a merged PR too), badge, label setting, a click opens the item', async () => {
  // history: the recording's labelled items are closed / merged; one open issue carries the label too
  const [seeded, fresh] = openUnlabelled();
  putPending(seeded);
  const { app, page } = await launch(env);
  await signInForReminders(page, [PROJECT_URL, 'GigleAI/cavil-loop']);

  const historyInRecording = loadCavilProjectPages()
    .flatMap((pg) => pg.items.nodes)
    .filter((n: any) => !n.isArchived && n.content?.state !== 'OPEN' && n.content?.labels?.nodes.some((l: any) => l.name === 'pending/human'));
  expect(historyInRecording.length).toBeGreaterThan(0);
  // a merged PR without the label, only on the board
  const mergedPr = loadCavilProjectPages()
    .flatMap((pg) => pg.items.nodes)
    .find((n: any) => n.content?.__typename === 'PullRequest' && n.content.merged && !n.content.labels.nodes.some((l: any) => l.name === 'pending/human'))!.content.number;
  const notes = () => app.desktop.records.filter((a) => a.op === 'notify').map((a) => a.alert);
  const badge = () => app.desktop.records.filter((a) => a.op === 'badge').pop()?.count;
  // "did happen": both sources' first complete read is on the board, history and the seeded item included
  await page.getByTestId('back').click();
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await page.getByTestId('search').fill(`#${seeded}`);
  await expect(card(page, seeded)).toBeVisible({ timeout: 15_000 });
  await expect(card(page, seeded).locator('.label', { hasText: 'pending/human' })).toBeVisible();
  await expect.poll(() => env.fake.log.filter((l) => l.path.includes('/repos/GigleAI/cavil-loop/issues?') && l.status === 200).length).toBeGreaterThanOrEqual(2);
  await expect.poll(() => app.desktop.records.filter((a) => a.op === 'badge').length).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  // no start-up summary, nothing per item, the badge is 0
  expect(notes()).toEqual([]);
  expect(badge()).toBe(0);

  // the settings page: how reminders work, no list, no counts
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('pending-how-to-clear')).toContainText('「未读数」');
  await expect(page.getByTestId('pending-how-to-clear')).toContainText('切到 App 就清零');
  // GitHub#369: the back button names its key
  await expect(page.getByTestId('back-key')).toHaveText('Esc');
  // GitHub#369: switching to the app keeps the notifications; a click takes back only that one; the box is off
  await expect(page.getByTestId('clear-all-on-activate')).not.toBeChecked();
  await expect(page.getByTestId('notification-keep-rule')).toHaveText('系统通知不会因为切到 App 而收起：点哪条通知，就只收起被点的那一条，其余留在通知中心。');
  await page.getByTestId('pending-settings').scrollIntoViewIfNeeded();
  await shot(page, '20b-pending-settings-unticked');
  await expect(page.getByTestId('pending-settings')).toContainText('已关闭、已合并的也提醒');
  await expect(page.getByTestId('pending-label')).toHaveText('pending/human');
  for (const gone of ['pending-list', 'pending-item', 'pending-count', 'unread-count', 'pending-breakdown']) await expect(page.getByTestId(gone)).toHaveCount(0);
  await expect(page.getByTestId('launch-at-login')).not.toBeChecked();
  // the box follows what the system says, not the click: it turns on once the system answered
  await page.getByTestId('launch-at-login').click();
  await expect.poll(() => app.desktop.records.filter((a) => a.op === 'loginItem').map((a) => a.on)).toEqual([true]);
  await expect(page.getByTestId('launch-at-login')).toBeChecked();
  await shot(page, '20-pending-settings');

  // a merged PR and an open issue get the label on GitHub → one notification each at the next beat (GitHub#462)
  putPending(mergedPr);
  putPending(fresh);
  await page.getByTestId('back').click();
  app.desktop.push({ kind: 'tick' });
  await expect
    .poll(() => notes().filter((a) => a.kind === 'item').map((a) => a.key).sort())
    .toEqual([`gigleai/cavil-loop#${fresh}`, `gigleai/cavil-loop#${mergedPr}`].sort());
  const itemNote = notes().find((a) => a.kind === 'item' && a.key === `gigleai/cavil-loop#${fresh}`);
  expect(itemNote.title).toBe(`待处理：GigleAI/cavil-loop#${fresh}`);
  await expect.poll(badge).toBe(2);
  // "did happen": that round read the merged PR with its label
  await page.getByTestId('search').fill(`#${mergedPr}`);
  if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').click();
  await expect(card(page, mergedPr).locator('.label', { hasText: 'pending/human' })).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('search').fill('');
  app.desktop.push({ kind: 'tick' });
  await page.waitForTimeout(800);
  expect(notes()).toHaveLength(2);

  // GitHub#328: each notified item's detail was read ahead, once, with nobody opening it
  const detailReads = (n: number) => env.fake.log.filter((l) => l.operation === 'CavilItemDetail' && l.variables?.number === n);
  await expect.poll(() => detailReads(fresh).filter((l) => l.status === 200).length).toBe(1);
  await expect.poll(() => detailReads(mergedPr).filter((l) => l.status === 200).length).toBe(1);

  // a click on that notification opens the item in the app (also from the settings page):
  // what was read ahead shows at once, while the panel's own read is still held
  const releaseDetail = env.fake.holdWhen((e) => e.operation === 'CavilItemDetail' && e.variables?.number === fresh);
  await page.getByTestId('open-settings').click();
  app.desktop.push({ kind: 'open', key: itemNote.key, url: itemNote.url });
  await expect(page.getByTestId('detail')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('detail')).toContainText(`#${fresh}`);
  await expect(page.getByTestId('detail').getByTestId('detail-cached')).toContainText('正在更新');
  await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry').first()).toBeVisible();
  // "did happen": the panel's read went out and has no answer yet
  expect(detailReads(fresh).map((l) => l.status)).toEqual([200, 0]);
  await shot(page, '22-notification-click');
  releaseDetail();
  await expect(page.getByTestId('detail').getByTestId('detail-cached')).toHaveCount(0);
  // closed, then the settings page and back: an old click never reopens it
  await page.getByTestId('detail-close').click();
  await expect(page.getByTestId('detail')).toHaveCount(0);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('back').click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('detail')).toHaveCount(0);

  // another label name: recounted silently, nothing notified, nothing new unread
  await page.getByTestId('open-settings').click();
  // the reminder label is the same setting as the "hand back to agent" one
  await page.getByTestId('hand-back-human').fill('doing/agent');
  await page.getByTestId('hand-back-human').blur();
  await expect(page.getByTestId('pending-label')).toHaveText('doing/agent');
  await page.waitForTimeout(300);
  expect(badge()).toBeLessThanOrEqual(2);
  expect(notes()).toHaveLength(2);

  // the user switches to the window (the shell reports the focus): the badge cleared; the delivered
  // notifications stay (GitHub#369)
  const opsSince = (from: number) => app.desktop.records.slice(from).map((r) => (r.op === 'badge' ? `badge ${r.count}` : r.op));
  let before = app.desktop.records.length;
  app.desktop.push({ kind: 'active' });
  await expect.poll(() => opsSince(before)).toEqual(['badge 0']);
  await page.waitForTimeout(500);
  expect(opsSince(before)).toEqual(['badge 0']);
  // ticked in Settings: the next switch takes them back again, after the badge — and the page says so,
  // including what a click leaves behind then (PR #370 review round 1: never "the rest stay" while ticked)
  await page.getByTestId('clear-all-on-activate').click();
  await expect(page.getByTestId('clear-all-on-activate')).toBeChecked();
  await expect(page.getByTestId('notification-keep-rule')).toHaveText('已勾选下面一项：切到 App 时本 App 的系统通知全部收起。点一条通知会把窗口带到前台，所以其余通知也会随之全部收起。');
  await expect(page.getByTestId('pending-how-to-clear')).not.toContainText('其余留在通知中心');
  await page.getByTestId('pending-settings').scrollIntoViewIfNeeded();
  await shot(page, '21-pending-settings-ticked');
  app.desktop.push({ kind: 'inactive' });
  before = app.desktop.records.length;
  app.desktop.push({ kind: 'active' });
  await expect.poll(() => opsSince(before)).toEqual(['badge 0', 'clearNotifications']);
  // unticked again: the page goes back to "the rest stay", and so does the next switch
  await page.getByTestId('clear-all-on-activate').click();
  await expect(page.getByTestId('clear-all-on-activate')).not.toBeChecked();
  await expect(page.getByTestId('notification-keep-rule')).toContainText('其余留在通知中心');
  app.desktop.push({ kind: 'inactive' });
  before = app.desktop.records.length;
  app.desktop.push({ kind: 'active' });
  await expect.poll(() => opsSince(before)).toEqual(['badge 0']);
  await page.waitForTimeout(500);
  expect(opsSince(before)).toEqual(['badge 0']);
  await app.close();
});

/** Assign an item on the fake GitHub (every copy), the way a maintainer does on GitHub. */
function assignTo(n: number, logins: string[]) {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const c = findCopies(store, 'GigleAI/cavil-loop', n)!;
  const now = new Date().toISOString();
  for (const g of c.gql) ((g.assignees = { nodes: logins.map((login) => ({ login })) }), (g.updatedAt = now));
  for (const r of c.rest) ((r.assignees = logins.map((login) => ({ login }))), (r.updated_at = now));
}

test('GitHub#373: "which items remind" in Settings — every pending item by default; "only mine" explains its rule, stays after a restart, and then only the account\'s items notify', async () => {
  const [theirs, mine, later] = openUnlabelled();
  for (const n of [theirs, mine, later]) assignTo(n, []);
  let { app, page } = await launch(env);
  await signInForReminders(page, ['GigleAI/cavil-loop']);
  const notes = () => app.desktop.records.filter((a) => a.op === 'notify' && a.alert.kind === 'item').map((a) => a.alert.key);
  // the default: every pending item, and the page says what the other choice is for
  await expect(page.getByTestId('notify-scope-all')).toBeChecked();
  await expect(page.getByTestId('notify-scope-mine')).not.toBeChecked();
  await expect(page.getByTestId('notify-scope-note')).toContainText('每人都会收到全部待处理的通知');
  await expect(page.getByTestId('pending-rule')).not.toContainText('和我有关');
  await page.getByTestId('pending-settings').scrollIntoViewIfNeeded();
  await shot(page, '22-notify-scope-all');
  // "only mine": the account it means, and the three steps
  await page.getByTestId('notify-scope-mine').click();
  await expect(page.getByTestId('notify-scope-mine')).toBeChecked();
  await expect(page.getByTestId('notify-scope-all')).not.toBeChecked();
  await expect(page.getByTestId('notify-scope')).toContainText(`只提醒和我（${env.fake.state.viewer}）有关的`);
  for (const part of ['指派给我、或请我 review 的，提醒', '即使我在 GitHub 上订阅着也不提醒', '我订阅着就提醒', '按它关联的 issue 判断']) await expect(page.getByTestId('notify-scope-note')).toContainText(part);
  await expect(page.getByTestId('pending-rule')).toContainText('并且和我有关时发一次系统通知');
  await expect(page.getByTestId('pending-label')).toHaveText('pending/human');
  await shot(page, '23-notify-scope-mine');
  // back and forth follows the click
  await page.getByTestId('notify-scope-all').click();
  await expect(page.getByTestId('notify-scope-all')).toBeChecked();
  await expect(page.getByTestId('pending-rule')).not.toContainText('和我有关');
  await page.getByTestId('notify-scope-mine').click();
  await expect(page.getByTestId('notify-scope-mine')).toBeChecked();
  // the first complete read is in (the baseline): only then do labels count as new
  await expect.poll(() => app.desktop.records.filter((a) => a.op === 'badge').length).toBeGreaterThan(0);

  // somebody else's item and the account's both get the label: one notification, the account's
  assignTo(theirs, ['someone-else']);
  putPending(theirs);
  assignTo(mine, [env.fake.state.viewer]);
  putPending(mine);
  app.desktop.push({ kind: 'tick' });
  await expect.poll(notes).toEqual([`gigleai/cavil-loop#${mine}`]);
  // "did happen": that round read the other one with its label and its assignee
  await page.getByTestId('back').click();
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await page.getByTestId('search').fill(`#${theirs}`);
  await expect(card(page, theirs).locator('.label', { hasText: 'pending/human' })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(notes()).toEqual([`gigleai/cavil-loop#${mine}`]);
  await app.close();

  // after a restart the choice is still there, and still the one used
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('notify-scope-mine')).toBeChecked();
  await expect.poll(() => app.desktop.records.filter((a) => a.op === 'badge').length).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(notes()).toEqual([]);
  // handed to the account now: a long-labelled item becomes a notification
  assignTo(theirs, [env.fake.state.viewer]);
  app.desktop.push({ kind: 'tick' });
  await expect.poll(notes).toEqual([`gigleai/cavil-loop#${theirs}`]);
  await app.close();
});

test('notifications refused by the system: the board says so and how to allow them', async () => {
  const { app, page } = await launch(env);
  app.desktop.refuse = 'Notifications are not allowed for this application';
  await signInForReminders(page, [PROJECT_URL]);
  // the first read is history (GitHub#251): nothing goes out until a new label comes
  const [first, second] = openUnlabelled();
  await page.getByTestId('back').click();
  // adding the Project imported its saved web view (a table): back to the board to see the first read
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await page.getByTestId('search').fill(`#${first}`);
  await expect(card(page, first)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('search').fill('');
  await page.getByTestId('open-settings').click();
  putPending(first);
  app.desktop.push({ kind: 'tick' });
  // sent (and refused)
  await expect.poll(() => app.desktop.records.filter((a) => a.op === 'notify').length, { timeout: 15_000 }).toBe(1);
  await expect(page.getByTestId('notify-problem')).toContainText('系统设置 → 通知 → Cavil Loop');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('board-notify-problem')).toContainText('Notifications are not allowed');
  await shot(page, '21-notify-refused');
  // like every yellow bar (GitHub#153): × closes it, and the same refusal again does not bring it back
  await page.getByTestId('board-notify-problem-close').click();
  await expect(page.getByTestId('board-notify-problem')).toHaveCount(0);
  // one more item gets the label: a second notification, refused for the same reason
  putPending(second);
  app.desktop.push({ kind: 'tick' });
  await expect.poll(() => app.desktop.records.filter((a) => a.op === 'notify').length).toBe(2);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('board-notify-problem')).toHaveCount(0);
  await app.close();
});

// GitHub#172: the top of the detail tells an issue from a PR at a glance — a
// different icon and the full name — and the colour is GitHub's state colour
// (review of PR #174: "keep the issue / PR state colours the same as GitHub"):
// open green, PR closed red, merged PR / issue closed as completed purple,
// draft PR / issue closed as not planned grey. Closed and merged win over a
// draft mark; an open PR marked as a draft turns grey. The lists carry the draft
// mark; the badge prefers the fresher detail read and falls back to the board's
// when the detail has not arrived or failed (neither knows → not a draft). The
// board card and the table row use the same colour rule.
test('detail badge: issue and PR differ by icon and full name; GitHub state colours on badge, card and table; draft mark from the detail or the board', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  /** GitHub's draft mark on every copy (detail, Project, repository list) — or only where `where` says */
  const draft = (n: number, on = true, where: 'all' | 'detail' | 'lists' = 'all') => {
    const c = findCopies(store, 'GigleAI/cavil-loop', n)!;
    if (where !== 'lists') pullOf(store, c).isDraft = on;
    if (where !== 'detail') {
      for (const g of c.gql) g.isDraft = on;
      for (const r of c.rest) r.draft = on;
    }
  };
  /** GitHub's close reason on every copy of an issue (Project and repository list) */
  const closedAs = (n: number, reason: string) => {
    const c = findCopies(store, 'GigleAI/cavil-loop', n)!;
    for (const g of c.gql) g.stateReason = reason.toUpperCase();
    for (const r of c.rest) r.state_reason = reason;
  };
  draft(147); // open draft
  draft(129); // closed, still carrying the draft mark
  draft(146, true, 'detail'); // its detail read fails; the board's lists say "not a draft"
  env.fake.state.w.failDetail.add('gigleai/cavil-loop#146');
  draft(149, true, 'detail'); // became a draft after the board's last read: only the (fresher) detail knows yet
  closedAs(128, 'completed');
  closedAs(138, 'not_planned');

  const { app, page } = await launch(env);
  await signInWithSources(page);
  const badge = page.getByTestId('detail-kind');

  const open = async (n: number) => {
    await page.getByTestId('search').fill(`#${n}`);
    if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').click();
    await card(page, n).click();
    await expect(page.getByTestId('detail')).toHaveAttribute('data-key', `gigleai/cavil-loop#${n}`);
  };
  /** the detail read finished (so a draft mark, if any, has arrived) */
  const loaded = async () => {
    await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
  };
  const bg = () => badge.evaluate((el) => getComputedStyle(el).backgroundColor);
  const fg = (l: ReturnType<Page['locator']>) => l.evaluate((el) => getComputedStyle(el).color);

  // GitHub's (Primer) colours. Expected values follow GitHub's rule, not the implementation's output.
  const BG = { open: 'rgb(31, 136, 61)', closed: 'rgb(207, 34, 46)', done: 'rgb(130, 80, 223)', neutral: 'rgb(89, 99, 110)' };
  const FG = { open: 'rgb(26, 127, 55)', closed: 'rgb(209, 36, 47)', done: 'rgb(130, 80, 223)', neutral: 'rgb(89, 99, 110)' };
  type Tone = keyof typeof BG;
  const rows: { n: number; kind: 'issue' | 'pr'; tone: Tone; cardTone: Tone; text: string; why: string }[] = [
    { n: 137, kind: 'issue', tone: 'open', cardTone: 'open', text: 'Issue·开', why: 'open issue' },
    { n: 128, kind: 'issue', tone: 'done', cardTone: 'done', text: 'Issue·已关闭', why: 'issue closed as completed: purple' },
    { n: 138, kind: 'issue', tone: 'neutral', cardTone: 'neutral', text: 'Issue·已关闭（不计划）', why: 'issue closed as not planned: grey' },
    { n: 148, kind: 'pr', tone: 'open', cardTone: 'open', text: 'Pull Request·开', why: 'open PR, not a draft' },
    { n: 147, kind: 'pr', tone: 'neutral', cardTone: 'neutral', text: 'Pull Request·草稿', why: 'open draft PR: grey on the badge and the card' },
    { n: 123, kind: 'pr', tone: 'closed', cardTone: 'closed', text: 'Pull Request·已关闭', why: 'closed PR: red' },
    { n: 129, kind: 'pr', tone: 'closed', cardTone: 'closed', text: 'Pull Request·已关闭', why: 'closed PR with a draft mark: closed wins' },
    { n: 150, kind: 'pr', tone: 'done', cardTone: 'done', text: 'Pull Request·已合并', why: 'merged PR' },
  ];
  const icons: Record<string, string> = {};
  for (const r of rows) {
    await open(r.n);
    await loaded();
    await expect(badge, r.why).toHaveAttribute('data-kind', r.kind);
    await expect(badge, r.why).toHaveAttribute('data-tone', r.tone);
    await expect(badge, r.why).toHaveText(r.text);
    await expect(badge, r.why).toHaveAttribute('aria-label', r.text.replace('·', '，'));
    await expect(badge.locator('svg'), r.why).toHaveAttribute('data-icon', r.kind);
    expect(await bg(), r.why).toBe(BG[r.tone]);
    // GitHub#229: the detail head got shorter, the badge with it
    expect(await badge.evaluate((el) => getComputedStyle(el).fontSize), r.why).toBe('12px');
    // the card on the board: same colour rule
    const cs = card(page, r.n).getByTestId('card-state');
    await expect(cs, r.why).toHaveAttribute('data-tone', r.cardTone);
    expect(await fg(cs), r.why).toBe(FG[r.cardTone]);
    icons[r.kind] = await badge.locator('svg').innerHTML();
    await shot(page, `31-badge-${r.n}-${r.tone}`);
  }
  // the two icons are really different drawings, not the same shape under two names
  expect(icons.issue).toBeTruthy();
  expect(icons.pr).toBeTruthy();
  expect(icons.issue).not.toBe(icons.pr);

  // the card says the same as the badge, text included
  await open(147);
  await expect(card(page, 147).getByTestId('card-state')).toHaveText('PR · 草稿');
  await open(129);
  await expect(card(page, 129).getByTestId('card-state')).toHaveText('PR · 已关闭');

  // became a draft after the board's last read: the badge follows the fresher detail read, the card the board's read …
  await open(149);
  await loaded();
  await expect(badge).toHaveAttribute('data-tone', 'neutral');
  await expect(card(page, 149).getByTestId('card-state')).toHaveAttribute('data-tone', 'open');
  // … until the next sync brings the mark to the board too (ready → draft)
  draft(149, true, 'lists');
  await page.getByTestId('refresh').click();
  await expect(card(page, 149).getByTestId('card-state')).toHaveAttribute('data-tone', 'neutral');
  expect(await fg(card(page, 149).getByTestId('card-state'))).toBe(FG.neutral);

  // draft → ready: after a sync the card is green again, and so is the badge on the next opening
  draft(147, false);
  await page.getByTestId('refresh').click();
  await page.getByTestId('search').fill('#147');
  await expect(card(page, 147).getByTestId('card-state')).toHaveAttribute('data-tone', 'open');
  await open(147);
  await loaded();
  await expect(badge).toHaveAttribute('data-tone', 'open');
  await expect(badge).toHaveText('Pull Request·开');
  draft(147, true);
  await page.getByTestId('refresh').click();
  await page.getByTestId('search').fill('#147');
  await expect(card(page, 147).getByTestId('card-state')).toHaveAttribute('data-tone', 'neutral');

  // a detail read that fails: the panel says so, and the badge goes by the board's own read (here: not a draft) — nothing is guessed
  await open(146);
  await expect(page.getByTestId('detail-error')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => env.fake.log.some((l) => l.operation === 'CavilItemDetail' && l.variables?.number === 146 && l.status === 502)).toBe(true);
  await expect(badge).toHaveAttribute('data-kind', 'pr');
  await expect(badge).toHaveAttribute('data-tone', 'open');
  await expect(badge).toHaveText('Pull Request·开');
  expect(await bg()).toBe(BG.open);
  await shot(page, '32-badge-detail-failed');
  await page.getByTestId('detail-close').click();

  // the table row: same colour rule
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  for (const [n, tone] of [[128, 'done'], [138, 'neutral'], [123, 'closed'], [137, 'open'], [147, 'neutral'], [129, 'closed'], [148, 'open']] as const) {
    await page.getByTestId('search').fill(`#${n}`);
    const cell = page.locator(`[data-testid="row"][data-key="gigleai/cavil-loop#${n}"] [data-testid="row-state"]`).first();
    await expect(cell, `table #${n}`).toHaveAttribute('data-tone', tone);
    expect(await fg(cell), `table #${n}`).toBe(FG[tone]);
  }
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();

  // a detail read that fails on a PR the board knows is a draft: the badge takes the board's mark (grey)
  draft(148, true, 'lists');
  env.fake.state.w.failDetail.add('gigleai/cavil-loop#148');
  await page.getByTestId('refresh').click();
  await page.getByTestId('search').fill('#148');
  await expect(card(page, 148).getByTestId('card-state')).toHaveAttribute('data-tone', 'neutral');
  await open(148);
  // GitHub#229: #148 was opened above, so its last read shows and the failed read is said in small print
  await expect(page.getByTestId('detail-stale')).toBeVisible({ timeout: 15_000 });
  await expect(badge).toHaveAttribute('data-tone', 'neutral');
  await expect(badge).toHaveText('Pull Request·草稿');
  await page.getByTestId('detail-close').click();

  // dark mode: GitHub's darker palette, white text still on a coloured badge
  await page.emulateMedia({ colorScheme: 'dark' });
  const DARK_BG = { neutral: 'rgb(101, 108, 118)', done: 'rgb(137, 87, 229)', open: 'rgb(35, 134, 54)' };
  for (const [n, tone] of [[147, 'neutral'], [150, 'done'], [137, 'open'], [138, 'neutral']] as const) {
    await open(n);
    await loaded();
    await expect(badge).toHaveAttribute('data-tone', tone);
    expect(await bg()).toBe(DARK_BG[tone]);
    expect(await badge.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)');
    await shot(page, `33-badge-dark-${n}-${tone}`);
  }
  await app.close();
});

// ---- GitHub#181: one look for every page — text stays readable, the header fits ----

/**
 * Every piece of text on the page (light DOM, the discussion frame excepted) against what is really
 * behind it: background layers composited up the tree, opacity multiplied in. WCAG AA: 4.5:1,
 * 3:1 for large text (≥ 24 px, or ≥ 18.66 px bold). Disabled controls are exempt (WCAG's
 * "inactive" rule), so is text that is not rendered (visibility, zero size, screen-reader only).
 */
async function lowContrast(page: Page) {
  return page.evaluate(() => {
    type C = [number, number, number, number];
    const parse = (s: string): C => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const over = (top: C, under: C): C => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a) as C;
    };
    const lum = (c: C) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a: C, b: C) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const backdrop = (el: Element): C => {
      const layers: C[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      let acc: C = parse(getComputedStyle(document.documentElement).backgroundColor);
      // GitHub#516: the look the window shows is the page's mark (Settings may hold it against the system)
      if (acc[3] < 1) acc = over(acc, document.documentElement.dataset.theme === 'dark' ? [13, 17, 23, 1] : [255, 255, 255, 1]);
      for (const l of layers.reverse()) acc = over(l, acc);
      return acc;
    };
    const opacity = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    const bad: string[] = [];
    let checked = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent!.trim()) continue;
      seen.add(el);
      if (el.closest('option, script, style, .sr-only, :disabled, [aria-disabled="true"]')) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.visibility !== 'visible' || cs.display === 'none' || r.width === 0 || r.height === 0) continue;
      const bg = backdrop(el);
      const fgRaw = parse(cs.color);
      const fg = over([fgRaw[0], fgRaw[1], fgRaw[2], fgRaw[3] * opacity(el)], bg);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const k = ratio(fg, bg);
      checked++;
      if (k < (large ? 3 : 4.5)) bad.push(`${k.toFixed(2)} 「${n.textContent!.trim().slice(0, 24)}」 ${cs.color} on rgb(${bg.slice(0, 3).map(Math.round).join(', ')})`);
    }
    return { checked, bad };
  });
}

/** Background alpha of every label chip on the page (1 = solid). */
const chipAlphas = (page: Page, sel = '.label') =>
  page.locator(sel).evaluateAll((els) =>
    els.map((e) => {
      const m = getComputedStyle(e).backgroundColor.match(/rgba?\(([^)]+)\)/)!;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return p.length > 3 ? p[3] : 1;
    }),
  );

/**
 * Switch the colour scheme and wait until the window has really taken it: the media query
 * reports it and every label chip has been re-rendered for it (the chips follow the scheme
 * through a React state set from the media query's change event, so right after the switch
 * they can still be the old ones — WebKit on CI read them in that gap). CSS-only colours
 * follow at once. If the window never takes the scheme, this fails after the poll's timeout.
 */
async function schemeSettled(page: Page, scheme: 'light' | 'dark', where: string) {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(
      async () => {
        const matches = await page.evaluate((s) => matchMedia(`(prefers-color-scheme: ${s})`).matches, scheme);
        const alphas = await chipAlphas(page);
        return matches && alphas.every((a) => (scheme === 'dark' ? a < 1 : a >= 1));
      },
      { message: `${where}: the window takes the ${scheme} scheme (media query + label chips)` },
    )
    .toBe(true);
}

/** Text check in both colour schemes; also asserts something was checked (an empty page passes nothing). */
async function readableBoth(page: Page, where: string, min: number) {
  for (const scheme of ['light', 'dark'] as const) {
    await schemeSettled(page, scheme, where);
    const r = await lowContrast(page);
    expect(r.checked, `${where} (${scheme}): text was found`).toBeGreaterThan(min);
    expect(r.bad, `${where} (${scheme})`).toEqual([]);
    await shot(page, `52-look-${where}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Dark mode: label chips are see-through tints, not GitHub's solid light-page colours (card, detail, table). */
async function chipsTinted(page: Page, sel: string, where: string) {
  await schemeSettled(page, 'dark', where);
  const alphas = await chipAlphas(page, sel);
  expect(alphas.length, `${where}: chips found`).toBeGreaterThan(0);
  expect(alphas.filter((a) => a >= 1), `${where}: solid chips in dark mode`).toEqual([]);
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The two header rows at the current width: nothing overlaps, nothing sticks out, no sideways scroll. */
async function headerFits(page: Page, where: string) {
  const r = await page.evaluate(() => {
    const out: string[] = [];
    const doc = document.scrollingElement!;
    if (doc.scrollWidth > window.innerWidth) out.push(`page scrolls sideways: ${doc.scrollWidth} > ${window.innerWidth}`);
    let rows = 0;
    // GitHub#467: the window's one top row, then the board's view bar
    for (const row of document.querySelectorAll('.topbar, .topbar-tools, .vbar')) {
      rows++;
      const box = row.getBoundingClientRect();
      if (row.scrollWidth > row.clientWidth + 1) out.push(`${row.className} scrolls: ${row.scrollWidth} > ${row.clientWidth}`);
      const kids = [...row.children].map((c) => ({ c, b: c.getBoundingClientRect() })).filter((k) => k.b.width > 0 && getComputedStyle(k.c).display !== 'none');
      for (const k of kids) if (k.b.right > box.right + 0.5 || k.b.left < box.left - 0.5) out.push(`${row.className} > ${k.c.className}: outside the row`);
      for (let i = 0; i < kids.length; i++)
        for (let j = i + 1; j < kids.length; j++) {
          const [a, b] = [kids[i].b, kids[j].b];
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5)
            out.push(`${row.className}: ${kids[i].c.className} overlaps ${kids[j].c.className}`);
        }
    }
    return { rows, out };
  });
  expect(r.rows, `${where}: the top row, its tools and the view bar are there`).toBe(3);
  expect(r.out, where).toEqual([]);
}

test('GitHub#181 look: text readable at 4.5:1 in light and dark on every page; dark label chips are tints; the header fits a 1024 px window', async () => {
  const { app, page } = await launch(env);
  await expect(page.getByTestId('login')).toBeVisible();
  await readableBoth(page, 'sign-in', 5);

  await signInWithSources(page);
  await page.getByTestId('mode').selectOption('status');
  await readableBoth(page, 'board', 100);
  await chipsTinted(page, '[data-testid="card"] .label', 'board card');

  await card(page, 138).click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', 'gigleai/cavil-loop#138');
  await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
  await readableBoth(page, 'detail', 100);
  await chipsTinted(page, '[data-testid="detail"] .label', 'detail');
  await page.getByTestId('detail-close').click();

  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await page.getByTestId('open-view-panel').click();
  const labelsCol = page.locator('[data-testid="columns-pick"] input[data-col="labels"]');
  if (!(await labelsCol.isChecked())) await labelsCol.check();
  await readableBoth(page, 'table', 100);
  await chipsTinted(page, '[data-testid="table"] .label', 'table');
  await shot(page, '50-look-table');

  // a 1024 × 700 window, both layouts, both schemes (dark changes no sizes, checked anyway)
  await page.setViewportSize({ width: 1024, height: 700 });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await headerFits(page, `table, 1024 px, ${scheme}`);
    await page.locator('[data-testid="layout"] button[data-value="board"]').click();
    await headerFits(page, `board, 1024 px, ${scheme}`);
    await shot(page, `51-look-1024-${scheme}`);
    await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await readableBoth(page, 'settings', 20);

  // GitHub#516: the same check with light / dark chosen in Settings against the system's — settings, board, detail
  // (Settings is open here; each round ends back in it)
  for (const [choice, system] of [
    ['dark', 'light'],
    ['light', 'dark'],
  ] as const) {
    await page.emulateMedia({ colorScheme: system });
    await page.getByTestId(`theme-${choice}`).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', choice);
    for (const where of ['settings', 'board', 'detail'] as const) {
      if (where === 'board') {
        await page.getByTestId('back').click();
        await page.locator('[data-testid="layout"] button[data-value="board"]').click();
      }
      if (where === 'detail') {
        await card(page, 138).click();
        await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
      }
      const r = await lowContrast(page);
      expect(r.checked, `${where} (${choice} chosen, system ${system}): text was found`).toBeGreaterThan(where === 'settings' ? 20 : 100);
      expect(r.bad, `${where} (${choice} chosen, system ${system})`).toEqual([]);
      await shot(page, `52-look-${where}-chosen-${choice}`);
    }
    await page.getByTestId('detail-close').click();
    await page.locator('[data-testid="layout"] button[data-value="table"]').click();
    await page.getByTestId('open-settings').click();
  }
  await page.getByTestId('theme-system').check();
  await page.emulateMedia({ colorScheme: 'light' });
  await app.close();
});

test('GitHub#505: 在标签页打开 in the floating panel is a plain button like the GitHub one beside it — same fill and border, no filter, readable — at rest and under the pointer, light and dark', async () => {
  const { app, page } = await launch(env);
  await signInWithSources(page);
  await page.getByTestId('mode').selectOption('status');
  await card(page, 138).click();
  const detail = page.getByTestId('detail');
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#138');
  const openTab = detail.getByTestId('detail-open-tab');
  const openWeb = detail.getByTestId('detail-open-web');
  await expect(openTab).toBeVisible();
  await expect(openTab).toHaveText('在标签页打开');
  await expect(openWeb).toBeVisible();
  type Look = { bg: string; border: string; filter: string; color: string; ratio: number; hovered: boolean };
  const look = (l: typeof openTab) =>
    l.evaluate((b): Look => {
      const cs = getComputedStyle(b);
      const rgb = (v: string) => v.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const lum = (c: number[]) => {
        const f = (v: number) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      const [hi, lo] = [lum(rgb(cs.color)), lum(rgb(cs.backgroundColor))].sort((p, q) => q - p);
      return { bg: cs.backgroundColor, border: cs.borderTopColor, filter: cs.filter, color: cs.color, ratio: (hi + 0.05) / (lo + 0.05), hovered: b.matches(':hover') };
    });
  const seen: Record<string, Look> = {};
  for (const scheme of ['light', 'dark'] as const) {
    await schemeSettled(page, scheme, `GitHub#505 ${scheme}`);
    // at rest: the pointer is far from both buttons
    await page.mouse.move(5, 700);
    const [tab, web] = [await look(openTab), await look(openWeb)];
    expect(tab.hovered, `${scheme}: not under the pointer`).toBe(false);
    expect({ bg: tab.bg, border: tab.border, filter: tab.filter }, `${scheme}, at rest`).toEqual({ bg: web.bg, border: web.border, filter: 'none' });
    expect(tab.ratio, `${scheme}, at rest: ${tab.color} on ${tab.bg}`).toBeGreaterThanOrEqual(4.5);
    seen[`${scheme} rest`] = tab;
    // under the pointer: each button is really hovered, and they still look alike
    await openTab.hover();
    await expect.poll(async () => (await look(openTab)).hovered).toBe(true);
    const tabHover = await look(openTab);
    await openWeb.hover();
    await expect.poll(async () => (await look(openWeb)).hovered).toBe(true);
    const webHover = await look(openWeb);
    expect({ bg: tabHover.bg, border: tabHover.border, filter: tabHover.filter }, `${scheme}, hovered`).toEqual({ bg: webHover.bg, border: webHover.border, filter: 'none' });
    expect(tabHover.ratio, `${scheme}, hovered: ${tabHover.color} on ${tabHover.bg}`).toBeGreaterThanOrEqual(4.5);
    seen[`${scheme} hover`] = tabHover;
    await page.mouse.move(5, 700);
    await shot(page, `505-open-tab-${scheme}`);
  }
  // the two schemes really differ (the check above ran in both, not twice in one)
  expect(seen['light rest'].bg).not.toBe(seen['dark rest'].bg);
  await page.emulateMedia({ colorScheme: 'light' });
  await app.close();
});


test('GitHub#181 / #467 many sources: the top row fits at 720, 1024 and 1280 px; each source\'s 在看板显示 switch in Settings really switches what the board shows', async () => {
  // 20 repositories, one open issue each, so switching one source changes the count by exactly one
  const sample = env.fake.state.repos.get('gigleai/cavil-loop')!.find((i) => i.state === 'open' && !i.pull_request)!;
  const names = Array.from({ length: 20 }, (_, i) => `GigleAI/many-source-${i + 1}`);
  names.forEach((name, i) => {
    const issue = JSON.parse(JSON.stringify(sample));
    issue.id = 9_000_000 + i;
    issue.node_id = `I_many_${i}`;
    issue.number = 1;
    issue.title = `item from ${name}`;
    issue.html_url = `https://github.com/${name}/issues/1`;
    issue.url = `https://api.github.com/repos/${name}/issues/1`;
    issue.repository_url = `https://api.github.com/repos/${name}`;
    env.fake.state.repos.set(name.toLowerCase(), [issue]);
  });

  const { app, page } = await launch(env);
  await page.getByTestId('oauth-settings-toggle').click();
  await page.getByTestId('client-id').fill(env.fake.state.oauthClientId);
  await page.getByTestId('save-client-id').click();
  await page.getByTestId('start-login').click();
  await expect(page.getByTestId('user-code')).toBeVisible();
  env.fake.resolveGrant('approved');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  for (const [i, name] of names.entries()) {
    await page.getByTestId('source-input').fill(name);
    await page.getByTestId('source-add').click();
    await expect(page.getByTestId('source-row')).toHaveCount(i + 1);
  }
  await page.getByTestId('back').click();
  const total = page.getByTestId('item-total');
  await expect(total).toHaveText('20 个条目', { timeout: 15_000 });

  // GitHub#467: the sources are no longer in the top row; however many there are, it fits
  for (const width of [720, 1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await headerFits(page, `board, ${width} px, 20 sources`);
  }
  for (const name of [names[names.length - 1], names[10]]) {
    const key = `repo:${name.toLowerCase()}`;
    await page.getByTestId('open-settings').click();
    const sw = page.locator(`[data-testid="source-shown"][data-key="${key}"]`);
    const rowOf = page.locator(`[data-testid="source-row"][data-key="${key}"]`);
    await expect(sw).toBeChecked();
    await sw.click();
    await expect(sw).not.toBeChecked();
    // switched off: still listed (and read), faded, and said so
    await expect(rowOf).toHaveAttribute('data-shown', 'no');
    await expect(rowOf.getByTestId('source-hidden-note')).toBeVisible();
    await page.getByTestId('back').click();
    await expect(total).toHaveText('19 个条目');
    await expect(page.getByText(`item from ${name}`)).toHaveCount(0);
    await page.getByTestId('open-settings').click();
    await sw.click();
    await expect(sw).toBeChecked();
    await expect(rowOf).toHaveAttribute('data-shown', 'yes');
    await page.getByTestId('back').click();
    await expect(total).toHaveText('20 个条目');
  }
  await shot(page, '53-look-many-sources-1280');
  await page.setViewportSize({ width: 1280, height: 800 });
  await app.close();
});

test('GitHub#180: close an issue from the detail (reason + optional comment); the panel\'s own button says 收起 and keeps its Esc rules', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  /** #n open on GitHub on every copy, whatever the recorded fixture captured */
  const openOnGitHub = (n: number) => {
    const c = findCopies(store, 'GigleAI/cavil-loop', n)!;
    for (const g of c.gql) Object.assign(g, { state: 'OPEN', stateReason: null });
    for (const r of c.rest) Object.assign(r, { state: 'open', state_reason: null });
  };
  openOnGitHub(137);
  openOnGitHub(139);
  // one recorded PR made open (not merged): the detail of an open PR is where a wrong "close issue" would show
  const prN = env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((n: any) => n.content?.__typename === 'PullRequest')!.content.number as number;
  for (const g of findCopies(store, 'GigleAI/cavil-loop', prN)!.gql) Object.assign(g, { state: 'OPEN', merged: false });
  for (const r of findCopies(store, 'GigleAI/cavil-loop', prN)!.rest) Object.assign(r, { state: 'open', pull_request: { ...r.pull_request, merged_at: null } });
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const detail = page.getByTestId('detail');
  const badge = page.getByTestId('detail-kind');
  const open = async (n: number) => {
    await page.getByTestId('search').fill(`#${n}`);
    if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').click();
    await card(page, n).click();
    await expect(detail).toHaveAttribute('data-key', `gigleai/cavil-loop#${n}`);
    // the detail read finished: the close entry depends on it
    await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
  };

  // ---- 1. the panel's own button: 收起, the Esc rules still told; it only puts the panel away ----
  await open(137);
  const hide = page.getByTestId('detail-close');
  await expect(hide).toHaveText('收起 ›');
  await expect(hide).toHaveAttribute('title', '收起（或点面板以外的地方、按 Esc；回复框里有没发出的文字时都不收起；点过讨论后，先点一下讨论以外的地方再按 Esc）');
  await expect(page.getByTestId('close-issue')).toHaveText('关闭 issue…Ctrl+Shift+X');
  await shot(page, '50-issue-open-hide-button');
  await hide.click();
  await expect(detail).toHaveCount(0);
  expect(env.fake.writes()).toEqual([]);
  // Esc after a click into the discussion stays there; a click outside it, then Esc, puts the panel away
  await open(137);
  await page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry > summary').first().click({ position: { x: 40, y: 10 } });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  await detail.locator('.detail-title').click();
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  expect(env.fake.writes()).toEqual([]);

  // ---- 2. an open PR's detail has no "close issue" (its own close stays in the PR box) ----
  await open(prN);
  await expect(badge).toHaveAttribute('data-kind', 'pr');
  await expect(badge).toHaveAttribute('data-tone', 'open');
  await expect(page.getByTestId('close-pr')).toBeVisible();
  await expect(page.getByTestId('close-issue')).toHaveCount(0);
  await hide.click();

  // ---- 3. close #137 as "not planned" with a comment ----
  await open(137);
  await page.getByTestId('close-issue').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog.locator('h3')).toHaveText('关闭 issue #137？');
  await expect(page.getByTestId('close-reason-completed')).toBeChecked();
  await expect(page.getByTestId('close-reason-not_planned')).not.toBeChecked();
  // Esc while the dialog asks cancels the dialog only (GitHub#192): the panel stays, nothing sent
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  expect(env.fake.writes()).toEqual([]);
  await page.getByTestId('close-issue').click();
  await expect(dialog).toBeVisible();
  await page.getByTestId('close-reason-not_planned').check();
  await page.getByTestId('close-comment').fill('不做了');
  await shot(page, '51-close-issue-confirm');
  expect(env.fake.writes()).toEqual([]);
  await page.getByTestId('confirm-ok').click();
  // GitHub#447: GitHub took the close: the panel puts itself away, the result shows in the strip at the top of the window
  const stripped = (n: number) => page.locator(`[data-testid="notice-area"] [data-testid="op-notice"][data-key="gigleai/cavil-loop#${n}"]`);
  await expect(detail).toHaveCount(0, { timeout: 15_000 });
  await expect(stripped(137)).toHaveAttribute('data-kind', 'ok');
  await expect(stripped(137).getByTestId('op-notice-text')).toHaveText('issue #137 已关闭（不计划），评论已发出');
  expect(writes()).toEqual([
    ['PATCH', '/api/repos/GigleAI/cavil-loop/issues/137', { state: 'closed', state_reason: 'not_planned' }],
    ['POST', '/api/repos/GigleAI/cavil-loop/issues/137/comments', { body: '不做了' }],
  ]);
  // badge, card and table row all grey (GitHub: not planned), and the close entry is gone
  await expect(card(page, 137).getByTestId('card-state')).toHaveAttribute('data-tone', 'neutral');
  await open(137);
  await expect(badge).toHaveAttribute('data-tone', 'neutral');
  await expect(badge).toHaveText('Issue·已关闭（不计划）');
  await expect(page.getByTestId('close-issue')).toHaveCount(0);
  await shot(page, '52-issue-closed');
  await hide.click();
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await page.getByTestId('search').fill('#137');
  await expect(page.locator('[data-testid="row"][data-key="gigleai/cavil-loop#137"] [data-testid="row-state"]').first()).toHaveAttribute('data-tone', 'neutral');
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();

  // ---- 4. "completed" (the default) without a comment: one PATCH, purple ----
  await open(139);
  await page.getByTestId('close-issue').click();
  await page.getByTestId('confirm-ok').click();
  await expect(detail).toHaveCount(0, { timeout: 15_000 });
  await expect(stripped(139).getByTestId('op-notice-text')).toHaveText('issue #139 已关闭（已完成）');
  expect(writes().slice(2)).toEqual([['PATCH', '/api/repos/GigleAI/cavil-loop/issues/139', { state: 'closed', state_reason: 'completed' }]]);
  await open(139);
  await expect(badge).toHaveAttribute('data-tone', 'done');
  await hide.click();

  // ---- 5. offline: the close entry greys out, nothing sent ----
  openOnGitHub(139);
  await page.getByTestId('refresh').click();
  await open(139);
  await expect(page.getByTestId('close-issue')).toBeEnabled();
  const before = env.fake.writes().length;
  env.fake.state.offline = true;
  // from the keyboard: a click on the toolbar would put the panel away (GitHub#191)
  await page.getByTestId('refresh').press('Enter');
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('close-issue')).toBeDisabled();
  await expect(page.getByTestId('close-issue')).toHaveAttribute('title', '离线时不能修改');
  expect(env.fake.writes()).toHaveLength(before);
  await app.close();
});

test('GitHub#191: a click outside the detail puts it away; cards and row titles switch; not inside, not with a dialog up, not with a reply typed', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  for (const n of [137, 138]) {
    const c = findCopies(store, 'GigleAI/cavil-loop', n)!;
    for (const g of c.gql) Object.assign(g, { state: 'OPEN', stateReason: null });
    for (const r of c.rest) Object.assign(r, { state: 'open', state_reason: null });
  }
  // two entries on #138, so its detail has the "unfold all" switch
  env.fake.state.w.comments.set('gigleai/cavil-loop#138', [
    { id: 'C-191', url: 'https://github.com/GigleAI/cavil-loop/issues/138#c1', createdAt: '2026-11-01T01:00:00Z', bodyHTML: '<p>a comment</p>', author: { login: 'user-2' } },
  ]);
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const detail = page.getByTestId('detail');
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  /** a blank spot of the window outside the panel: the head of the leftmost column (not a card) */
  const outside = () => page.locator('[data-testid="column"] .column-head').first().click({ position: { x: 4, y: 4 } });
  const open = async (n: number) => {
    await card(page, n).click();
    await expect(detail).toHaveAttribute('data-key', `gigleai/cavil-loop#${n}`);
    await expect(frame.locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
  };
  const stays = async (n: number) => {
    await page.waitForTimeout(200);
    await expect(detail).toHaveAttribute('data-key', `gigleai/cavil-loop#${n}`);
  };

  // ---- 1. a plain click outside puts it away; nothing is sent ----
  await open(137);
  await outside();
  await expect(detail).toHaveCount(0);
  // the top bar is outside too
  await open(137);
  await page.getByTestId('topbar').click({ position: { x: 4, y: 4 } });
  await expect(detail).toHaveCount(0);
  // pressed just above the panel's top edge, let go just inside it (2px): the panel stays
  // (the click itself goes to the common ancestor; PR #199 review round 1)
  await open(137);
  {
    const b = (await detail.boundingBox())!;
    const x = b.x + 40;
    const [above, inside] = [Math.floor(b.y) - 1, Math.ceil(b.y) + 1];
    // the two points really are on either side of the edge, and the one above is not a card
    const hit = (y: number) =>
      page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py);
        return { inPanel: !!el?.closest('[data-testid="detail"]'), card: !!el?.closest('[data-opens-item]') };
      }, [x, y]);
    expect(await hit(above)).toEqual({ inPanel: false, card: false });
    expect((await hit(inside)).inPanel).toBe(true);
    await page.mouse.move(x, above);
    await page.mouse.down();
    await page.mouse.move(x, inside);
    await page.mouse.up();
    await stays(137);
    // …and the same press let go where it started still puts it away
    await page.mouse.move(x, above);
    await page.mouse.down();
    await page.mouse.up();
    await expect(detail).toHaveCount(0);
  }

  // ---- 2. another card switches; the same card keeps this opening (its unfold state survives) ----
  await open(137);
  await card(page, 138).click();
  await stays(138);
  await page.getByTestId('unfold-toggle').click();
  await expect(page.getByTestId('unfold-toggle')).toHaveAttribute('data-unfold', 'all');
  await card(page, 138).click();
  await stays(138);
  await expect(page.getByTestId('unfold-toggle')).toHaveAttribute('data-unfold', 'all');

  // ---- 3. inside the panel; a selection dragged from inside to outside ----
  await detail.locator('.detail-title').click();
  await detail.locator('.detail-head').click({ position: { x: 4, y: 4 } });
  await stays(138);
  const title = await detail.locator('.detail-title').boundingBox();
  const head = await page.locator('[data-testid="column"] .column-head').first().boundingBox();
  await page.mouse.move(title!.x + title!.width / 2, title!.y + title!.height / 2);
  await page.mouse.down();
  await page.mouse.move(head!.x + 4, head!.y + 4, { steps: 5 });
  await page.mouse.up();
  await stays(138);
  // the resize edge: dragged and let go
  const edge = await page.getByTestId('detail-resize').boundingBox();
  await page.mouse.move(edge!.x + edge!.width / 2, edge!.y + 40);
  await page.mouse.down();
  await page.mouse.move(edge!.x - 60, edge!.y + 40, { steps: 5 });
  await page.mouse.up();
  await stays(138);

  // ---- 4. a typed reply keeps the panel (and the reply); an emptied one does not ----
  await detail.getByTestId('reply-input').fill('还没写完');
  await outside();
  await stays(138);
  await expect(detail.getByTestId('reply-input')).toHaveValue('还没写完');
  await detail.getByTestId('reply-input').fill('');
  await outside();
  await expect(detail).toHaveCount(0);

  // ---- 5. the panel's own dialog: its backdrop closes the dialog only; the next click outside hides ----
  await open(137);
  await page.getByTestId('close-issue').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await dialog.click({ position: { x: 4, y: 4 } });
  await expect(dialog).toHaveCount(0);
  await stays(137);
  await outside();
  await expect(detail).toHaveCount(0);

  // ---- 6. the board's own dialog ("加入看板？", dropping a card that is on no board) ----
  await open(137);
  // the panel floats over the right of the board: bring the last iteration column to the left
  // edge, so it and 未加入看板 next to it are both clear of the panel, then drop an unboarded card there
  const titles = await page.locator('[data-testid="column"]').evaluateAll((cs) => cs.map((c) => c.getAttribute('data-title') ?? ''));
  const target = titles.slice(0, titles.indexOf('未加入看板')).filter((t) => t.startsWith('Iteration')).pop()!;
  const targetCol = page.locator(`[data-testid="column"][data-title="${target}"]`);
  await targetCol.evaluate((el) => el.scrollIntoView({ inline: 'start', block: 'nearest' }));
  const panelLeft = (await detail.boundingBox())!.x;
  const unboarded = page.locator('[data-testid="column"][data-title="未加入看板"] [data-testid="card"]').first();
  const ub = (await unboarded.boundingBox())!;
  expect(ub.x + ub.width).toBeLessThan(panelLeft);
  await unboarded.dragTo(targetCol);
  await expect(page.getByTestId('confirm-question')).toContainText('还没加入看板');
  await stays(137);
  await shot(page, '60-outside-click-board-dialog');
  await dialog.click({ position: { x: 4, y: 4 } });
  await expect(dialog).toHaveCount(0);
  await stays(137);
  await outside();
  await expect(detail).toHaveCount(0);

  // ---- 6b. the shortcut list (?) is a dialog too: its backdrop closes it, not the panel ----
  await open(137);
  await detail.locator('.detail-title').click();
  await page.keyboard.press('?');
  const help = page.getByTestId('shortcut-help');
  await expect(help).toBeVisible();
  await help.click({ position: { x: 4, y: 4 } });
  await expect(help).toHaveCount(0);
  await stays(137);
  await outside();
  await expect(detail).toHaveCount(0);

  // ---- 7. the table: a row title opens / switches; a click elsewhere hides ----
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  const rowTitle = (n: number) => page.locator(`[data-testid="row"][data-key="gigleai/cavil-loop#${n}"] [data-testid="row-title"]`).first();
  await rowTitle(137).click();
  await stays(137);
  await rowTitle(138).click();
  await stays(138);
  // the same row title again keeps this opening: its unfold state survives
  await page.getByTestId('unfold-toggle').click();
  await expect(page.getByTestId('unfold-toggle')).toHaveAttribute('data-unfold', 'all');
  await rowTitle(138).click();
  await stays(138);
  await expect(page.getByTestId('unfold-toggle')).toHaveAttribute('data-unfold', 'all');
  // a spot of the table page outside the title cells is outside too: the repository list's heading on the left
  // (the panel covers every other column; the title cell itself opens, GitHub#257)
  await page.locator('[data-testid="slices"] > .small.muted').click();
  await expect(detail).toHaveCount(0);

  expect(env.fake.writes()).toEqual([]);
  await app.close();
});

// ---- GitHub#192: keyboard shortcuts. Keys are pressed in the real window; what counts is what
// the screen shows and what the fake GitHub received. Ctrl stands for ⌘ off macOS (both work). ----
const MOD = 'ControlOrMeta';
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const lastOnline = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).state.sync.lastOnlineAt as number | null);

test('GitHub#257: the whole title cell of a table row opens the detail — icon, number, blank space, a nested PR\'s indent; switches without hiding; other cells unchanged', async () => {
  // two entries on #138, so its detail has the "unfold all" switch
  env.fake.state.w.comments.set('gigleai/cavil-loop#138', [
    { id: 'C-257', url: 'https://github.com/GigleAI/cavil-loop/issues/138#c1', createdAt: '2026-11-01T01:00:00Z', bodyHTML: '<p>a comment</p>', author: { login: 'user-2' } },
  ]);
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const detail = page.getByTestId('detail');
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  // PRs right under their issue need a grouping the recorded pairs share
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('status');
  await page.getByTestId('open-view-panel').click();
  const rowOf = (k: string) => page.locator(`[data-testid="row"][data-key="${k}"]`).first();
  const cellOf = (k: string) => rowOf(k).getByTestId('title-cell');
  const [a, b, c] = [137, 139, 138].map((n) => `gigleai/cavil-loop#${n}`);
  const opened = async (k: string) => {
    await expect(detail).toHaveAttribute('data-key', k);
    await expect(frame.locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
  };

  // the hand cursor on the whole cell, not only on the words
  expect(await cellOf(a).evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');

  // 1. the blank right end of the cell
  const box = (await cellOf(a).boundingBox())!;
  const words = (await rowOf(a).getByTestId('row-title').boundingBox())!;
  const num = (await rowOf(a).locator('.title-cell .muted.small').boundingBox())!;
  expect(box.x + box.width - 4).toBeGreaterThan(Math.max(words.x + words.width, num.x + num.width));
  await cellOf(a).click({ position: { x: box.width - 4, y: box.height / 2 } });
  await opened(a);

  // 2. the state icon and the "repo #number" text of another row: switches, never hides first
  await rowOf(b).getByTestId('row-state').click();
  await page.waitForTimeout(200);
  await expect(detail).toHaveAttribute('data-key', b);
  await rowOf(c).locator('.title-cell .muted.small').click();
  await page.waitForTimeout(200);
  await expect(detail).toHaveAttribute('data-key', c);

  // 3. the same cell again keeps this opening (its unfold state survives)
  await opened(c);
  const unfold = page.getByTestId('unfold-toggle');
  await expect(unfold).toHaveCount(1);
  await unfold.click();
  await expect(unfold).toHaveAttribute('data-unfold', 'all');
  await cellOf(c).click({ position: { x: (await cellOf(c).boundingBox())!.width - 4, y: 6 } });
  await page.waitForTimeout(200);
  await expect(detail).toHaveAttribute('data-key', c);
  await expect(unfold).toHaveAttribute('data-unfold', 'all');

  // 4. a PR nested under its issue: the indent left of the ↳ mark opens the PR
  const nested = page.locator('[data-testid="row"][data-under]').first();
  const prKey = (await nested.getAttribute('data-key'))!;
  const nb = (await nested.getByTestId('title-cell').boundingBox())!;
  const mark = (await nested.locator('.nest-mark').boundingBox())!;
  expect(mark.x - nb.x).toBeGreaterThan(16);
  await nested.getByTestId('title-cell').click({ position: { x: 6, y: nb.height / 2 } });
  await page.waitForTimeout(200);
  await expect(detail).toHaveAttribute('data-key', prKey);

  // 5. the title link still works from the keyboard: focus it, Enter opens that row
  await rowOf(a).getByTestId('row-title').focus();
  await page.keyboard.press('Enter');
  await opened(a);

  // 6. outside the title cells (the repository list's heading; the panel covers the other columns) puts it away
  await page.locator('[data-testid="slices"] > .small.muted').click();
  await expect(detail).toHaveCount(0);
  // with the panel away: a cell that cannot be edited opens nothing; an editable one still edits in place
  await rowOf(b).locator('[data-testid="cell"][data-col="updated"]').click();
  await page.waitForTimeout(200);
  await expect(detail).toHaveCount(0);
  const labels = rowOf(b).locator('[data-testid="cell"][data-col="labels"]');
  await labels.click();
  await expect(labels).toHaveAttribute('data-editing', 'yes');
  await expect(detail).toHaveCount(0);
  await shot(page, '257-title-cell');

  expect(env.fake.writes()).toEqual([]);
  await app.close();
});

test('GitHub#192: shortcuts — nothing before sign-in; global keys on every signed-in page; a board request runs once', async () => {
  const { app, page } = await launch(env);
  const help = page.getByTestId('shortcut-help');
  const dialog = page.getByTestId('confirm-dialog');
  const search = page.getByTestId('search');

  // ---- 1. the login page: no key does anything ----
  await expect(page.getByTestId('login')).toBeVisible();
  for (const k of ['/', 'c', '?', `${MOD}+,`]) await page.keyboard.press(k);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('login')).toBeVisible();
  await expect(help).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('settings')).toHaveCount(0);

  await signInWithSources(page);
  await blur(page);

  // ---- 2. the board: "?" lists every shortcut of the one table; Esc closes it ----
  await page.keyboard.press('?');
  await expect(help).toBeVisible();
  expect(await help.getByTestId('shortcut-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-id')))).toEqual([
    'search', 'newIssue', 'sync', 'settings', 'help', 'viewBoard', 'viewTable', 'viewGraph', 'closeTab', 'nextTab', 'prevTab', 'tabAt', 'find', 'findNext', 'findPrev', 'confirm', 'cancel', 'newIssueAgent', 'newIssueAutopilot', 'labels', 'milestone', 'reply', 'closeIssue', 'handBack', 'autopilot', 'blocked', 'hide',
    'graphFit', 'graphZoomIn', 'graphZoomOut', 'settingsBack', 'send', 'preview', 'leaveReply', 'pickerUp', 'pickerDown', 'pickerToggle', 'pickerClose', 'helpClose',
    // GitHub#502: the find bar's own keys
    'findBarNext', 'findBarPrev', 'findBarClose',
  ]);
  await shot(page, '60-shortcut-list');
  // the list takes every key while it is up: "/" does not reach the search box
  await page.keyboard.press('/');
  await expect(search).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await page.keyboard.press('?');
  await expect(help).toBeVisible();
  await page.keyboard.press('?');
  await expect(help).toHaveCount(0);

  // ---- 3. "/" jumps to the search box without typing a "/"; letters typed there are just text ----
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await page.keyboard.type('lmcr?/');
  await expect(search).toHaveValue('lmcr?/');
  await expect(dialog).toHaveCount(0);
  await expect(help).toHaveCount(0);
  await search.fill('');
  // ⌘R and ⌘, act even while typing
  const t0 = await lastOnline(page);
  await page.waitForTimeout(20);
  await page.keyboard.press(`${MOD}+r`);
  await expect.poll(() => lastOnline(page), { timeout: 15_000 }).not.toBe(t0);
  await expect(page.getByTestId('board')).toBeVisible();
  await blur(page);

  // ---- 4. "C": new issue. Esc with typed text keeps it (and says why); empty, Esc cancels; ⌘↩ creates ----
  await page.keyboard.press('c');
  await expect(dialog).toBeVisible();
  await page.getByTestId('new-issue-title').fill('KEYS_NEW');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('dialog-esc-hint')).toBeVisible();
  await expect(page.getByTestId('new-issue-title')).toHaveValue('KEYS_NEW');
  await page.getByTestId('new-issue-title').fill('');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(env.fake.writes()).toEqual([]);
  await page.keyboard.press('c');
  await page.getByTestId('new-issue-title').fill('KEYS_NEW');
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  // GitHub#229: the dialog closes before GitHub answers — wait for the write itself
  await expect.poll(() => env.fake.writes().filter((w) => w.method === 'POST' && w.path === '/api/repos/GigleAI/cavil-loop/issues').map((w) => (w.body as { title?: string } | undefined)?.title)).toEqual(['KEYS_NEW']);
  await page.getByTestId('detail-close').click();
  await blur(page);

  // ---- 5. Settings (⌘,): every global key still works there ----
  const settings = page.getByTestId('settings');
  await page.keyboard.press(`${MOD}+,`);
  await expect(settings).toBeVisible();
  // "/": back to the board, the search box focused
  await page.keyboard.press('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(search).toBeFocused();
  await blur(page);
  // "C": back to the board, the new-issue dialog up
  await page.keyboard.press(`${MOD}+,`);
  await expect(settings).toBeVisible();
  await page.keyboard.press('c');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // ⌘R: a sync round, the page stays; "?": the list over the settings page
  await page.keyboard.press(`${MOD}+,`);
  await expect(settings).toBeVisible();
  const t1 = await lastOnline(page);
  await page.waitForTimeout(20);
  await page.keyboard.press(`${MOD}+r`);
  await expect.poll(() => lastOnline(page), { timeout: 15_000 }).not.toBe(t1);
  await expect(settings).toBeVisible();
  await page.keyboard.press('?');
  await expect(help).toBeVisible();
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  // GitHub#369: the list took that Esc — the settings page is still up
  await expect(settings).toBeVisible();
  await shot(page, '61-settings-after-keys');
  // GitHub#369: in a text field the first Esc only leaves the field (which saves it), the second goes back
  const agentLabel = page.getByTestId('hand-back-agent');
  const originalAgent = await agentLabel.inputValue();
  expect(originalAgent).not.toBe('');
  await agentLabel.click();
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  await page.keyboard.press('Escape');
  await expect(agentLabel).not.toBeFocused();
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(settings).toHaveCount(0);
  // saved when the field was left: reopened, the settings show it; then it is put back the same way
  await page.keyboard.press(`${MOD}+,`);
  await expect(settings).toBeVisible();
  await expect(page.getByTestId('hand-back-agent')).toHaveValue(`${originalAgent}X`);
  await page.getByTestId('hand-back-agent').fill(originalAgent);
  await page.getByTestId('hand-back-agent').blur();
  await page.getByTestId('back').click();
  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId('hand-back-agent')).toHaveValue(originalAgent);
  // nothing focused: one Esc goes back to the board
  await blur(page);
  await page.keyboard.press('Escape');
  // the earlier "/" and "C" were done once: back on the board, nothing repeats
  await expect(page.getByTestId('board')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
  await expect(search).not.toBeFocused();

  // ---- 6. the app-kind page (from Settings) takes the global keys too ----
  await page.getByTestId('open-settings').click();
  await page.getByTestId('app-kind-help-link').click();
  await expect(page.getByTestId('app-kind-help')).toBeVisible();
  await blur(page);
  await page.keyboard.press('?');
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('/');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(search).toBeFocused();
  await app.close();
});

test('GitHub#192: shortcuts in the detail — reply ⌘↩, Esc never drops a draft, the label / milestone pickers send one change each, a dialog takes the keys first', async () => {
  // #137 open on GitHub on every copy, whatever the recorded fixture captured (its "close issue" is used at the end)
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const c137 = findCopies(store, 'GigleAI/cavil-loop', 137)!;
  for (const g of c137.gql) Object.assign(g, { state: 'OPEN', stateReason: null });
  for (const r of c137.rest) Object.assign(r, { state: 'open', state_reason: null });
  env.fake.state.w.milestones.set('gigleai/cavil-loop', [{ number: 1, title: 'v1', state: 'open', due_on: null }]);
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const detail = page.getByTestId('detail');
  const reply = detail.getByTestId('reply-input');
  const picker = detail.getByTestId('label-picker');
  const dialog = page.getByTestId('confirm-dialog');
  const open137 = async () => {
    await card(page, 137).click();
    await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
    await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
    await expect(detail.getByTestId('label-add')).toBeEnabled();
    await blur(page);
  };
  const replyFocused = () => reply.evaluate((el) => el === document.activeElement);
  await open137();

  // ---- 1. R: to the reply box; letters typed there are text, never shortcuts ----
  await page.keyboard.press('r');
  await expect(reply).toBeFocused();
  await page.keyboard.type('lmc/?r');
  await expect(reply).toHaveValue('lmc/?r');
  await expect(picker).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('shortcut-help')).toHaveCount(0);

  // ---- 2. an input method still composing: ⌘↩ and Esc are its keys, not ours ----
  for (const key of ['Enter', 'Escape'])
    await reply.evaluate((el, key) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: key === 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    }, key);
  await page.waitForTimeout(500);
  expect(env.fake.writes()).toEqual([]);
  await expect(reply).toBeFocused();
  await expect(reply).toHaveValue('lmc/?r');

  // ---- 3. ⌘↩ sends (the send button's own action); blank text: nothing, like the greyed button ----
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(sendNotice(page).first().getByTestId('send-notice-text')).toHaveText('评论已发出');
  expect(writes()).toEqual([['POST', '/api/repos/GigleAI/cavil-loop/issues/137/comments', { body: 'lmc/?r' }]]);
  await expect(reply).toHaveValue('');
  await reply.fill('   ');
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(500);
  expect(writes()).toHaveLength(1);
  await expect(page.getByTestId('action-result')).toHaveCount(0); // no "empty comment" refusal either
  // ⌘⇧P: preview and back
  await reply.fill('**PREVIEW_KEY**');
  await page.keyboard.press(`${MOD}+Shift+KeyP`);
  await expect(page.frameLocator('[data-testid="reply-preview"]').locator('body')).toContainText('PREVIEW_KEY');
  await page.keyboard.press(`${MOD}+Shift+KeyP`);
  await expect(page.getByTestId('reply-preview')).toHaveCount(0);

  // ---- 4. Esc and an unsent reply: the text is never dropped by a key ----
  const hint = page.getByTestId('draft-esc-hint');
  await reply.fill('方案收到');
  await page.keyboard.press('Escape'); // leaves the reply box
  expect(await replyFocused()).toBe(false);
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  await expect(hint).toHaveCount(0);
  await page.keyboard.press('Escape'); // the panel stays, and says why
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  await expect(hint).toBeVisible();
  await expect(reply).toHaveValue('方案收到');
  await shot(page, '62-esc-keeps-draft');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  await expect(reply).toHaveValue('方案收到');
  // cleared: Esc leaves the box, the next Esc puts the panel away; reopened, the box is empty
  await reply.fill('');
  await expect(hint).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await open137();
  await expect(reply).toHaveValue('');
  // an empty box from the start: R, Esc (leaves), Esc (puts away)
  await page.keyboard.press('r');
  await expect(reply).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await open137();

  // ---- 5. L: the label picker. Typing filters (even "c" or "/"); ↑↓ choose; one Enter = one add or one remove ----
  const before = writes().length;
  await page.keyboard.press('l');
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId('picker-filter')).toBeFocused();
  await page.keyboard.type('pending/');
  await expect(dialog).toHaveCount(0);
  const items = picker.getByTestId('picker-item');
  expect(await items.count()).toBeGreaterThan(1);
  const active = () => picker.locator('[data-testid="picker-item"][data-active="yes"]').getAttribute('data-name');
  for (let i = 0; i < 20 && (await active()) !== 'pending/PR'; i++) await page.keyboard.press('ArrowDown');
  expect(await active()).toBe('pending/PR');
  await expect(picker.locator('[data-name="pending/PR"]')).toHaveAttribute('data-checked', 'no');
  await shot(page, '63-label-picker');
  await page.keyboard.press('Enter');
  await expect(picker.locator('[data-name="pending/PR"]')).toHaveAttribute('data-checked', 'yes', { timeout: 15_000 });
  await expect(picker).toBeVisible(); // stays open for the next one
  // GitHub#229: ticked before GitHub answers — wait for the write itself
  await expect.poll(() => writes().slice(before)).toEqual([['POST', '/api/repos/GigleAI/cavil-loop/issues/137/labels', { labels: ['pending/PR'] }]]);
  expect(await active()).toBe('pending/PR');
  await page.keyboard.press('Enter');
  await expect(picker.locator('[data-name="pending/PR"]')).toHaveAttribute('data-checked', 'no', { timeout: 15_000 });
  await expect.poll(() => writes().slice(before)).toEqual([
    ['POST', '/api/repos/GigleAI/cavil-loop/issues/137/labels', { labels: ['pending/PR'] }],
    ['DELETE', '/api/repos/GigleAI/cavil-loop/issues/137/labels/pending%2FPR', undefined],
  ]);
  // Esc puts the picker away, and only the picker
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');

  // ---- 6. M: the milestone picker; Enter sets it and closes ----
  await page.keyboard.press('m');
  const ms = detail.getByTestId('milestone-picker');
  await expect(ms).toBeVisible();
  await page.keyboard.type('v1');
  await page.keyboard.press('Enter');
  await expect(ms).toHaveCount(0);
  await savedQuietly(page, sentTo('PATCH', '/issues/137'), before + 2);
  expect(writes().slice(before + 2).map(([m, p]) => [m, p])).toEqual([['PATCH', '/api/repos/GigleAI/cavil-loop/issues/137']]);

  // ---- 7. a dialog on top takes every key: nothing behind it reacts ----
  await page.getByTestId('close-issue').click();
  await expect(dialog).toBeVisible();
  const n = writes().length;
  for (const k of ['/', 'c', 'l', 'm', 'r', '?']) await page.keyboard.press(k);
  await page.waitForTimeout(300);
  await expect(picker).toHaveCount(0);
  await expect(detail.getByTestId('milestone-picker')).toHaveCount(0);
  await expect(page.getByTestId('shortcut-help')).toHaveCount(0);
  await expect(page.getByTestId('search')).not.toBeFocused();
  await expect(reply).not.toBeFocused();
  await expect(page.locator('[data-testid="confirm-dialog"]')).toHaveCount(1);
  // a plain Enter, even on the confirm button, does not confirm: only a click or ⌘↩ does
  await page.getByTestId('confirm-ok').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await expect(dialog).toBeVisible();
  expect(writes()).toHaveLength(n);
  // Esc cancels the dialog only
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  // ⌘↩ confirms: the close goes out
  await page.getByTestId('close-issue').click();
  await page.keyboard.press(`${MOD}+Enter`);
  // GitHub#447: GitHub took it: the panel puts itself away, the result shows in the strip at the top of the window
  await expect(detail).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"][data-key="gigleai/cavil-loop#137"]').getByTestId('op-notice-text')).toHaveText('issue #137 已关闭（已完成）');
  expect(writes().slice(n)).toEqual([['PATCH', '/api/repos/GigleAI/cavil-loop/issues/137', { state: 'closed', state_reason: 'completed' }]]);
  await app.close();
});

// ---- GitHub#193: ticking a choice in the detail ----

const QUESTION193 = '**Q1: 换手机后怎么找回？**（默认 A）\n\n- [ ] **A. 导出文件** — 手动\n- [ ] **B. 云端** — 自动\n\n```\n- [ ] 代码块里的不是选项\n```\n';
/** raw HTML the frame must never run: an inline script, an error handler, a click handler (each would report itself) */
const INJECTED193 =
  '<p>INJECTED</p><script>parent.postMessage({cavil:"pwned-script"},"*")</script>' +
  '<img alt="i" src="data:image/png;base64,xx" onerror="parent.postMessage({cavil:\'pwned-onerror\'},\'*\')">' +
  '<button id="inj" onclick="parent.postMessage({cavil:\'pwned-onclick\'},\'*\')">inj</button>';

test('GitHub#193: tick a choice in the detail — one character changes on GitHub; someone else\'s edit is never overwritten; read-only / offline boxes stay put; only the frame\'s own script runs', async () => {
  const w = env.fake.state.w;
  const at = (d: number) => `2026-11-0${d}T01:00:00Z`;
  const url = (id: string) => `https://github.com/GigleAI/cavil-loop/issues/138#${id}`;
  w.comments.set('gigleai/cavil-loop#138', [
    { id: 'C_RO', url: url('C_RO'), createdAt: at(2), bodyHTML: '', author: { login: 'user-2' }, body: QUESTION193 },
    { id: 'C_INJ', url: url('C_INJ'), createdAt: at(3), bodyHTML: INJECTED193, author: { login: 'user-3' } },
    { id: 'C_Q', url: url('C_Q'), createdAt: at(4), bodyHTML: '', author: { login: 'user-4' }, body: QUESTION193 },
  ]);
  w.cannotUpdate.add('C_RO');
  const sourceOfQ = () => w.comments.get('gigleai/cavil-loop#138')!.find((c) => c.id === 'C_Q')!.body;
  const { app, page } = await launch(env);
  // every message the window receives, by kind (the frame's script reports "ready" when it ran)
  await page.evaluate(() => {
    (window as any).__msgs = [];
    window.addEventListener('message', (e) => (window as any).__msgs.push(e.data?.cavil));
  });
  const msgs = () => page.evaluate(() => (window as any).__msgs as string[]);
  await signInWithSources(page);
  await card(page, 138).click();
  const iframe = page.getByTestId('timeline-frame');
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  await expect(iframe).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  const box = (entry: string, i: number) => frame.locator(`details.entry[data-entry="${entry}"] input[data-task="${i}"]`);

  // ---- 1. the trusted script ran; nothing GitHub's HTML carries does, even opened and clicked ----
  await frame.locator('details.entry[data-entry="C_INJ"] > summary').click({ position: { x: 40, y: 10 } });
  await expect(frame.locator('#inj')).toBeVisible();
  await frame.locator('#inj').click();
  await page.waitForTimeout(500);
  expect(await msgs()).toContain('ready');
  expect((await msgs()).filter((m) => /^pwned/.test(String(m)))).toEqual([]);
  // the task boxes look like GitHub's: no list bullet
  expect(await box('C_Q', 0).evaluate((el) => getComputedStyle(el.closest('li')!).listStyleType)).toBe('none');

  // ---- 2. a comment this account may not change: its boxes are read-only and say why ----
  await frame.locator('details.entry[data-entry="C_RO"] > summary').click({ position: { x: 40, y: 10 } });
  await expect(box('C_RO', 0)).toBeDisabled();
  await expect(frame.locator('details.entry[data-entry="C_RO"] [data-testid="task-readonly"]')).toHaveText('GitHub 说你没有权限改这一条，勾选框只读');
  await box('C_RO', 0).click({ force: true });
  await page.waitForTimeout(300);
  expect(env.fake.writes()).toEqual([]);
  await shot(page, '60-task-boxes');

  // ---- 3. tick A: GitHub gets the comment with exactly that box changed ----
  await expect(box('C_Q', 0)).toBeEnabled();
  await box('C_Q', 0).click();
  // GitHub#489: the box shows it itself — nothing is said when it simply went through
  const ticked = QUESTION193.replace('- [ ] **A.', '- [x] **A.');
  await expect.poll(() => sourceOfQ()).toBe(ticked);
  expect(writes()).toEqual([['CavilUpdateComment', '/api/graphql', { id: 'C_Q', body: ticked }]]);
  expect(sourceOfQ()).toBe(ticked);
  // re-read: A shown ticked, B not; the entries opened before are still open; hand back is offered
  await expect(box('C_Q', 0)).toBeChecked();
  await expect(box('C_Q', 1)).not.toBeChecked();
  await expect(iframe).toHaveAttribute('data-ready', 'yes');
  expect(await frame.locator('details.entry').evaluateAll((els) => els.filter((e) => (e as HTMLDetailsElement).open).map((e) => e.getAttribute('data-entry')))).toEqual([
    'C_Q',
    'C_INJ',
    'C_RO',
  ]);
  await expect(page.getByTestId('hand-back')).toBeVisible();
  await shot(page, '61-task-ticked');

  // ---- 4. somebody edits the comment on the web meanwhile: the click is refused, their text stays ----
  const theirs = ticked.replace('- [ ] **B.', '- [x] **B.').replace('— 自动', '— 自动（改过）');
  w.comments.get('gigleai/cavil-loop#138')!.find((c) => c.id === 'C_Q')!.body = theirs;
  // the window still shows the old text: B unticked
  await expect(box('C_Q', 1)).not.toBeChecked();
  await box('C_Q', 1).click();
  // GitHub#489: the refusal is said in the window's notice area
  await expect(sendNotice(page).first()).toHaveAttribute('data-kind', 'error');
  await expect(sendNotice(page).first().getByTestId('send-notice-text')).toHaveText(`勾选没有保存上：${TASK_CHANGED193}`);
  expect(env.fake.writes()).toHaveLength(1);
  expect(sourceOfQ()).toBe(theirs);
  // read again: what GitHub holds now
  await expect(frame.locator('details.entry[data-entry="C_Q"] .md')).toContainText('自动（改过）');
  await expect(box('C_Q', 1)).toBeChecked();

  // ---- 5. messages the window drops: not from the frame, or from an older rendering; the same from the frame goes through ----
  const render = (await iframe.getAttribute('data-render'))!;
  await page.evaluate((r) => window.postMessage({ cavil: 'task', render: r, entry: 'C_Q', index: 0, checked: false, view: { open: [], scroll: 0 } }, '*'), render);
  const inFrame = page.frames().find((f) => f !== page.mainFrame() && f.url() === 'about:srcdoc')!;
  await inFrame.evaluate(() => parent.postMessage({ cavil: 'task', render: 'r0', entry: 'C_Q', index: 0, checked: false, view: { open: [], scroll: 0 } }, '*'));
  await page.waitForTimeout(500);
  expect(env.fake.writes()).toHaveLength(1);
  await inFrame.evaluate((r) => parent.postMessage({ cavil: 'task', render: r, entry: 'C_Q', index: 0, checked: false, view: { open: [], scroll: 0 } }, '*'), render);
  await expect.poll(() => env.fake.writes().length).toBe(2);
  expect(sourceOfQ()).toBe(theirs.replace('- [x] **A.', '- [ ] **A.'));

  // ---- 6. offline: every box greys out, nothing sent ----
  env.fake.state.offline = true;
  // from the keyboard: a click on the toolbar would put the panel away (GitHub#191)
  await page.getByTestId('refresh').press('Enter');
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(box('C_Q', 0)).toBeDisabled();
  await expect(box('C_Q', 1)).toBeDisabled();
  expect(env.fake.writes()).toHaveLength(2);
  expect((await msgs()).filter((m) => /^pwned/.test(String(m)))).toEqual([]);
  await app.close();
});

// ---- GitHub#358: a ticked box is grey until GitHub confirmed it ----

test('GitHub#358: a clicked box shows grey at once and blue once GitHub confirmed; meanwhile no box of the discussion takes a click; a refused click is taken back', async () => {
  const w = env.fake.state.w;
  const url = (id: string) => `https://github.com/GigleAI/cavil-loop/issues/138#${id}`;
  w.comments.set('gigleai/cavil-loop#138', [
    { id: 'C_OLD', url: url('C_OLD'), createdAt: '2026-11-03T01:00:00Z', bodyHTML: '', author: { login: 'user-3' }, body: QUESTION193 },
    { id: 'C_Q', url: url('C_Q'), createdAt: '2026-11-04T01:00:00Z', bodyHTML: '', author: { login: 'user-4' }, body: QUESTION193.replace('- [ ] **B.', '- [x] **B.') },
  ]);
  const source = (id: string) => w.comments.get('gigleai/cavil-loop#138')!.find((c) => c.id === id)!.body;
  const { app, page } = await launch(env);
  await signInWithSources(page);
  await card(page, 138).click();
  const iframe = page.getByTestId('timeline-frame');
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  await expect(iframe).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  await page.getByTestId('unfold-toggle').click();
  await expect(iframe).toHaveAttribute('data-ready', 'yes');
  const box = (entry: string, i: number) => frame.locator(`details.entry[data-entry="${entry}"] input[data-task="${i}"]`);
  const fill = (entry: string, i: number) => box(entry, i).evaluate((el) => getComputedStyle(el).backgroundColor);
  const waiting = () => frame.locator('input[data-pending]');
  await expect(box('C_Q', 0)).toBeEnabled();
  await expect(box('C_OLD', 0)).toBeEnabled();
  await expect(waiting()).toHaveCount(0);
  // a confirmed tick is the accent colour; an empty box is the page's background
  const blue = await fill('C_Q', 1);
  const empty = await fill('C_Q', 0);
  expect(blue).not.toBe(empty);

  // ---- 1. tick A while GitHub does not answer: grey tick at once, every box of both comments stops taking clicks ----
  let release = env.fake.holdWhen((e) => e.operation === 'CavilUpdateComment');
  await box('C_Q', 0).click();
  await expect(waiting()).toHaveCount(1);
  await expect(box('C_Q', 0)).toHaveAttribute('data-pending', '');
  await expect(box('C_Q', 0)).toBeChecked();
  // the window rendered the frame again with the click still on its way (not only the frame's own mark)
  await expect.poll(async () => (await iframe.getAttribute('data-ready')) === 'yes' && (await waiting().count()) === 1 && (await box('C_Q', 0).isChecked())).toBe(true);
  await page.waitForTimeout(600);
  await expect(box('C_Q', 0)).toBeChecked();
  await expect(waiting()).toHaveCount(1);
  const grey = await fill('C_Q', 0);
  expect(grey).not.toBe(blue);
  expect(grey).not.toBe(empty);
  for (const [e, i] of [['C_Q', 0], ['C_Q', 1], ['C_OLD', 0], ['C_OLD', 1]] as const) await expect(box(e, i)).toBeDisabled();
  // the other boxes keep what GitHub holds
  await expect(box('C_Q', 1)).toBeChecked();
  await expect(box('C_OLD', 0)).not.toBeChecked();
  await expect(box('C_OLD', 1)).not.toBeChecked();
  await shot(page, '62-task-waiting');
  // a click forced on the other comment meanwhile sends nothing
  await box('C_OLD', 0).click({ force: true });
  await page.waitForTimeout(400);
  await expect(box('C_OLD', 0)).not.toBeChecked();
  const before = source('C_Q')!;
  release();
  // GitHub#489: nothing is said when it simply went through — the box itself shows it
  await expect.poll(() => writes().length).toBe(1);
  // confirmed and read again: blue, nothing waiting, every box takes clicks again; GitHub got that one write, one character
  await expect(waiting()).toHaveCount(0);
  await expect(box('C_Q', 0)).toBeChecked();
  await expect(box('C_Q', 0)).toBeEnabled();
  await expect(box('C_OLD', 0)).toBeEnabled();
  expect(await fill('C_Q', 0)).toBe(blue);
  expect(writes()).toEqual([['CavilUpdateComment', '/api/graphql', { id: 'C_Q', body: before.replace('- [ ] **A.', '- [x] **A.') }]]);
  expect(source('C_OLD')).toBe(QUESTION193);
  await shot(page, '63-task-confirmed');

  // ---- 2. untick B while GitHub does not answer: an empty grey box, B of the other comment untouched ----
  release = env.fake.holdWhen((e) => e.operation === 'CavilUpdateComment');
  await box('C_Q', 1).click();
  await expect.poll(async () => (await iframe.getAttribute('data-ready')) === 'yes' && (await waiting().count()) === 1).toBe(true);
  await page.waitForTimeout(600);
  await expect(box('C_Q', 1)).toHaveAttribute('data-pending', '');
  await expect(box('C_Q', 1)).not.toBeChecked();
  await expect(box('C_Q', 0)).toBeChecked();
  const greyEmpty = await fill('C_Q', 1);
  expect(greyEmpty).not.toBe(empty);
  expect(greyEmpty).not.toBe(blue);
  await expect(box('C_OLD', 1)).toBeDisabled();
  release();
  await expect.poll(() => env.fake.writes().length).toBe(2);
  await expect(waiting()).toHaveCount(0);
  await expect(box('C_Q', 1)).not.toBeChecked();
  await expect(box('C_Q', 1)).toBeEnabled();
  expect(await fill('C_Q', 1)).toBe(empty);
  expect(env.fake.writes()).toHaveLength(2);

  // ---- 3. refused (somebody changed the comment meanwhile): the grey tick is taken back, the reason is said ----
  const theirs = source('C_OLD')!.replace('— 自动', '— 自动（改过）');
  w.comments.get('gigleai/cavil-loop#138')!.find((c) => c.id === 'C_OLD')!.body = theirs;
  await box('C_OLD', 0).click();
  await expect(sendNotice(page).first().getByTestId('send-notice-text')).toHaveText(`勾选没有保存上：${TASK_CHANGED193}`);
  await expect(frame.locator('details.entry[data-entry="C_OLD"] .md')).toContainText('自动（改过）');
  await expect(waiting()).toHaveCount(0);
  await expect(box('C_OLD', 0)).not.toBeChecked();
  await expect(box('C_OLD', 0)).toBeEnabled();
  expect(env.fake.writes()).toHaveLength(2);
  expect(source('C_OLD')).toBe(theirs);

  // ---- 4. the answer arrives after the panel moved to another item: nothing waits on the new opening, the write landed once ----
  release = env.fake.holdWhen((e) => e.operation === 'CavilUpdateComment');
  await box('C_OLD', 0).click();
  await expect(waiting()).toHaveCount(1);
  await page.getByTestId('detail-close').click();
  await expect(page.getByTestId('timeline-frame')).toHaveCount(0);
  release();
  await expect.poll(() => env.fake.writes().length).toBe(3);
  await card(page, 138).click();
  await expect(iframe).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  await page.getByTestId('unfold-toggle').click();
  await expect(box('C_OLD', 0)).toBeChecked();
  await expect(waiting()).toHaveCount(0);
  await expect(box('C_OLD', 0)).toBeEnabled();
  expect(source('C_OLD')).toBe(theirs.replace('- [ ] **A.', '- [x] **A.'));
  await app.close();
});

// ---- the app updating itself (GitHub#184) -----------------------------------------------
// The shell's updater is played by the bridge (app.desktop.update / setUpdate); what each state
// says and which requests the buttons send is the window's part, checked here.

test('GitHub#184: update section in Settings, every state; failures only in Settings; the ready bar on the board, restart, × keeps it closed', async () => {
  const { app, page } = await launch(env);
  await signInForReminders(page, []);
  // a build that does not update itself shows nothing about it
  await expect(page.getByTestId('pending-settings')).toBeVisible();
  await expect(page.getByTestId('update-settings')).toHaveCount(0);
  await expect(page.locator('.settings-nav a', { hasText: '更新' })).toHaveCount(0);

  const base = { supported: true, current: '0.5.0', auto: true, channel: 'stable', devUnavailable: null, problem: null, phase: 'idle', dismissed: null, last: null };
  const at = new Date(2026, 10, 6, 14, 2).getTime();
  app.desktop.setUpdate(base);
  await expect(page.getByTestId('update-current')).toHaveText('0.5.0');
  await expect(page.locator('.settings-nav a', { hasText: '更新' })).toHaveCount(1);
  await expect(page.getByTestId('update-line')).toHaveText('还没有检查过');
  await page.getByTestId('update-check').click();
  await expect.poll(() => app.desktop.records.filter((r) => r.op === 'checkUpdate').length).toBe(1);

  app.desktop.setUpdate({ ...base, phase: 'checking' });
  await expect(page.getByTestId('update-line')).toHaveText('正在检查…');
  await expect(page.getByTestId('update-check')).toBeDisabled();

  app.desktop.setUpdate({ ...base, phase: 'downloading', version: '0.5.1', got: 3_200_000, total: 8_000_000 });
  await expect(page.getByTestId('update-line')).toHaveText('正在下载 0.5.1（3.2 / 8.0 MB）');
  await expect(page.getByTestId('update-check')).toBeDisabled();

  app.desktop.setUpdate({ ...base, last: { at, ok: true, message: '已是最新' } });
  await expect(page.getByTestId('update-line')).toHaveText('上次检查 14:02，已是最新');
  await expect(page.getByTestId('update-check')).toBeEnabled();

  // a failure: in Settings, in red, with when; never on the board
  app.desktop.setUpdate({ ...base, last: { at, ok: false, message: '下载 0.5.1 失败：60 秒没有收到数据' } });
  await expect(page.getByTestId('update-line')).toHaveText('下载 0.5.1 失败：60 秒没有收到数据（14:02）');
  await expect(page.getByTestId('update-line')).toHaveClass(/err/);
  await shot(page, '50-update-failed');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('update-ready')).toHaveCount(0);
  await expect(page.locator('.banner', { hasText: '0.5.1' })).toHaveCount(0);
  await page.getByTestId('open-settings').click();

  // automatic checks: the box follows what the shell reports
  await page.getByTestId('update-auto').click();
  await expect.poll(() => app.desktop.records.filter((r) => r.op === 'setAutoUpdate').map((r) => r.on)).toEqual([false]);
  await expect(page.getByTestId('update-auto')).not.toBeChecked();

  // the new version is in place
  app.desktop.setUpdate({ ...app.desktop.update, phase: 'ready', version: '0.5.1', last: { at, ok: true, message: '新版 0.5.1 已下载，重启后生效' } });
  await expect(page.getByTestId('update-line')).toHaveText('新版 0.5.1 已下载，重启后生效');
  await expect(page.getByTestId('update-check')).toHaveCount(0);
  await shot(page, '51-update-ready-settings');
  await page.getByTestId('update-restart').click();
  await expect.poll(() => app.desktop.records.filter((r) => r.op === 'restartToUpdate').length).toBe(1);
  await page.getByTestId('back').click();
  await expect(page.getByTestId('update-ready')).toContainText('新版 0.5.1 已下载，重启后生效');
  await shot(page, '52-update-ready-board');
  await page.getByTestId('update-ready-restart').click();
  await expect.poll(() => app.desktop.records.filter((r) => r.op === 'restartToUpdate').length).toBe(2);
  await page.getByTestId('update-ready-close').click();
  await expect.poll(() => app.desktop.records.filter((r) => r.op === 'dismissUpdate').map((r) => r.version)).toEqual(['0.5.1']);
  await expect(page.getByTestId('update-ready')).toHaveCount(0);
  // a later version is shown again
  app.desktop.setUpdate({ ...app.desktop.update, version: '0.5.2' });
  await expect(page.getByTestId('update-ready')).toContainText('0.5.2');

  // a build that cannot update itself says why and offers nothing to click
  app.desktop.setUpdate({ ...base, problem: '这一版没有带更新用的公钥，不能自动更新，请手动下载新版' });
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('update-line')).toHaveText('这一版没有带更新用的公钥，不能自动更新，请手动下载新版');
  await expect(page.getByTestId('update-check')).toBeDisabled();
  await expect(page.getByTestId('update-auto')).toBeDisabled();
  await app.close();
});

// GitHub#348: what the update changes. The list comes whole from the shell (state.update.notes /
// .installed, played by the bridge); the window shows it as plain text and opens it from three places.
test('GitHub#348: what the update changes — one list opened from the board notice, from Settings and after the restart; nothing to list shows nothing new', async () => {
  const { app, page } = await launch(env);
  await signInForReminders(page, []);
  const at = new Date(2026, 10, 10, 11, 40).getTime();
  const CUR = '0.5.1-dev.444';
  const NEW = '0.5.1-dev.462';
  const notes = {
    from: CUR,
    to: NEW,
    complete: true,
    more: 0,
    entries: [
      { version: NEW, at: new Date(2026, 10, 10, 11, 27).toISOString(), more: 0, items: [{ title: '重启后窗口回到原来的大小和位置（GitHub#333）', more: '关掉 App 再打开，窗口还在原来的位置。<b>不是标签</b>' }] },
      { version: '0.5.1-dev.456', at: null, more: 2, items: [{ title: "feat(client): read a notified item's detail ahead of the click (#328) (#331)", more: null }] },
      { version: '0.5.1-dev.455', at: 'not a time', more: 0, items: [] },
    ],
  };
  const base = { supported: true, current: CUR, auto: true, channel: 'dev', devUnavailable: null, problem: null, phase: 'idle', dismissed: null, last: null, notes: null, installed: null };
  const ready = { ...base, phase: 'ready', version: NEW, last: { at, ok: true, message: `新版 ${NEW} 已下载，重启后生效` } };
  const restarts = () => app.desktop.records.filter((r) => r.op === 'restartToUpdate').length;
  const dialog = page.getByTestId('update-notes');
  const entries = () =>
    dialog.getByTestId('update-notes-entry').evaluateAll((els) => els.map((e) => [e.getAttribute('data-version'), e.querySelector('.when')!.textContent, [...e.querySelectorAll('[data-testid="update-notes-item"]')].map((i) => (i.querySelector('summary') ?? i).textContent)]));

  // nothing to list: the ready state is exactly what it was — no new button anywhere
  app.desktop.setUpdate(ready);
  await expect(page.getByTestId('update-restart')).toBeVisible();
  await expect(page.getByTestId('update-notes-open')).toHaveCount(0);
  await expect(page.getByTestId('update-installed-line')).toHaveCount(0);
  await page.getByTestId('back').click();
  await expect(page.getByTestId('update-ready')).toContainText(`新版 ${NEW} 已下载，重启后生效`);
  await expect(page.getByTestId('update-ready-notes')).toHaveCount(0);
  await expect(page.getByTestId('update-installed')).toHaveCount(0);
  // a list with no version in it is nothing to list either
  app.desktop.setUpdate({ ...ready, notes: { ...notes, entries: [] } });
  await expect(page.getByTestId('update-ready')).toBeVisible();
  await expect(page.getByTestId('update-ready-notes')).toHaveCount(0);

  // the board notice: the count, then the list
  app.desktop.setUpdate({ ...ready, notes });
  await expect(page.getByTestId('update-ready-notes')).toHaveText('更新内容（3 个版本）');
  await shot(page, '53-update-ready-board-notes');
  await page.getByTestId('update-ready-notes').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('update-notes-range')).toHaveText(`${CUR} → ${NEW}，共 3 个版本`);
  expect(await entries()).toEqual([
    [NEW, '11-10 11:27', ['重启后窗口回到原来的大小和位置（GitHub#333）']],
    ['0.5.1-dev.456', '', ["feat(client): read a notified item's detail ahead of the click (#328) (#331)"]],
    ['0.5.1-dev.455', '', []],
  ]);
  await expect(dialog.locator('[data-version="0.5.1-dev.456"]')).toContainText('还有 2 条，在 GitHub 上看');
  await expect(dialog.locator('[data-version="0.5.1-dev.455"]').getByTestId('update-notes-none')).toHaveText('这一版没有写更新说明');
  // the description is folded until asked for, and is text: nothing in it becomes an element
  const more = dialog.locator(`[data-version="${NEW}"] .more`);
  await expect(more).toBeHidden();
  await dialog.locator(`[data-version="${NEW}"] summary`).click();
  await expect(more).toHaveText('关掉 App 再打开，窗口还在原来的位置。<b>不是标签</b>');
  expect(await more.locator('b').count()).toBe(0);
  await expect(dialog.getByTestId('update-notes-foot')).not.toContainText('可能不全');
  await shot(page, '54-update-notes-dialog');
  // the one link is the repository's releases page
  await dialog.getByTestId('update-notes-web').click();
  await expect.poll(() => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '')).toContain('https://github.com/GigleAI/cavil-loop/releases\n');
  // restart from the list
  expect(restarts()).toBe(0);
  await dialog.getByTestId('update-notes-restart').click();
  await expect.poll(restarts).toBe(1);
  // Esc closes the list and nothing else: the board and its notice are still there
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('update-ready')).toBeVisible();
  // a click outside the list closes it too
  await page.getByTestId('update-ready-notes').click();
  await expect(dialog).toBeVisible();
  await dialog.click({ position: { x: 5, y: 5 } });
  await expect(dialog).toHaveCount(0);

  // older versions cleaned away / more versions than listed: said in the list, counted in the buttons
  app.desktop.setUpdate({ ...ready, notes: { ...notes, complete: false, more: 4 } });
  await expect(page.getByTestId('update-ready-notes')).toHaveText('更新内容（7 个版本）');
  await page.getByTestId('update-ready-notes').click();
  await expect(dialog.getByTestId('update-notes-range')).toHaveText(`${CUR} → ${NEW}，共 7 个版本`);
  await expect(dialog.getByTestId('update-notes-foot')).toContainText('还有 4 个更早的版本没有列出');
  await expect(dialog.getByTestId('update-notes-foot')).toContainText('这里可能不全');
  await dialog.getByTestId('update-notes-close').click();
  await expect(dialog).toHaveCount(0);

  // Settings: the same list from a button next to "restart"; also while it downloads (no restart offered then)
  app.desktop.setUpdate({ ...ready, notes });
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('update-notes-open')).toHaveText('查看更新内容（3 个版本）');
  await page.getByTestId('update-notes-open').scrollIntoViewIfNeeded();
  await shot(page, '55-update-ready-settings-notes');
  await page.getByTestId('update-notes-open').click();
  expect((await entries()).map((e) => e[0])).toEqual([NEW, '0.5.1-dev.456', '0.5.1-dev.455']);
  await expect(dialog.getByTestId('update-notes-restart')).toBeVisible();
  await dialog.getByTestId('update-notes-close').click();
  app.desktop.setUpdate({ ...base, phase: 'downloading', version: NEW, got: 1_000_000, total: 8_000_000, notes });
  await page.getByTestId('update-notes-open').click();
  await expect(dialog.getByTestId('update-notes-entry')).toHaveCount(3);
  await expect(dialog.getByTestId('update-notes-restart')).toHaveCount(0);
  await dialog.getByTestId('update-notes-close').click();
  // GitHub#348 (PR #351 review round 1): "open" belongs to the list it was opened on. While that
  // download reports progress the list stays open; once the round is over — it failed, the channel
  // was switched — it is closed for good: the next round's list never opens without a click.
  const downloading = (o: Record<string, unknown> = {}) => ({ ...base, phase: 'downloading', version: NEW, got: 1_000_000, total: 8_000_000, notes, ...o });
  const opened = () => dialog.count();
  await page.getByTestId('update-notes-open').click();
  await expect(dialog).toBeVisible();
  app.desktop.setUpdate(downloading({ got: 5_000_000, notes: JSON.parse(JSON.stringify(notes)) }));
  await expect(page.getByTestId('update-line')).toContainText('5.0 / 8.0 MB');
  expect(await opened()).toBe(1);
  app.desktop.setUpdate({ ...base, phase: 'installing', version: NEW, notes });
  await expect(page.getByTestId('update-line')).toHaveText(`正在安装 ${NEW}`);
  expect(await opened()).toBe(1);
  // the round fails; the next one finds another version
  app.desktop.setUpdate({ ...base, last: { at, ok: false, message: `安装 ${NEW} 失败` } });
  await expect(dialog).toHaveCount(0);
  const other = { ...notes, to: '0.5.1-dev.470', entries: [{ version: '0.5.1-dev.470', at: null, more: 0, items: [{ title: '另一轮', more: null }] }, ...notes.entries] };
  app.desktop.setUpdate(downloading({ version: '0.5.1-dev.470', notes: other }));
  await expect(page.getByTestId('update-notes-open')).toHaveText('查看更新内容（4 个版本）');
  await page.waitForTimeout(300);
  expect(await opened()).toBe(0);
  // … and the same version again after a failed round does not reopen it either
  await page.getByTestId('update-notes-open').click();
  await expect(dialog.getByTestId('update-notes-range')).toContainText('0.5.1-dev.470');
  app.desktop.setUpdate({ ...base, phase: 'checking' });
  await expect(dialog).toHaveCount(0);
  app.desktop.setUpdate(downloading({ version: '0.5.1-dev.470', notes: other }));
  await expect(page.getByTestId('update-notes-open')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await opened()).toBe(0);
  // a channel switch mid-download: the round starts over on the other channel with another list
  await page.getByTestId('update-notes-open').click();
  await expect(dialog).toBeVisible();
  app.desktop.setUpdate({ ...base, channel: 'stable', phase: 'checking' });
  await expect(dialog).toHaveCount(0);
  app.desktop.setUpdate({ ...base, channel: 'stable', phase: 'downloading', version: '0.5.1', got: 1, total: 2, notes: { ...notes, to: '0.5.1', entries: [{ version: '0.5.1', at: null, more: 0, items: [] }] } });
  await expect(page.getByTestId('update-notes-open')).toHaveText('查看更新内容（1 个版本）');
  await page.waitForTimeout(300);
  expect(await opened()).toBe(0);
  // the board notice holds the same rule: opened there, the list replaced by another version's closes it
  app.desktop.setUpdate({ ...ready, notes });
  await page.getByTestId('back').click();
  await page.getByTestId('update-ready-notes').click();
  await expect(dialog).toBeVisible();
  app.desktop.setUpdate({ ...ready, version: '0.5.1-dev.470', notes: other });
  await expect(page.getByTestId('update-ready-notes')).toHaveText('更新内容（4 个版本）');
  await expect(dialog).toHaveCount(0);
  await page.getByTestId('open-settings').click();
  // idle again (the round failed): the button goes with the list
  app.desktop.setUpdate({ ...base, last: { at, ok: false, message: `下载 ${NEW} 失败：60 秒没有收到数据` } });
  await expect(page.getByTestId('update-line')).toContainText('失败');
  await expect(page.getByTestId('update-notes-open')).toHaveCount(0);

  // after the restart into the new version: a notice on the board, the list without "restart", closed for good
  app.desktop.setUpdate({ ...base, current: NEW, installed: { ...notes, dismissed: false } });
  await expect(page.getByTestId('update-installed-line')).toContainText(`上次更新：${CUR} → ${NEW}`);
  await page.getByTestId('back').click();
  await expect(page.getByTestId('update-installed')).toContainText(`已从 ${CUR} 更新到 ${NEW}。`);
  await expect(page.getByTestId('update-installed-notes')).toHaveText('看更新了什么（3 个版本）');
  await expect(page.getByTestId('update-ready')).toHaveCount(0);
  await shot(page, '56-update-installed-board');
  await page.getByTestId('update-installed-notes').click();
  expect((await entries()).map((e) => e[0])).toEqual([NEW, '0.5.1-dev.456', '0.5.1-dev.455']);
  await expect(dialog.getByTestId('update-notes-restart')).toHaveCount(0);
  await dialog.getByTestId('update-notes-close').click();
  await page.getByTestId('update-installed-close').click();
  await expect.poll(() => app.desktop.records.filter((r) => r.op === 'dismissInstalledUpdate').map((r) => r.version)).toEqual([NEW]);
  await expect(page.getByTestId('update-installed')).toHaveCount(0);
  // still readable from Settings
  await page.getByTestId('open-settings').click();
  await page.getByTestId('update-installed-open').click();
  await expect(dialog.getByTestId('update-notes-range')).toHaveText(`${CUR} → ${NEW}，共 3 个版本`);
  await dialog.getByTestId('update-notes-close').click();
  expect(restarts()).toBe(1);
  await app.close();
});

test('GitHub#215: the update channel in Settings — release by default, development explains itself, refused while installing, greyed out without a development build', async () => {
  const { app, page } = await launch(env);
  await signInForReminders(page, []);
  const base = { supported: true, current: '0.5.0', auto: true, channel: 'stable', devUnavailable: null, problem: null, phase: 'idle', dismissed: null, last: null };
  app.desktop.setUpdate(base);
  await expect(page.getByTestId('update-channel')).toHaveAttribute('data-channel', 'stable');
  await expect(page.getByTestId('update-channel-stable')).toBeChecked();
  await expect(page.getByTestId('update-channel-dev')).not.toBeChecked();
  await expect(page.getByTestId('update-channel-note')).toHaveCount(0);

  // choosing the development channel: one request; the picker follows what the shell then reports
  await page.getByTestId('update-channel-dev').click();
  await expect.poll(() => app.desktop.records.filter((r) => r.op === 'setUpdateChannel').map((r) => r.channel)).toEqual(['dev']);
  await expect(page.getByTestId('update-channel-dev')).toBeChecked();
  await expect(page.getByTestId('update-channel-note')).toHaveText(
    '开发版跟着 main 走，每次合并都可能有新版，可能不稳定。切回正式版不会降级，会等下一个比当前高的正式版。',
  );
  await shot(page, '53-update-channel-dev');
  // the channel already chosen: no request
  await page.getByTestId('update-channel-dev').click();
  await page.waitForTimeout(200);
  expect(app.desktop.records.filter((r) => r.op === 'setUpdateChannel')).toHaveLength(1);

  // a round on the development channel: its version on screen as is
  app.desktop.setUpdate({ ...app.desktop.update, phase: 'downloading', version: '0.5.1-dev.387', got: 1_000_000, total: 8_000_000 });
  await expect(page.getByTestId('update-line')).toHaveText('正在下载 0.5.1-dev.387（1.0 / 8.0 MB）');
  await expect(page.getByTestId('update-channel-stable')).toBeEnabled();

  // being put in place: both choices greyed out, and why
  app.desktop.setUpdate({ ...app.desktop.update, phase: 'installing', version: '0.5.1-dev.387' });
  await expect(page.getByTestId('update-line')).toHaveText('正在安装 0.5.1-dev.387');
  await expect(page.getByTestId('update-channel-stable')).toBeDisabled();
  await expect(page.getByTestId('update-channel-dev')).toBeDisabled();
  await expect(page.getByTestId('update-channel-note')).toHaveText('正在安装 0.5.1-dev.387，装好后可以切换');
  await expect(page.getByTestId('update-check')).toBeDisabled();

  // in place: switching back is allowed and says what it means for the version already installed
  app.desktop.setUpdate({ ...app.desktop.update, phase: 'ready', version: '0.5.1-dev.387' });
  await expect(page.getByTestId('update-channel-stable')).toBeEnabled();
  await expect(page.getByTestId('update-channel-ready')).toHaveText('已装好 0.5.1-dev.387，重启后生效；之后按所选渠道检查');
  await page.getByTestId('update-channel-stable').click();
  await expect.poll(() => app.desktop.records.filter((r) => r.op === 'setUpdateChannel').map((r) => r.channel)).toEqual(['dev', 'stable']);
  await expect(page.getByTestId('update-channel-stable')).toBeChecked();
  await expect(page.getByTestId('update-current')).toHaveText('0.5.0');

  // a Mac without development builds: the development channel greyed out, with the reason
  app.desktop.setUpdate({ ...base, devUnavailable: '开发版只有 Apple 芯片的包，这台 Mac 只能用正式版' });
  await expect(page.getByTestId('update-channel-dev')).toBeDisabled();
  await expect(page.getByTestId('update-channel-stable')).toBeChecked();
  await expect(page.getByTestId('update-channel-note')).toHaveText('开发版只有 Apple 芯片的包，这台 Mac 只能用正式版');
  // and a build that cannot update itself at all: nothing to choose
  app.desktop.setUpdate({ ...base, problem: '这一版没有带更新用的公钥，不能自动更新，请手动下载新版' });
  await expect(page.getByTestId('update-channel-stable')).toBeDisabled();
  await expect(page.getByTestId('update-channel-dev')).toBeDisabled();
  expect(app.desktop.records.filter((r) => r.op === 'setUpdateChannel')).toHaveLength(2);
  await app.close();
});

test('GitHub#217: refresh while a round runs — the button and ⌘R start over; the detail refresh reads again', async () => {
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const refresh = page.getByTestId('refresh');
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const c138 = findCopies(store, 'GigleAI/cavil-loop', 138)!;
  const retitle = (t: string) => {
    for (const r of c138.rest) r.title = t;
    for (const g of c138.gql) g.title = t;
  };
  /** the next sync round's read of the repository's open issues (first page), held */
  const holdRound = () =>
    holdFirst((e) => e.method === 'GET' && e.path.startsWith('/api/repos/GigleAI/cavil-loop/issues?') && e.path.includes('state=open') && !/[?&]page=/.test(e.path));
  const roundReads = () => env.fake.log.filter((e) => e.method === 'GET' && e.path.startsWith('/api/repos/GigleAI/cavil-loop/issues?') && e.path.includes('state=open')).length;

  for (const how of ['button', 'key'] as const) {
    const press = () => (how === 'button' ? refresh.click() : page.keyboard.press(`${MOD}+r`));
    const release = holdRound();
    const reads = roundReads();
    await press();
    await expect.poll(roundReads).toBe(reads + 1);
    // a round is running: the button turns and can still be pressed
    await expect(refresh).toHaveAttribute('data-syncing', 'yes');
    await expect(refresh).toBeEnabled();
    await expect(refresh).toHaveClass(/spinning/);
    if (how === 'button') await shot(page, '70-refresh-while-syncing');
    const fresh = `TITLE_217_${how}`;
    retitle(fresh);
    await press(); // start over: the held round is not waited for
    await expect(card(page, 138)).toContainText(fresh, { timeout: 15_000 });
    await expect(refresh).toHaveAttribute('data-syncing', 'no');
    await expect(refresh).not.toHaveClass(/spinning/);
    // the dropped round's answer comes late: nothing of it shows
    retitle(`TITLE_217_${how}_DROPPED`);
    release();
    await page.waitForTimeout(800);
    await expect(card(page, 138)).toContainText(fresh);
    await expect(card(page, 138)).not.toContainText('DROPPED');
    await expect(page.getByTestId('sync-problem')).toHaveCount(0);
  }

  // the detail's "refresh this one": clickable while reading, the newer read is the one shown
  env.fake.state.w.bodies.set('gigleai/cavil-loop#137', '<p>BODY_217_OLD</p>');
  const detail = page.getByTestId('detail');
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  await card(page, 137).click();
  await expect(frame.locator('body')).toContainText('BODY_217_OLD', { timeout: 15_000 });
  const detailReads = () => env.fake.log.filter((e) => e.operation === 'CavilItemDetail').length;
  const release = holdFirst((e) => e.operation === 'CavilItemDetail');
  const n = detailReads();
  const again = detail.getByTestId('detail-refresh');
  await again.click();
  await expect.poll(detailReads).toBe(n + 1);
  await expect(again).toHaveAttribute('data-loading', 'yes');
  await expect(again).toBeEnabled();
  env.fake.state.w.bodies.set('gigleai/cavil-loop#137', '<p>BODY_217_NEW</p>');
  await again.click();
  await expect(frame.locator('body')).toContainText('BODY_217_NEW', { timeout: 15_000 });
  await expect(again).toHaveAttribute('data-loading', 'no');
  release();
  await page.waitForTimeout(800);
  await expect(frame.locator('body')).toContainText('BODY_217_NEW');
  await app.close();
});

// ---- GitHub#205: client improvements ----

test('GitHub#205: table cells change labels / status in place; columns can be resized and keep their width after a restart; group heads stand out', async () => {
  let { app, page } = await launch(env);
  await signInWithSources(page);
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await expect(page.getByTestId('table')).toBeVisible();
  const row = page.locator('[data-testid="row"][data-key="gigleai/cavil-loop#138"]').first();
  await expect(row).toBeVisible({ timeout: 15_000 });

  // group heads: kept in view while their rows scroll; lighter than the repository heading, no bar in front (GitHub#275)
  const head = page.getByTestId('group-head').first().locator('td');
  expect(await head.evaluate((td) => getComputedStyle(td).position)).toBe('sticky');
  expect(await head.evaluate((td) => getComputedStyle(td).boxShadow)).not.toContain('4px 0px 0px 0px');
  expect(await head.evaluate((td) => getComputedStyle(td).backgroundColor)).toBe(await page.locator('.table-scroll').evaluate((el) => getComputedStyle(el).backgroundColor));
  await shot(page, '205-01-table-groups');

  // labels: a click on the cell opens the picker; one click = one add, sent at once
  const before = writes().length;
  await row.locator('[data-testid="cell"][data-col="labels"]').click();
  await row.locator('[data-testid="cell-label-picker"] [data-testid="picker-item"][data-name="Done"]').click();
  await savedQuietly(page, sentTo('POST', '/issues/138/labels'), before);
  await page.keyboard.press('Escape');
  await expect(row.locator('[data-testid="cell"][data-col="labels"] .label', { hasText: 'Done' })).toBeVisible();
  expect(writes().slice(before)).toEqual([['POST', '/api/repos/GigleAI/cavil-loop/issues/138/labels', { labels: ['Done'] }]]);

  // status: the cell becomes the Project's dropdown; the choice is written to that Project only
  await page.getByTestId('open-view-panel').click();
  const statusCol = page.locator('[data-testid="columns-pick"] input[data-col="status"]');
  if (!(await statusCol.isChecked())) await statusCol.check();
  await page.getByTestId('open-view-panel').click();
  const statusCell = row.locator('[data-testid="cell"][data-col="status"]');
  await expect(statusCell).toHaveCount(1);
  const b2 = writes().length;
  await statusCell.click();
  await statusCell.getByTestId('cell-status').selectOption('In progress');
  await savedQuietly(page, sentOp('CavilSetStatus'), b2);
  expect(writes().slice(b2).map((w) => w[0])).toEqual(['CavilSetStatus']);
  await expect(statusCell).toContainText('In progress');
  await shot(page, '205-02-table-edited');

  // a column dragged wider keeps that width, also after a restart; double-click puts the default back
  const th = page.locator('[data-testid="col-head"][data-col="labels"]');
  const w0 = (await th.boundingBox())!.width;
  const grip = (await page.locator('[data-testid="col-resize"][data-col="labels"]').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 120, grip.y + grip.height / 2, { steps: 6 });
  await page.mouse.up();
  const want = Math.round(w0 + 120 - grip.width / 2);
  await expect.poll(async () => Number(await th.getAttribute('data-width'))).toBeGreaterThan(w0 + 60);
  const saved = Number(await th.getAttribute('data-width'));
  expect(Math.abs(saved - want)).toBeLessThan(12);
  await expect.poll(async () => Math.round((await th.boundingBox())!.width)).toBe(saved);
  await shot(page, '205-03-column-wider');
  await app.close();
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  const th2 = page.locator('[data-testid="col-head"][data-col="labels"]');
  await expect(th2).toHaveAttribute('data-width', String(saved));
  await expect.poll(async () => Math.round((await th2.boundingBox())!.width)).toBe(saved);
  await page.locator('[data-testid="col-resize"][data-col="labels"]').dblclick();
  await expect(th2).not.toHaveAttribute('data-width', String(saved));
  await app.close();
});

test('GitHub#205: new issue — coloured label picker; boards ticked one by one, starting from the board of the repository (GitHub#231)', async () => {
  const { app, page } = await launch(env);
  await signInWithSources(page);
  // narrowed to the Project: it starts ticked
  await showSource(page, '[data-key^="repo:"]', false);
  await page.getByTestId('write-entry').click();
  await expect(page.getByTestId('new-issue-project')).toBeChecked();
  await page.getByTestId('new-issue-title').fill('只进仓库的 issue');
  await openMoreFields(page);
  await page.getByTestId('new-issue-label-add').click();
  const picker = page.getByTestId('new-issue-label-picker');
  await expect(picker.locator('[data-testid="picker-item"]').first()).toBeVisible();
  // every candidate carries its colour dot; the chosen ones are chips in GitHub's colour
  expect(await picker.locator('[data-testid="picker-item"] .dot').count()).toBe(await picker.locator('[data-testid="picker-item"]').count());
  await picker.getByTestId('picker-filter').fill('pending/h');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  const chip = page.locator('[data-testid="new-issue-label-chip"][data-label="pending/human"]');
  await expect(chip).toBeVisible();
  expect(await chip.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await shot(page, '205-04-new-issue');
  // GitHub#405: shut, the chosen label is on the fold's head line in the same colour
  const chipColour = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.getByTestId('new-issue-more-toggle').click();
  await expect(chip).toHaveCount(0);
  const headChip = page.locator('[data-testid="new-issue-more-label"][data-label="pending/human"]');
  await expect(headChip).toBeVisible();
  expect(await headChip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(chipColour);
  // untick the board: the new issue joins none
  await page.getByTestId('new-issue-project').uncheck();
  await expect(page.getByTestId('new-issue-projects-hint')).toContainText('不加入任何看板');
  const before = writes().length;
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  // GitHub#229: the dialog closes before GitHub answers — wait for the write itself
  await expect.poll(() => writes().slice(before).map((w) => [w[0], w[2]])).toEqual([['POST', { title: '只进仓库的 issue', body: '', labels: ['pending/human'] }]]);
  // the new issue opened in the detail: put it away first (a click outside it only does that, GitHub#191)
  await page.getByTestId('detail-close').click();
  // every source shown again: the same board starts ticked — the top filter plays no part (GitHub#231)
  await showSource(page, '[data-key^="repo:"]', true);
  await page.getByTestId('write-entry').click();
  await expect(page.getByTestId('new-issue-project')).toBeChecked();
  // an image pasted into the body: said, not dropped silently; the web page carries on with what was typed
  await page.getByTestId('new-issue-title').fill('带图');
  await page.getByTestId('new-issue-body').fill('看图');
  await pasteImage(page, '[data-testid="new-issue-body"]');
  await expect(page.getByTestId('paste-image-note')).toContainText('客户端不能把图片上传到 GitHub');
  await expect(page.getByTestId('new-issue-body')).toHaveValue('看图');
  await page.getByTestId('paste-image-web').click();
  await expect.poll(() => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '')).toContain(
    'https://github.com/GigleAI/cavil-loop/issues/new?title=%E5%B8%A6%E5%9B%BE&body=%E7%9C%8B%E5%9B%BE\n',
  );
  await app.close();
});

/** A paste carrying one PNG file and no text (a screenshot), into the box `sel`. */
async function pasteImage(page: Page, sel: string) {
  await page.locator(sel).evaluate((box) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }));
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
}

test('GitHub#205: detail — "hand to the agent" and "autopilot" next to send; a conflict is said loudly and blocks merging; edit a comment; a pasted image is said', async () => {
  const w = env.fake.state.w;
  const url = (id: string) => `https://github.com/GigleAI/cavil-loop/issues/138#${id}`;
  w.comments.set('gigleai/cavil-loop#138', [
    { id: 'C_THEIRS', url: url('C_THEIRS'), createdAt: '2026-11-02T01:00:00Z', bodyHTML: '', author: { login: 'user-2' }, body: '别人的评论' },
    { id: 'C_MINE', url: url('C_MINE'), createdAt: '2026-11-03T01:00:00Z', bodyHTML: '', author: { login: 'user-3' }, body: '原来的**文字**' },
  ]);
  w.cannotUpdate.add('C_THEIRS');
  for (const r of env.fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === 146) Object.assign(r, { state: 'open', pull_request: { ...r.pull_request, merged_at: null } });
  for (const p of env.fake.state.projects.get('org/gigleai/11')!) for (const n of p.items.nodes) if (n.content?.number === 146) Object.assign(n.content, { state: 'OPEN', merged: false });
  const pull = pullOf(env.fake.state, findCopies(env.fake.state, 'GigleAI/cavil-loop', 146)!);
  Object.assign(pull, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });

  const { app, page } = await launch(env);
  await signInWithSources(page);
  await card(page, 138).click();
  const detail = page.getByTestId('detail');
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });

  // ---- 1. the buttons sit next to "send", without replying first ----
  const row = detail.locator('.reply .row.end');
  await expect(row.getByTestId('hand-back')).toBeVisible();
  await expect(row.getByTestId('autopilot')).toBeVisible();
  await expect(row.getByTestId('reply-send')).toBeVisible();
  await shot(page, '205-05-quick-actions');
  const before = writes().length;
  await row.getByTestId('autopilot').click();
  await expect(page.getByTestId('autopilot-explain')).toContainText('自动合并');
  await shot(page, '205-06-autopilot-confirm');
  await page.getByTestId('confirm-ok').click();
  await expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first().getByTestId('op-notice-text')).toContainText('已托管');
  expect(writes().slice(before)).toEqual([
    ['POST', '/api/repos/GigleAI/cavil-loop/issues/138/labels', { labels: ['autopilot'] }],
    ['POST', '/api/repos/GigleAI/cavil-loop/issues/138/labels', { labels: ['pending/agent'] }],
    ['DELETE', '/api/repos/GigleAI/cavil-loop/issues/138/labels/pending%2Fhuman', undefined],
  ]);
  await expect(card(page, 138).locator('.label', { hasText: 'autopilot' })).toBeVisible();

  // ---- 2. edit: only where GitHub allows it; the whole new text goes up, read back from GitHub ----
  await frame.locator('details.entry[data-entry="C_THEIRS"] > summary').click({ position: { x: 40, y: 10 } });
  await expect(frame.locator('details.entry[data-entry="C_THEIRS"] button[data-edit]')).toHaveCount(0);
  await expect(frame.locator('details.entry[data-entry="C_MINE"] button[data-edit]')).toBeVisible();
  await frame.locator('details.entry[data-entry="C_MINE"] button[data-edit]').click();
  const box = page.getByTestId('edit-input');
  await expect(box).toHaveValue('原来的**文字**');
  // an image pasted while editing: said; the text stays as it was
  await pasteImage(page, '[data-testid="edit-input"]');
  await expect(page.getByTestId('paste-image-note')).toBeVisible();
  await expect(box).toHaveValue('原来的**文字**');
  await page.getByTestId('paste-image-dismiss').click();
  await box.fill('改过的文字');
  await shot(page, '205-07-edit');
  const b2 = writes().length;
  await page.getByTestId('confirm-ok').click();
  // GitHub#489: the editor closes at once; the result is said in the window's notice area
  await expect(page.getByTestId('edit-input')).toHaveCount(0);
  await expect(sendNotice(page).first().getByTestId('send-notice-text')).toHaveText('正文 / 评论的修改已保存');
  expect(writes().slice(b2)).toEqual([['CavilUpdateComment', '/api/graphql', { id: 'C_MINE', body: '改过的文字' }]]);
  await expect(frame.locator('details.entry[data-entry="C_MINE"]')).toContainText('改过的文字');
  // somebody changed it on the web while it was being edited: refused, the typed text stays in the box, theirs on GitHub
  await frame.locator('details.entry[data-entry="C_MINE"] button[data-edit]').click();
  w.comments.get('gigleai/cavil-loop#138')!.find((c) => c.id === 'C_MINE')!.body = '别人刚改的';
  await page.getByTestId('edit-input').fill('我的新版本');
  const digest = env.fake.digest();
  await page.getByTestId('confirm-ok').click();
  // GitHub#489: refused (nothing written) — said in the notice area, and the editor opens again with the typed text
  await expect(sendNotice(page).first().getByTestId('send-notice-text')).toContainText('被别人改过');
  await expect(sendNotice(page).first().getByTestId('send-notice-text')).toContainText('原文已放回编辑框');
  await expect(page.getByTestId('edit-input')).toHaveValue('我的新版本');
  expect(env.fake.digest()).toBe(digest);
  await page.getByTestId('confirm-cancel').click();

  // ---- 3. a pasted image in the reply box: said; the item's web page opens ----
  await detail.getByTestId('reply-input').fill('回复');
  await pasteImage(page, '[data-testid="reply-input"]');
  await expect(detail.getByTestId('paste-image-note')).toBeVisible();
  await expect(detail.getByTestId('reply-input')).toHaveValue('回复');
  await detail.getByTestId('paste-image-web').click();
  await expect.poll(() => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '')).toContain('https://github.com/GigleAI/cavil-loop/issues/138\n');
  await detail.getByTestId('reply-input').fill('');
  await page.getByTestId('detail-close').click();

  // ---- 4. a PR with a conflict: a red bar, and the merge button is off and says why ----
  await page.getByTestId('mode').selectOption('status');
  await card(page, 146).click();
  await expect(page.getByTestId('pr-conflict')).toContainText('有冲突');
  await expect(page.getByTestId('merge')).toBeDisabled();
  await expect(page.getByTestId('merge')).toHaveText('有冲突，不能合并');
  await shot(page, '205-08-conflict');
  await page.getByTestId('detail-close').click();
  // no conflict: no bar, the button works as before
  Object.assign(pull, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  await card(page, 146).click();
  await expect(page.getByTestId('pr-status')).toContainText('可以合并');
  await expect(page.getByTestId('pr-conflict')).toHaveCount(0);
  await expect(page.getByTestId('merge')).toBeEnabled();
  await app.close();
});

test('GitHub#205 (PR #220 review round 1): an item shown in two groups (two boards, different status) — only the clicked cell opens, its label is written once', async () => {
  // a second board holding the same items, #138 with another status there: grouped by status, #138 shows twice
  const second = loadCavilProjectPages().map((p: any) => ({
    ...p,
    id: `${p.id}_second`,
    title: 'second board',
    url: 'https://github.com/orgs/GigleAI/projects/31',
    views: { nodes: [] },
    items: {
      ...p.items,
      nodes: p.items.nodes.map((n: any) => ({
        ...n,
        id: `${n.id}_second`,
        fieldValues: { nodes: n.fieldValues.nodes.map((v: any) => (n.content?.number === 138 && v.field?.name === 'Status' ? { ...v, name: 'In progress' } : v)) },
      })),
    },
  }));
  env.fake.state.projects.set('org/gigleai/31', second);
  const { app, page } = await launch(env);
  await signInWithSources(page);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill('https://github.com/orgs/GigleAI/projects/31');
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await page.getByTestId('search').fill('');
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('status');
  const labelsCol = page.locator('[data-testid="columns-pick"] input[data-col="labels"]');
  if (!(await labelsCol.isChecked())) await labelsCol.check();
  await page.getByTestId('open-view-panel').click();
  const rows = page.locator('[data-testid="row"][data-key="gigleai/cavil-loop#138"]');
  await expect(rows).toHaveCount(2, { timeout: 15_000 });

  for (const i of [1, 0]) {
    const before = writes().length;
    const label = i === 1 ? 'Done' : 'doing/agent';
    await rows.nth(i).locator('[data-testid="cell"][data-col="labels"]').click();
    // one picker, in the row that was clicked
    await expect(page.getByTestId('cell-label-picker')).toHaveCount(1);
    await expect(rows.nth(i).getByTestId('cell-label-picker')).toHaveCount(1);
    await rows.nth(i).locator(`[data-testid="cell-label-picker"] [data-testid="picker-item"][data-name="${label}"]`).click();
    await savedQuietly(page, sentTo('POST', '/issues/138/labels'), before);
    expect(writes().slice(before)).toEqual([['POST', '/api/repos/GigleAI/cavil-loop/issues/138/labels', { labels: [label] }]]);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('cell-label-picker')).toHaveCount(0);
  }
  // both rows are the same item: both show both labels
  for (const i of [0, 1]) for (const l of ['Done', 'doing/agent']) await expect(rows.nth(i).locator('[data-testid="cell"][data-col="labels"] .label', { hasText: l })).toBeVisible();
  await app.close();
});

test('GitHub#214: "+ new issue" under a table group — the dialog shows what it will carry, the issue lands in that group; A → B → A never brings back a stale milestone read', async () => {
  const PROJECT_KEY = 'project:org/gigleai/11';
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  // #138 in milestone v1.2, so a "v1.2" group exists; a second repository with nothing in it
  env.fake.state.w.milestones.set('gigleai/cavil-loop', [{ number: 5, title: 'v1.2', state: 'open', due_on: null }]);
  const c138 = findCopies(store, 'GigleAI/cavil-loop', 138)!;
  for (const r of c138.rest) r.milestone = { number: 5, title: 'v1.2', due_on: null };
  for (const g of c138.gql) g.milestone = { number: 5, title: 'v1.2', dueOn: null };
  env.fake.state.repos.set('gigleai/second', []);
  const nextNumber = () =>
    1 +
    Math.max(
      ...env.fake.state.repos.get('gigleai/cavil-loop')!.map((r: any) => r.number),
      ...env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes.map((n: any) => n.content?.number ?? 0)),
    );
  const { app, page } = await launch(env);
  await signInWithSources(page);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill('GigleAI/second');
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('status');
  const group = (title: string) => page.locator(`[data-testid="group"][data-title="${title}"]`);
  const dialog = page.getByTestId('confirm-dialog');
  const line = (target: string) => page.locator(`[data-testid="new-issue-preset-line"][data-target="${target}"]`);

  // ---- 1. status group: the dialog says what it sets; created, it is a row of that group ----
  await expect(group('In progress').getByTestId('group-add')).toBeEnabled({ timeout: 15_000 });
  await group('In progress').getByTestId('group-add').click();
  await expect(dialog).toContainText('加到「In progress」');
  await expect(page.getByTestId('new-issue-repo')).toHaveValue('GigleAI/cavil-loop');
  // GitHub#270: everything lands as the title says — no "will carry" box at all
  await expect(page.getByTestId('new-issue-preset')).toHaveCount(0);
  // a value that would not land is said, right under the board boxes (GitHub#231): here, no board ticked
  const board = page.locator(`[data-testid="new-issue-project"][data-project="${PROJECT_KEY}"]`);
  await board.uncheck();
  await expect(line('group')).toContainText('当前没有勾选看板，不会设置状态');
  await expect(line(PROJECT_KEY)).toHaveCount(0);
  await expect(page.getByTestId('new-issue-projects').getByTestId('new-issue-preset')).toHaveAttribute('data-place', 'boards');
  // GitHub#405: lines about the boards stay outside the fold — seen while it is shut
  await expect(page.getByTestId('new-issue-more')).toHaveAttribute('data-open', 'no');
  await expect(line('group')).toBeVisible();
  expect(await page.getByTestId('new-issue-more').locator('[data-testid="new-issue-preset-line"]').count()).toBe(0);
  await board.check();
  await expect(page.getByTestId('new-issue-preset')).toHaveCount(0);
  await page.getByTestId('new-issue-title').fill('在 In progress 组里建的');
  await shot(page, '214-group-new-issue');
  const n1 = nextNumber();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', `gigleai/cavil-loop#${n1}`);
  expect(writes().filter((w) => w[0] === 'CavilSetStatus')).toHaveLength(1);
  await expect(group('In progress').locator(`[data-testid="row"][data-key="gigleai/cavil-loop#${n1}"]`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('detail-close').click();

  // a folded group has no "+"
  await group('In progress').getByTestId('group-toggle').click();
  await expect(group('In progress').getByTestId('group-add')).toHaveCount(0);
  await group('In progress').getByTestId('group-toggle').click();
  await expect(group('In progress').getByTestId('group-add')).toHaveCount(1);

  // ---- 2. milestone group, A → B → A: the first read of A answers last and must not land ----
  await page.getByTestId('group-by').selectOption('milestone');
  for (const stale of ['ok-without-v1.2', 'failed'] as const) {
    env.fake.state.w.milestones.set('gigleai/cavil-loop', stale === 'ok-without-v1.2' ? [] : [{ number: 5, title: 'v1.2', state: 'open', due_on: null }]);
    if (stale === 'failed') env.fake.state.w.failMilestones.add('gigleai/cavil-loop');
    const release = holdFirst((e) => e.path.includes('/repos/GigleAI/cavil-loop/milestones'));
    await group('v1.2').getByTestId('group-add').click();
    await expect(page.getByTestId('new-issue-repo')).toHaveValue('GigleAI/cavil-loop');
    await page.getByTestId('new-issue-title').fill(`里程碑组 ${stale}`);
    // a milestone belongs to the repository: its line stays by the repository picker (GitHub#231)
    await expect(page.getByTestId('new-issue-preset')).toHaveAttribute('data-place', 'repo');
    await expect(page.getByTestId('new-issue-projects').getByTestId('new-issue-preset')).toHaveCount(0);
    // still reading: not offered
    await expect(page.getByTestId('new-issue-preset')).toHaveAttribute('data-blocked', 'yes');
    await expect(page.getByTestId('confirm-ok')).toBeDisabled();
    // GitHub moves on: v1.2 is there and readable; the user goes to B and back to A
    env.fake.state.w.milestones.set('gigleai/cavil-loop', [{ number: 5, title: 'v1.2', state: 'open', due_on: null }]);
    env.fake.state.w.failMilestones.delete('gigleai/cavil-loop');
    await page.getByTestId('new-issue-repo').selectOption('GigleAI/second');
    await expect(line('milestone')).toHaveAttribute('data-applies', 'no');
    await page.getByTestId('new-issue-repo').selectOption('GigleAI/cavil-loop');
    // GitHub#270: it lands — nothing to say
    await expect(line('milestone')).toHaveCount(0);
    // now the first read of A answers
    release();
    await page.waitForTimeout(500);
    await expect(line('milestone')).toHaveCount(0);
    await expect(page.getByTestId('new-issue-preset')).toHaveCount(0);
    await expect(page.getByTestId('confirm-ok')).toBeEnabled();
    // GitHub#405: the group's milestone is said on the shut fold's head line
    await expect(page.getByTestId('new-issue-more-milestone')).toHaveText('v1.2');
    const n = nextNumber();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('detail')).toHaveAttribute('data-key', `gigleai/cavil-loop#${n}`);
    const created = writes().filter((w) => w[0] === 'POST' && w[1] === '/api/repos/GigleAI/cavil-loop/issues').at(-1)!;
    expect(created[2]).toEqual({ title: `里程碑组 ${stale}`, body: '', labels: [], milestone: 5 });
    await expect(group('v1.2').locator(`[data-testid="row"][data-key="gigleai/cavil-loop#${n}"]`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('detail-close').click();
  }

  // ---- 3. the milestone list cannot be read: shown, creating not offered ----
  env.fake.state.w.failMilestones.add('gigleai/cavil-loop');
  await group('v1.2').getByTestId('group-add').click();
  await page.getByTestId('new-issue-title').fill('读不到');
  await expect(line('milestone')).toContainText('读不到');
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  await shot(page, '214-milestone-unreadable');
  await page.getByTestId('confirm-cancel').click();
  env.fake.state.w.failMilestones.delete('gigleai/cavil-loop');

  // ---- 4. offline: every "+" greys out ----
  env.fake.state.offline = true;
  await page.getByTestId('refresh').press('Enter');
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('group-add').first()).toBeDisabled();
  env.fake.state.offline = false;
  await app.close();
});

// ---- GitHub#229: client improvements 5 ----

/** somebody else (or a request that lands late) sets #n's milestone on GitHub, in every copy */
function milestoneOnGitHub(n: number, ms: { number: number; title: string } | null) {
  const c = findCopies(env.fake.state as any, 'GigleAI/cavil-loop', n)!;
  for (const r of c.rest) r.milestone = ms ? { number: ms.number, title: ms.title, due_on: null } : null;
  for (const g of c.gql) g.milestone = ms ? { number: ms.number, title: ms.title, dueOn: null } : null;
}

test('GitHub#229: gear; short detail head; label list retried; re-opened detail shows at once; a change shows at once, a refused / unanswered one stays with both values and is sent again only after a check; whole group rows fold; a new issue never holds the dialog', async () => {
  env.fake.state.w.milestones.set('gigleai/cavil-loop', [
    { number: 9, title: 'v9', state: 'open', due_on: null },
    { number: 10, title: 'v10', state: 'open', due_on: null },
  ]);
  // the label / milestone lists fail until the first retry
  env.fake.state.w.failMilestones.add('gigleai/cavil-loop');
  const { app, page } = await launch(env);
  await signInWithSources(page);

  // ① settings: a gear with teeth, not a dot with rays
  const gear = await page.getByTestId('open-settings').locator('svg path').first().getAttribute('d');
  expect((gear ?? '').match(/L/g)?.length ?? 0).toBeGreaterThan(20);
  await shot(page, '229-01-gear');

  // ② the head is one short line: author beside the number; a failed list says so in a few words, with a retry
  await card(page, 139).getByTestId('card-title').click();
  const detail = page.getByTestId('detail');
  await expect(detail.locator('.detail-head [data-testid="detail-people"]')).toBeVisible();
  await expect(detail.getByTestId('options-error')).toContainText('没读到标签 / 里程碑列表');
  const headH = await detail.locator('.detail-head').evaluate((e) => e.getBoundingClientRect().height);
  expect(headH).toBeLessThanOrEqual(40);
  await shot(page, '229-02-head-list-failed');
  env.fake.state.w.failMilestones.delete('gigleai/cavil-loop');
  await detail.getByTestId('options-retry').click();
  await expect(detail.getByTestId('options-error')).toHaveCount(0);
  await expect(detail.locator('[data-testid="milestone-select"] option', { hasText: 'v9' })).toHaveCount(1);

  // ③ re-opening: the last read shows at once, marked, while the new read is held
  await page.getByTestId('detail-close').click();
  const releaseDetail = env.fake.holdWhen((e) => e.operation === 'CavilItemDetail' && e.variables?.number === 139);
  await card(page, 139).getByTestId('card-title').click();
  await expect(detail.getByTestId('detail-cached')).toContainText('正在更新');
  await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry').first()).toBeVisible();
  await shot(page, '229-03-cached-detail');
  releaseDetail();
  await expect(detail.getByTestId('detail-cached')).toHaveCount(0);

  // ④ a label GitHub refuses: kept, marked "not saved" with both values; the card says so; resend after GitHub accepts again
  env.fake.state.w.failLabel = 'pending/PR';
  await pickLabel(page, 'pending/PR');
  const issue = page.locator('[data-testid="notice-area"] [data-testid="edit-issue"][data-field="label"]');
  await expect(issue).toHaveAttribute('data-edit', 'failed');
  await expect(issue.getByTestId('edit-target')).toContainText('加上「pending/PR」');
  await expect(card(page, 139).getByTestId('card-edit-flag')).toBeVisible();
  await expect(page.getByTestId('edits-bar')).toHaveAttribute('data-count', '1');
  await shot(page, '229-04-label-not-saved');
  env.fake.state.w.failLabel = null;
  const posts = () => env.fake.writes().filter((w) => w.method === 'POST' && w.path.endsWith('/issues/139/labels')).length;
  const p0 = posts();
  await openNotices(page);
  await issue.getByTestId('edit-resend').click();
  await expect(page.getByTestId('notice-area').getByTestId('edit-issues')).toHaveCount(0);
  await expect(detail.locator('[data-testid="detail-label"][data-label="pending/PR"]')).toBeVisible();
  // shown at once ("saving"), then confirmed: the mark goes once GitHub answered and it was read back
  await expect.poll(() => posts()).toBe(p0 + 1);
  await expect(detail.locator('[data-testid="detail-label"][data-label="pending/PR"]')).toHaveAttribute('data-edit', '');
  await expect(page.getByTestId('edits-bar')).toHaveCount(0);

  // ⑤ no answer for a milestone, somebody sets another one meanwhile: the resend is held ("overwrite anyway")
  env.fake.state.w.dropWrites = true;
  await detail.getByTestId('milestone-select').selectOption('v9');
  const ms = page.locator('[data-testid="notice-area"] [data-testid="edit-issue"][data-field="milestone"]');
  await expect(ms).toHaveAttribute('data-edit', 'unconfirmed');
  env.fake.state.w.dropWrites = false;
  milestoneOnGitHub(139, { number: 10, title: 'v10' });
  const patches = () => env.fake.writes().filter((w) => w.method === 'PATCH' && w.path.endsWith('/issues/139')).length;
  const m0 = patches();
  await openNotices(page);
  await ms.getByTestId('edit-resend').click();
  await expect(ms.getByTestId('edit-hold')).toContainText('你改之后有人改成了「v10」');
  await expect(ms.getByTestId('edit-github')).toContainText('v10');
  await expect(ms.getByTestId('edit-force')).toHaveText('仍然覆盖');
  expect(patches()).toBe(m0);
  await shot(page, '229-05-held-resend');
  await ms.getByTestId('edit-force').click();
  await expect(page.getByTestId('notice-area').getByTestId('edit-issues')).toHaveCount(0);
  await expect(detail.getByTestId('milestone-select')).toHaveValue('v9');
  await expect.poll(() => patches()).toBe(m0 + 1);
  await expect(detail.locator('[data-testid="edit-status"][data-field="milestone"]')).toHaveCount(0);
  await page.getByTestId('detail-close').click();

  // ⑥ the table: a click anywhere on a group heading folds it; the arrow still toggles once
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  const group = page.getByTestId('group').first();
  const rows = group.getByTestId('row');
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  const headCell = group.getByTestId('group-head').locator('td');
  const box = (await headCell.boundingBox())!;
  await page.mouse.click(box.x + box.width - 40, box.y + box.height / 2);
  await expect(rows).toHaveCount(0);
  await page.mouse.click(box.x + box.width - 40, box.y + box.height / 2);
  await expect(rows.first()).toBeVisible();
  await group.getByTestId('group-toggle').click();
  await expect(rows).toHaveCount(0);
  await group.getByTestId('group-toggle').click();
  await expect(rows.first()).toBeVisible();
  await shot(page, '229-06-table-group-row');

  // ⑦ a new issue with no answer: the dialog closed at once; "not sure" — no create button, the draft can be copied
  env.fake.state.w.dropWrites = true;
  await page.getByTestId('write-entry').click();
  await page.getByTestId('new-issue-title').fill('UNSURE_229');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  const unsure = page.locator('[data-testid="create-bar"][data-status="unknown"]');
  await expect(unsure).toContainText('不确定「UNSURE_229」有没有建好');
  await expect(unsure.getByTestId('create-reopen')).toHaveCount(0);
  await expect(unsure.getByTestId('create-copy')).toBeVisible();
  await shot(page, '229-07-create-unsure');
  await unsure.getByTestId('create-bar-close').click();
  env.fake.state.w.dropWrites = false;

  // ⑧ refused for sure: the draft comes back with everything typed
  env.fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
  await page.getByTestId('write-entry').click();
  await page.getByTestId('new-issue-title').fill('REFUSED_229');
  await page.getByTestId('new-issue-body').fill('正文 229');
  await page.getByTestId('confirm-ok').click();
  const refused = page.locator('[data-testid="create-bar"][data-status="failed"]');
  await expect(refused).toContainText('没能新建「REFUSED_229」');
  await shot(page, '229-08-create-refused');
  await refused.getByTestId('create-reopen').click();
  await expect(page.getByTestId('new-issue-title')).toHaveValue('REFUSED_229');
  await expect(page.getByTestId('new-issue-body')).toHaveValue('正文 229');
  expect(env.fake.writes().filter((w) => w.method === 'POST' && w.path === '/api/repos/GigleAI/cavil-loop/issues')).toHaveLength(1);
  await app.close();
});

test('GitHub#231: 托管 asks in three paragraphs with "不再提示"; folded table groups survive the board and a restart; "no value" groups last; both iteration pickers in the same order; a new issue ticks the repository\'s board when only the repository is shown', async () => {
  let { app, page } = await launch(env);
  await signInWithSources(page);

  // ---- 1. 托管: three paragraphs; "不再提示" unticked; cancel keeps asking; ticked + confirmed → no dialog next time ----
  await card(page, 138).click();
  const quick = page.getByTestId('detail').locator('.reply .row.end');
  await expect(quick.getByTestId('autopilot')).toHaveText('托管（自动合并）…Ctrl+Shift+C');
  await quick.getByTestId('autopilot').click();
  for (const part of ['labels', 'then', 'stop']) await expect(page.getByTestId(`autopilot-explain-${part}`)).toBeVisible();
  await expect(page.getByTestId('autopilot-explain').locator('p')).toHaveCount(3);
  const noMore = page.getByTestId('autopilot-no-more-ask');
  await expect(noMore).not.toBeChecked();
  await noMore.check();
  await shot(page, '231-01-autopilot-confirm');
  await page.getByTestId('confirm-cancel').click();
  await quick.getByTestId('autopilot').click();
  await expect(noMore).not.toBeChecked(); // a cancelled tick was not kept
  await noMore.check();
  const b1 = writes().length;
  await page.getByTestId('confirm-ok').click();
  await expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first().getByTestId('op-notice-text')).toContainText('已托管');
  const autopilotWrites = (n: number) => [
    ['POST', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels`, { labels: ['autopilot'] }],
    ['POST', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels`, { labels: ['pending/agent'] }],
    ['DELETE', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels/pending%2Fhuman`, undefined],
  ];
  expect(writes().slice(b1)).toEqual(autopilotWrites(138));
  await page.getByTestId('detail-close').click();
  // another item: the button has no "…", one click writes, no dialog
  await card(page, 139).click();
  await expect(quick.getByTestId('autopilot')).toHaveText('托管（自动合并）Ctrl+Shift+C');
  const b2 = writes().length;
  await quick.getByTestId('autopilot').click();
  await expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first().getByTestId('op-notice-text')).toContainText('已托管');
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  expect(writes().slice(b2)).toEqual(autopilotWrites(139));

  // ---- 2. the detail's iteration picker: current → upcoming nearest first → ended latest first ----
  const detailPick = page.getByTestId('iteration-select').first();
  const groups = await detailPick.locator('optgroup').evaluateAll((gs) => gs.map((g) => g.getAttribute('label')));
  expect(groups.length).toBeGreaterThan(0);
  expect(['当前', '即将开始', '已结束'].filter((l) => groups.includes(l))).toEqual(groups);
  const detailOptions = await detailPick.evaluate((sel: HTMLSelectElement) =>
    [...sel.querySelectorAll('optgroup option')].map((o) => ({ id: (o as HTMLOptionElement).value, text: o.textContent!, part: o.parentElement!.getAttribute('label')! })),
  );
  const start = (t: string) => /（(\d{4}-\d{2}-\d{2}) 起）/.exec(t)![1];
  const upcoming = detailOptions.filter((o) => o.part === '即将开始').map((o) => start(o.text));
  const ended = detailOptions.filter((o) => o.part === '已结束').map((o) => start(o.text));
  expect(upcoming).toEqual([...upcoming].sort());
  expect(ended).toEqual([...ended].sort().reverse());
  for (const o of detailOptions.filter((o) => o.part === '当前')) expect(o.text).toContain('（当前）');
  // every iteration listed once, before or after today as its part says
  expect(new Set(detailOptions.map((o) => o.id)).size).toBe(detailOptions.length);
  await page.getByTestId('detail-close').click();

  // ---- 3. table: "no iteration" last; a folded group stays folded across the board and a restart; per grouping ----
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await expect(page.getByTestId('table')).toBeVisible();
  await page.getByTestId('search').fill('');
  await expect.poll(async () => (await tableShape(page)).length, { timeout: 15_000 }).toBeGreaterThan(1);
  await expect.poll(async () => (await tableShape(page)).at(-1)!.title).toBe('无迭代');
  const group = (title: string) => page.locator(`[data-testid="group"][data-title="${title}"]`);
  await expect(group('Iteration 25').getByTestId('row').first()).toBeVisible();
  await group('Iteration 25').getByTestId('group-toggle').click();
  await expect(group('Iteration 25').getByTestId('row')).toHaveCount(0);
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await expect(group('Iteration 25')).toBeVisible();
  await expect(group('Iteration 25').getByTestId('row')).toHaveCount(0);
  await expect(group('无迭代').getByTestId('row').first()).toBeVisible();
  await shot(page, '231-02-table-folded');
  await app.close();
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await expect(group('Iteration 25')).toBeVisible({ timeout: 15_000 });
  await expect(group('Iteration 25').getByTestId('row')).toHaveCount(0);
  // grouped by status: its own folds (none yet), "no status" last
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('status');
  await expect.poll(async () => (await tableShape(page)).at(-1)!.title, { timeout: 15_000 }).toBe('无状态');
  for (const g of await tableShape(page)) expect(g.rows.length, g.title).toBeGreaterThan(0);
  await page.getByTestId('group-by').selectOption('iteration');
  await expect(group('Iteration 25').getByTestId('row')).toHaveCount(0);
  await group('Iteration 25').getByTestId('group-toggle').click();
  await expect(group('Iteration 25').getByTestId('row').first()).toBeVisible();

  // ---- 4. the table cell's iteration picker lists the same iterations in the same order as the detail's ----
  const columns = page.locator('[data-testid="columns-pick"] input[data-col="iteration"]');
  if (!(await columns.isChecked())) await columns.check();
  await page.getByTestId('open-view-panel').click();
  const row = page.locator('[data-testid="row"][data-key="gigleai/cavil-loop#139"]').first();
  await row.locator('[data-testid="cell"][data-col="iteration"]').click();
  const cellOptions = await row.getByTestId('cell-iteration').first().evaluate((sel: HTMLSelectElement) =>
    [...sel.querySelectorAll('optgroup option')].map((o) => ({ id: (o as HTMLOptionElement).value, part: o.parentElement!.getAttribute('label')! })),
  );
  expect(cellOptions).toEqual(detailOptions.map(({ id, part }) => ({ id, part })));

  // ---- 5. only the repository shown at the top: a new issue still starts on the board holding its items ----
  await showSource(page, '[data-key^="project:"]', false);
  await page.getByTestId('write-entry').click();
  await expect(page.getByTestId('new-issue-repo')).toHaveValue('GigleAI/cavil-loop');
  await expect(page.getByTestId('new-issue-project')).toBeChecked();
  await expect(page.getByTestId('new-issue-project-unsynced')).toHaveCount(0);
  await shot(page, '231-03-new-issue-default-board');
  // ticked off by hand: kept
  await page.getByTestId('new-issue-project').uncheck();
  await expect(page.getByTestId('new-issue-projects-hint')).toContainText('不加入任何看板');
  await page.getByTestId('confirm-cancel').click();

  // ---- 6. ticked back in Settings: 托管 asks again ----
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('autopilot-confirm')).not.toBeChecked();
  await page.getByTestId('autopilot-confirm').check();
  await page.getByTestId('back').click();
  await showSource(page, '[data-key^="project:"]', true);
  await page.locator('[data-testid="row"][data-key="gigleai/cavil-loop#137"] [data-testid="row-title"]').first().click();
  await expect(page.getByTestId('detail').locator('.reply .row.end').getByTestId('autopilot')).toHaveText('托管（自动合并）…Ctrl+Shift+C');
  await app.close();
});

test('GitHub#231 (PR #241 review round 1): new issue while boards are not read yet — "not synced yet", never "no board added"; the default follows the first complete read', async () => {
  const { app, page } = await launch(env);
  await signIn(page);
  const dialogOpen = async () => {
    await page.getByTestId('write-entry').click();
    await expect(page.getByTestId('new-issue-repo')).toHaveValue('GigleAI/cavil-loop');
  };
  const unsynced = page.getByTestId('new-issue-project-unsynced');

  // ---- 1. no board added at all: says so ----
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill('GigleAI/cavil-loop');
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await expect.poll(async () => (await page.evaluate(async () => (await (window as any).cavil.get()).data.items.length)) as number, { timeout: 15_000 }).toBeGreaterThan(0);
  await dialogOpen();
  await expect(page.getByTestId('new-issue-projects-none')).toBeVisible();
  await expect(page.getByTestId('new-issue-projects-none-synced')).toHaveCount(0);
  await expect(unsynced).toHaveCount(0);
  await page.getByTestId('confirm-cancel').click();

  // ---- 2. the only board added, its first read failing: "not synced yet", not "no board added" ----
  env.fake.state.failProjectPage.set(P11, 0);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill(PROJECT_URL);
  await page.getByTestId('source-add').click();
  await expect(sourceErr(page, 'project:org/gigleai/11')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('back').click();
  await dialogOpen();
  await expect(page.getByTestId('new-issue-projects-none-synced')).toBeVisible();
  await expect(page.getByTestId('new-issue-projects-none')).toHaveCount(0);
  await expect(page.getByTestId('new-issue-project')).toHaveCount(0);
  await expect(unsynced).toHaveCount(1);
  await expect(unsynced).toHaveAttribute('data-project', 'project:org/gigleai/11');
  await shot(page, '231-04-new-issue-board-not-synced');

  // ---- 3. the read succeeds while the dialog is open (nothing ticked by hand): the board shows up ticked ----
  env.fake.state.failProjectPage.delete(P11);
  // GitHub#374: a board whose read just failed waits a minute for the next automatic read; the refresh by hand does not
  await page.evaluate(() => (window as any).cavil.restartSync());
  await expect(page.getByTestId('new-issue-project')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId('new-issue-project')).toBeChecked();
  await expect(unsynced).toHaveCount(0);
  await expect(page.getByTestId('new-issue-projects-none-synced')).toHaveCount(0);
  await page.getByTestId('confirm-cancel').click();

  // ---- 4. one board read, another never read (it cannot be found): the read one is ticked, the other is said ----
  await page.getByTestId('open-settings').click();
  await page.getByTestId('source-input').fill('https://github.com/orgs/GigleAI/projects/99');
  await page.getByTestId('source-add').click();
  await expect(sourceErr(page, 'project:org/gigleai/99')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('back').click();
  await dialogOpen();
  await expect(page.getByTestId('new-issue-project')).toHaveCount(1);
  await expect(page.getByTestId('new-issue-project')).toBeChecked();
  await expect(unsynced).toHaveCount(1);
  await expect(unsynced).toHaveAttribute('data-project', 'project:org/gigleai/99');
  // ticked off by hand: the default no longer speaks for itself, the note goes with it
  await page.getByTestId('new-issue-project').uncheck();
  await expect(unsynced).toHaveCount(0);
  await expect(page.getByTestId('new-issue-project')).not.toBeChecked();
  await page.getByTestId('confirm-cancel').click();
  await app.close();
});

// ---- GitHub#250: closing does not hold the dialog ----

test('GitHub#250: "确认关闭" closes the dialog at once while GitHub has not answered; the panel opened again cannot close it twice; a refused close gives the reason and the comment back', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const openOnGitHub = (n: number) => {
    const c = findCopies(store, 'GigleAI/cavil-loop', n)!;
    for (const g of c.gql) Object.assign(g, { state: 'OPEN', stateReason: null });
    for (const r of c.rest) Object.assign(r, { state: 'open', state_reason: null });
  };
  openOnGitHub(137);
  openOnGitHub(139);
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const detail = page.getByTestId('detail');
  const open = async (n: number) => {
    await page.getByTestId('search').fill(`#${n}`);
    if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').click();
    await card(page, n).click();
    await expect(detail).toHaveAttribute('data-key', `gigleai/cavil-loop#${n}`);
    await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
  };
  const notice = page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first();
  const noticeText = notice.getByTestId('op-notice-text');
  const dialog = page.getByTestId('confirm-dialog');

  // ---- 1. GitHub holds its answer: the dialog is gone at once, the rest of the panel works ----
  const release = env.fake.holdWhen((e) => e.method === 'PATCH' && e.path === '/api/repos/GigleAI/cavil-loop/issues/137');
  await open(137);
  await page.getByTestId('close-issue').click();
  await page.getByTestId('close-comment').fill('做完了');
  await page.getByTestId('confirm-ok').click();
  await expect(dialog).toHaveCount(0);
  await expect(noticeText).toHaveText('正在关闭 issue #137…');
  await expect(notice).toHaveAttribute('data-kind', 'busy');
  await expect(page.getByTestId('reply-input')).toBeEnabled();
  await expect(page.getByTestId('close-issue')).toBeDisabled();
  await expect(page.getByTestId('close-issue')).toHaveAttribute('title', /^上一次操作还没结清：正在关闭 issue #137…/);
  await expect.poll(() => env.fake.writes().filter((w) => w.method === 'PATCH').length).toBe(1);
  await shot(page, '250-01-closing-dialog-gone');
  // put away and opened again: the notice waited above the board, the close entry is still off
  await page.getByTestId('detail-close').click();
  await expect(page.locator('[data-testid="op-notice"][data-key="gigleai/cavil-loop#137"]')).toBeVisible();
  await open(137);
  // GitHub already carried the close out (only its answer is held), so the detail reads it closed and
  // offers no close; what still conflicts — hand to the agent — is off, with the reason
  await expect(page.getByTestId('hand-back')).toBeDisabled();
  await expect(page.getByTestId('hand-back')).toHaveAttribute('title', /^上一次操作还没结清：正在关闭 issue #137…/);
  await expect(page.getByTestId('reply-input')).toBeEnabled();
  release();
  await expect(noticeText).toHaveText('issue #137 已关闭（已完成），评论已发出');
  await expect(notice).toHaveAttribute('data-kind', 'ok');
  await expect(page.getByTestId('close-issue')).toHaveCount(0);
  expect(writes().filter((w) => String(w[1]).includes('/issues/137'))).toEqual([
    ['PATCH', '/api/repos/GigleAI/cavil-loop/issues/137', { state: 'closed', state_reason: 'completed' }],
    ['POST', '/api/repos/GigleAI/cavil-loop/issues/137/comments', { body: '做完了' }],
  ]);
  await shot(page, '250-02-closed');
  await page.getByTestId('detail-close').click();

  // ---- 2. refused by GitHub: the reason is said; "重新关闭" brings back the reason and the comment ----
  env.fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
  await open(139);
  await page.getByTestId('close-issue').click();
  await page.getByTestId('close-reason-not_planned').check();
  await page.getByTestId('close-comment').fill('不做了');
  await page.getByTestId('confirm-ok').click();
  await expect(dialog).toHaveCount(0);
  await expect(notice).toHaveAttribute('data-kind', 'error');
  await expect(noticeText).toContainText('没有关闭 issue #139：没有权限');
  await expect(notice.getByTestId('op-draft-comment')).toContainText('不做了');
  await shot(page, '250-03-close-refused');
  expect(writes().filter((w) => String(w[1]).includes('/issues/139/comments'))).toEqual([]);
  env.fake.state.w.readOnlyRepos.clear();
  await openNotices(page);
  await notice.getByTestId('op-retry').click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('close-reason-not_planned')).toBeChecked();
  await expect(page.getByTestId('close-comment')).toHaveValue('不做了');
  await page.getByTestId('confirm-ok').click();
  await expect(dialog).toHaveCount(0);
  // GitHub#447: this time GitHub took it: the panel (the opening it was sent from) puts itself away; the result is in the strip on top
  await expect(detail).toHaveCount(0, { timeout: 15_000 });
  const n139 = page.locator('[data-testid="op-notice"][data-key="gigleai/cavil-loop#139"]');
  await expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"][data-key="gigleai/cavil-loop#139"]').getByTestId('op-notice-text')).toHaveText('issue #139 已关闭（不计划），评论已发出');
  expect(writes().filter((w) => String(w[1]).includes('/issues/139'))).toEqual([
    ['PATCH', '/api/repos/GigleAI/cavil-loop/issues/139', { state: 'closed', state_reason: 'not_planned' }],
    ['PATCH', '/api/repos/GigleAI/cavil-loop/issues/139', { state: 'closed', state_reason: 'not_planned' }],
    ['POST', '/api/repos/GigleAI/cavil-loop/issues/139/comments', { body: '不做了' }],
  ]);
  // the refused one handed its draft on: one notice left for #139 in the whole window
  await expect(n139).toHaveCount(1);
  await app.close();
});

test('GitHub#450: new issue — 交给 agent / 托管 are buttons that create at once, pressed by ⌘⇧Z / ⌘⇧C from the title too; greyed buttons and a covered dialog take no key', async () => {
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const w = env.fake.state.w;
  const REPO_KEY = 'gigleai/cavil-loop';
  w.repoLabels.set(REPO_KEY, ['bug', 'autopilot', 'pending/agent', 'pending/human'].map((name) => ({ name, color: 'ededed' })));
  const agentBtn = page.getByTestId('new-issue-agent');
  const autoBtn = page.getByTestId('new-issue-autopilot');
  const dialogs = page.getByTestId('confirm-dialog');
  const creates = () => writes().filter((x) => x[0] === 'POST' && x[1] === '/api/repos/GigleAI/cavil-loop/issues').map((x) => x[2]);
  /** opens the dialog; unless the label read is held on purpose, waits for it to land (a key before that does nothing, by design) */
  const open = async (title = '', held = false) => {
    await page.getByTestId('write-entry').click();
    await expect(page.getByTestId('new-issue')).toBeVisible();
    if (!held) await expect(agentBtn).not.toHaveAttribute('data-state', 'loading');
    if (title) await page.getByTestId('new-issue-title').fill(title);
  };
  /** the dialog closed and GitHub got exactly one more create request, this one */
  const created = async (n: number, want: unknown) => {
    await expect(dialogs).toHaveCount(0);
    await expect.poll(() => creates().length).toBe(n);
    expect(creates().at(-1)).toEqual(want);
    await page.getByTestId('detail-close').click();
  };
  /** a key that must create nothing: give it time, then the count is unchanged */
  const nothing = async (n: number) => {
    await page.waitForTimeout(300);
    expect(creates().length).toBe(n);
  };
  const keyAgent = () => page.keyboard.press(`${MOD}+Shift+Z`);
  const keyAuto = () => page.keyboard.press(`${MOD}+Shift+C`);

  // ---- 1. no "建好后" choice any more; the row is 取消 · 交给 agent · 托管 · 创建, each with its key ----
  await open();
  await expect(page.locator('[data-testid="new-issue"] input[type="radio"]')).toHaveCount(0);
  await expect(agentBtn).toContainText('交给 agent');
  await expect(agentBtn.locator('kbd')).toHaveText(/(⌘⇧Z|Ctrl\+Shift\+Z)/);
  await expect(autoBtn).toContainText('托管（自动合并）…');
  await expect(autoBtn.locator('kbd')).toHaveText(/(⌘⇧C|Ctrl\+Shift\+C)/);
  await expect(page.getByTestId('confirm-ok').locator('kbd')).toHaveCount(1);
  // nothing typed yet: the two buttons are grey and their keys do nothing
  await expect(agentBtn).toBeDisabled();
  await expect(autoBtn).toBeDisabled();
  await page.getByTestId('new-issue-title').focus();
  await keyAgent();
  await keyAuto();
  await nothing(0);
  await expect(dialogs).toHaveCount(1);
  await page.getByTestId('new-issue-title').fill('普通');
  await expect(agentBtn).toBeEnabled();
  await expect(autoBtn).toBeEnabled();
  await shot(page, '450-01-new-issue-buttons');
  // ⌘↩ from the title: a plain issue, exactly as before
  await page.keyboard.press(`${MOD}+Enter`);
  await created(1, { title: '普通', body: '', labels: [] });

  // ---- 2. ⌘⇧Z typed in the title: created at once with the agent label; the button does the same ----
  await open('键交给 agent');
  await keyAgent();
  await created(2, { title: '键交给 agent', body: '', labels: ['pending/agent'] });
  await open('点交给 agent');
  await page.getByTestId('new-issue-body').fill('正文里');
  await agentBtn.click();
  await created(3, { title: '点交给 agent', body: '正文里', labels: ['pending/agent'] });
  // nothing is remembered: the next plain 创建 carries no hand-over label
  await open('又一个普通的');
  await page.getByTestId('confirm-ok').click();
  await created(4, { title: '又一个普通的', body: '', labels: [] });

  // ---- 3. 托管 with "托管前确认" on (the default): the confirmation first; under it the two keys do nothing ----
  await open('托管的');
  await page.getByTestId('new-issue-body').focus();
  await keyAuto();
  await expect(dialogs).toHaveCount(2);
  await expect(page.getByTestId('new-issue-autopilot-explain')).toContainText('建好后会加上标签 autopilot 和 pending/agent');
  await shot(page, '450-02-new-issue-autopilot-confirm');
  await nothing(4);
  await keyAgent();
  await keyAuto();
  await nothing(4);
  await expect(dialogs).toHaveCount(2);
  // PR #459 review round 1: the keyboard cannot reach the covered dialog — Shift+Tab then Space right after it
  // opened stays in the confirmation (which Space then presses: 取消, nothing created, the draft kept) …
  const focusIn = () => page.evaluate(() => {
    const d = document.activeElement?.closest('[data-testid="confirm-dialog"]');
    return d ? (d.querySelector('[data-testid="new-issue-autopilot-explain"]') ? 'confirm' : 'covered') : 'outside';
  });
  await expect(dialogs.first()).toHaveAttribute('data-covered', 'yes');
  // the keyboard starts on the confirmation's 取消; the reviewer's path — Shift+Tab, Space — only ticks "不再提示"
  await expect(dialogs.last().getByTestId('confirm-cancel')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await focusIn()).toBe('confirm');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('new-issue-autopilot-no-more-ask')).toBeChecked();
  await nothing(4);
  await expect(dialogs).toHaveCount(2);
  await page.getByTestId('new-issue-autopilot-no-more-ask').uncheck();
  // … round and round both ways, never out of it
  for (const k of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(k);
    expect(await focusIn(), k).toBe('confirm');
  }
  // the covered 创建 cannot even be given the focus
  await page.getByTestId('confirm-ok').first().evaluate((b) => (b as HTMLElement).focus());
  expect(await focusIn()).toBe('confirm');
  await nothing(4);
  await expect(dialogs).toHaveCount(2);
  // Space on the confirmation's 取消: back to the dialog, nothing created, the typed title still there, the title has the keyboard
  await dialogs.last().getByTestId('confirm-cancel').focus();
  await page.keyboard.press('Space');
  await expect(dialogs).toHaveCount(1);
  await nothing(4);
  await expect(page.getByTestId('new-issue-title')).toHaveValue('托管的');
  await expect(page.getByTestId('new-issue-title')).toBeFocused();
  await expect(dialogs.first()).not.toHaveAttribute('data-covered', 'yes');
  // open it again for the "不再提示" case below
  await keyAuto();
  await expect(dialogs).toHaveCount(2);
  // cancelled with "不再提示" ticked: nothing created, the tick not kept, the typed text still there
  await page.getByTestId('new-issue-autopilot-no-more-ask').check();
  await dialogs.last().getByTestId('confirm-cancel').click();
  await expect(dialogs).toHaveCount(1);
  await expect(page.getByTestId('new-issue-title')).toHaveValue('托管的');
  await nothing(4);
  await expect(autoBtn).toContainText('…');
  // the keys work again once it is gone
  await keyAgent();
  await created(5, { title: '托管的', body: '', labels: ['pending/agent'] });
  // confirmed: exactly one create, with both labels; ⌘↩ inside it confirms it
  await open('确认托管的');
  await autoBtn.click();
  await expect(dialogs).toHaveCount(2);
  await page.keyboard.press(`${MOD}+Enter`);
  await created(6, { title: '确认托管的', body: '', labels: ['autopilot', 'pending/agent'] });
  await nothing(6);
  // confirmed with "不再提示": the setting is switched off …
  await open('不再提示');
  await keyAuto();
  await page.getByTestId('new-issue-autopilot-no-more-ask').check();
  await dialogs.last().getByTestId('confirm-ok').click();
  await created(7, { title: '不再提示', body: '', labels: ['autopilot', 'pending/agent'] });
  // … so 托管 now creates at once, with no confirmation and no "…"
  await open('直接托管');
  await expect(autoBtn).toHaveText(/^托管（自动合并）(⌘⇧C|Ctrl\+Shift\+C)$/);
  await keyAuto();
  await created(8, { title: '直接托管', body: '', labels: ['autopilot', 'pending/agent'] });

  // ---- 4. the label list cannot be read: both grey, "读不到" said (never "没有标签"); 创建 still works ----
  w.failLabels.add(REPO_KEY);
  await open('读不到标签');
  await expect(agentBtn).toBeDisabled();
  await expect(autoBtn).toBeDisabled();
  await expect(page.getByTestId('new-issue-handoff-why')).toContainText('读不到仓库 GigleAI/cavil-loop 的标签');
  await expect(page.getByTestId('new-issue-handoff-why')).not.toContainText('没有标签');
  await expect(page.getByTestId('new-issue-more-labels')).toHaveText('标签读取失败');
  await shot(page, '450-03-new-issue-labels-unreadable');
  await keyAgent();
  await keyAuto();
  await nothing(8);
  await page.getByTestId('confirm-ok').click();
  await created(9, { title: '读不到标签', body: '', labels: [] });
  w.failLabels.delete(REPO_KEY);

  // ---- 5. the repository really lacks the autopilot label: only 托管 is grey, with why; 交给 agent works ----
  w.repoLabels.set(REPO_KEY, ['bug', 'pending/agent'].map((name) => ({ name, color: 'ededed' })));
  await open('缺托管标签');
  await expect(autoBtn).toBeDisabled();
  await expect(autoBtn).toHaveAttribute('data-state', 'missing');
  await expect(agentBtn).toBeEnabled();
  await expect(page.getByTestId('new-issue-handoff-why')).toHaveText('仓库 GigleAI/cavil-loop 没有标签「autopilot」');
  await keyAuto();
  await nothing(9);
  await keyAgent();
  await created(10, { title: '缺托管标签', body: '', labels: ['pending/agent'] });

  // ---- 6. still reading the labels: 交给 agent waits (grey, its key does nothing), then works; 创建 does not wait ----
  w.repoLabels.set(REPO_KEY, ['bug', 'autopilot', 'pending/agent'].map((name) => ({ name, color: 'ededed' })));
  const release = env.fake.hold('/labels');
  await open('等标签', true);
  await expect(agentBtn).toHaveAttribute('data-state', 'loading');
  await expect(agentBtn).toBeDisabled();
  await expect(agentBtn).toHaveAttribute('title', '正在读取仓库 GigleAI/cavil-loop 的标签…');
  await expect(page.getByTestId('confirm-ok')).toBeEnabled();
  await keyAgent();
  await nothing(10);
  // the web page carries only the labels picked here (there is no hand-over choice to carry)
  await page.getByTestId('new-issue-body').fill('看图');
  await pasteImage(page, '[data-testid="new-issue-body"]');
  await expect(page.getByTestId('paste-image-web')).toBeEnabled();
  await page.getByTestId('paste-image-web').click();
  await expect.poll(() => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '')).toMatch(/title=%E7%AD%89%E6%A0%87%E7%AD%BE&body=%E7%9C%8B%E5%9B%BE\n/);
  release();
  await expect(agentBtn).toBeEnabled();
  await agentBtn.click();
  await created(11, { title: '等标签', body: '看图', labels: ['pending/agent'] });

  // ---- 7. another dialog (关闭 issue): ⌘⇧Z / ⌘⇧C are nobody's there — no label write, no new issue ----
  await page.getByTestId('search').fill('#139');
  await card(page, 139).click();
  await page.getByTestId('close-issue').click();
  await expect(dialogs).toHaveCount(1);
  const before = writes().length;
  await keyAgent();
  await keyAuto();
  await page.waitForTimeout(300);
  expect(writes().length).toBe(before);
  await expect(dialogs).toHaveCount(1);
  await page.getByTestId('confirm-cancel').click();
  await page.getByTestId('detail-close').click();
  await page.getByTestId('search').fill('');

  // ---- 8. no autopilot label in Settings: no 托管 button and ⌘⇧C does nothing; ⌘⇧Z still creates ----
  await page.getByTestId('open-settings').click();
  await page.getByTestId('hand-back-autopilot').fill('');
  await page.getByTestId('hand-back-autopilot').blur();
  await page.getByTestId('back').click();
  await open('没有托管');
  await expect(autoBtn).toHaveCount(0);
  await keyAuto();
  await nothing(11);
  await keyAgent();
  await created(12, { title: '没有托管', body: '', labels: ['pending/agent'] });

  // ---- 9. refused for sure after 交给 agent: the draft comes back saying which button it was; a plain one says nothing ----
  w.readOnlyRepos.add(REPO_KEY);
  await open('被拒的交接');
  await expect(agentBtn).toBeEnabled();
  await keyAgent();
  const refused = page.locator('[data-testid="create-bar"][data-status="failed"]');
  await expect(refused).toContainText('没能新建「被拒的交接」');
  await refused.getByTestId('create-reopen').click();
  await expect(page.getByTestId('new-issue-title')).toHaveValue('被拒的交接');
  await expect(page.getByTestId('new-issue-draft-handoff')).toHaveAttribute('data-handoff', 'agent');
  await expect(page.getByTestId('new-issue-draft-handoff')).toContainText('上次是按「交给 agent」建的，没有建成');
  await page.getByTestId('confirm-cancel').click();
  await page.getByTestId('write-entry').click();
  await page.getByTestId('new-issue-title').fill('被拒的普通');
  await page.getByTestId('confirm-ok').click();
  const refusedPlain = page.locator('[data-testid="create-bar"][data-status="failed"]').filter({ hasText: '被拒的普通' });
  await expect(refusedPlain).toBeVisible();
  await refusedPlain.getByTestId('create-reopen').click();
  await expect(page.getByTestId('new-issue-title')).toHaveValue('被拒的普通');
  await expect(page.getByTestId('new-issue-draft-handoff')).toHaveCount(0);
  w.readOnlyRepos.delete(REPO_KEY);
  await app.close();
});

test('GitHub#250 (PR #255 code review round 1): a reply built from a kept comment, its answer arriving after the panel was put away, finishes that draft — no second copy on GitHub', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const c0 = findCopies(store, 'GigleAI/cavil-loop', 137)!;
  for (const g of c0.gql) Object.assign(g, { state: 'OPEN', stateReason: null });
  for (const r of c0.rest) Object.assign(r, { state: 'open', state_reason: null });
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const detail = page.getByTestId('detail');
  const open = async () => {
    await page.getByTestId('search').fill('#137');
    if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').click();
    await card(page, 137).click();
    await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
    await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
  };
  const notice = page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first();
  // the close is refused: the comment is kept
  env.fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
  await open();
  await page.getByTestId('close-issue').click();
  await page.getByTestId('close-comment').fill('恢复原文');
  await page.getByTestId('confirm-ok').click();
  await expect(notice).toHaveAttribute('data-kind', 'error');
  env.fake.state.w.readOnlyRepos.clear();
  // into the reply box, sent; GitHub keeps it but holds the answer
  await openNotices(page);
  await notice.getByTestId('op-to-reply').click();
  await expect(page.getByTestId('reply-input')).toHaveValue('恢复原文');
  const release = env.fake.holdWhen((e) => e.method === 'POST' && e.path === '/api/repos/GigleAI/cavil-loop/issues/137/comments');
  await page.getByTestId('reply-send').click();
  await expect.poll(() => (env.fake.state.w.comments.get('gigleai/cavil-loop#137') ?? []).length).toBe(1);
  // the panel is put away before the answer comes
  await page.getByTestId('detail-close').click();
  release();
  await expect(page.getByTestId('board-action-result')).toContainText('评论已发出');
  // opened again: the kept comment is gone with its draft; nothing offers to send it again
  await open();
  await expect(page.locator('[data-testid="detail"] [data-testid="op-to-reply"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="op-draft-comment"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="op-draft-line"]')).toHaveCount(0);
  expect((env.fake.state.w.comments.get('gigleai/cavil-loop#137') ?? []).map((x) => x.body)).toEqual(['恢复原文']);
  await app.close();
});

test('GitHub#250 (PR #255 code review round 2): the reply made from a kept comment loses its answer — no "重新关闭" carrying the comment again, one comment on GitHub', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const c0 = findCopies(store, 'GigleAI/cavil-loop', 137)!;
  for (const g of c0.gql) Object.assign(g, { state: 'OPEN', stateReason: null });
  for (const r of c0.rest) Object.assign(r, { state: 'open', state_reason: null });
  const { app, page } = await launch(env);
  await signInWithSources(page);
  await page.getByTestId('search').fill('#137');
  if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').click();
  await card(page, 137).click();
  await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
  const notice = page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first();
  env.fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
  await page.getByTestId('close-issue').click();
  await page.getByTestId('close-comment').fill('未知回复再次关闭');
  await page.getByTestId('confirm-ok').click();
  await expect(notice).toHaveAttribute('data-kind', 'error');
  await openNotices(page);
  await expect(notice.getByTestId('op-retry')).toBeVisible();
  env.fake.state.w.readOnlyRepos.clear();
  await notice.getByTestId('op-to-reply').click();
  const lost = env.fake.dropAnswerWhen((e) => e.method === 'POST' && e.path === '/api/repos/GigleAI/cavil-loop/issues/137/comments');
  await page.getByTestId('reply-send').click();
  await expect(notice).toHaveAttribute('data-phase', 'unknown');
  lost.stop();
  expect(lost.caught()).toBe(1);
  await expect(notice.getByTestId('op-notice-text')).toContainText('用附的评论原文发的回复不确定有没有发出');
  await expect(notice.getByTestId('op-retry')).toHaveCount(0);
  await expect(notice.getByTestId('op-to-reply')).toHaveCount(0);
  await openNotices(page);
  await expect(notice.getByTestId('op-copy')).toBeVisible();
  await expect(page.getByTestId('close-issue')).toBeDisabled();
  await shot(page, '250-04-reply-unknown');
  // GitHub#359: there is no "check again" button — the next sync round checks by itself: the comment list shows a
  // new comment with that text — the comment is done, "重新关闭" comes back without it
  await expect(notice.getByTestId('op-recheck')).toHaveCount(0);
  await page.getByTestId('refresh').click();
  await openNotices(page);
  await expect(notice.getByTestId('op-retry')).toBeVisible();
  await notice.getByTestId('op-retry').click();
  await expect(page.getByTestId('close-comment')).toHaveValue('');
  await expect(page.getByTestId('close-reason-completed')).toBeChecked();
  await page.getByTestId('confirm-cancel').click();
  expect((env.fake.state.w.comments.get('gigleai/cavil-loop#137') ?? []).map((x) => x.body)).toEqual(['未知回复再次关闭']);
  await app.close();
});

test('GitHub#359: a hand-back whose request never got an answer — the notice checks by itself and stays "not sure"; "仍要重发…" asks first (cancel sends nothing), confirm sends it and the rest follows', async () => {
  pinLabels();
  // an open item: nothing is sent again, or by itself, for one that was closed meanwhile
  const copies = findCopies({ projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w }, 'GigleAI/cavil-loop', 138)!;
  for (const g of copies.gql) Object.assign(g, { state: 'OPEN', stateReason: null });
  for (const r of copies.rest) Object.assign(r, { state: 'open', state_reason: null });
  const { app, page } = await launch(env);
  await signInWithSources(page);
  await page.getByTestId('search').fill('#138');
  await card(page, 138).click();
  const detail = page.getByTestId('detail');
  await expect(detail.getByTestId('hand-back')).toBeVisible({ timeout: 15_000 });
  const adds = () => env.fake.writes().filter((w) => w.method === 'POST' && w.path === '/api/repos/GigleAI/cavil-loop/issues/138/labels' && ((w.body as any)?.labels ?? []).includes('pending/agent')).length;
  const labels = () => (env.fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.number === 138)?.labels ?? []).map((l: any) => l.name);
  // the request leaves the app, GitHub never carries it out (until `land`), the connection drops
  const late = env.fake.lateWhen((e) => e.method === 'POST' && e.path === '/api/repos/GigleAI/cavil-loop/issues/138/labels');
  await detail.getByTestId('hand-back').click();
  const notice = page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first();
  await openNotices(page);
  // checked by itself (at once, then three more times): in the end still "not sure", never "it was not added"
  await expect(notice.getByTestId('op-resend')).toBeVisible({ timeout: 60_000 });
  await expect(notice).toHaveAttribute('data-phase', 'unknown');
  await expect(notice.getByTestId('op-notice-text')).toContainText('「pending/agent」不确定有没有加上');
  await expect(notice.getByTestId('op-notice-text')).toContainText('到现在还没查到；原来那次请求仍可能稍后生效');
  await expect(notice.getByTestId('op-unlock')).toBeVisible();
  await expect(notice.getByTestId('op-recheck')).toHaveCount(0);
  await expect(notice.getByTestId('op-open-web')).toHaveCount(0);
  await expect(detail.getByTestId('hand-back')).toBeDisabled();
  expect(late.caught()).toBe(1);
  expect(adds()).toBe(1);
  await shot(page, '359-01-not-sure');
  // the dialog says what a second send can cause; cancel sends nothing
  late.stop();
  await notice.getByTestId('op-resend').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toContainText('再发一次「加上 pending/agent」？');
  await expect(dialog.getByTestId('op-resend-confirm')).toContainText('仍可能稍后生效');
  await expect(dialog.getByTestId('op-resend-confirm')).toContainText('这一条会被派两次工');
  await expect(dialog.getByTestId('op-resend-confirm')).toContainText('发出后会接着摘「pending/human」');
  await shot(page, '359-02-confirm');
  await dialog.getByTestId('confirm-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(notice.getByTestId('op-resend')).toBeVisible();
  expect(adds()).toBe(1);
  // confirm: sent again, and the step left goes out by itself
  await notice.getByTestId('op-resend').click();
  await page.getByTestId('confirm-dialog').getByTestId('confirm-ok').click();
  await expect.poll(() => adds()).toBe(2);
  await expect.poll(() => labels()).toEqual(['pending/agent']);
  await app.close();
});

/**
 * The window going to the background / coming back as the app sees it: document.hasFocus() says so
 * (a paused notice looks at it once a second, GitHub#296) and the event is sent. `event: false`
 * changes only what hasFocus() says — the event that should come with it is missed.
 */
async function windowFocus(page: Page, focused: boolean, event = true) {
  await page.evaluate(
    ([f, e]) => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => f });
      if (e) window.dispatchEvent(new Event(f ? 'focus' : 'blur'));
    },
    [focused, event] as const,
  );
}

test('GitHub#256: a fully successful notice puts itself away after 5 s (GitHub#279; 10 s before) (detail, board, after a switch); pointer, focus, a background window pause it; warnings, errors and kept drafts stay', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const openOnGitHub = (n: number) => {
    const c = findCopies(store, 'GigleAI/cavil-loop', n)!;
    for (const g of c.gql) Object.assign(g, { state: 'OPEN', stateReason: null });
    for (const r of c.rest) Object.assign(r, { state: 'open', state_reason: null });
  };
  for (const n of [135, 136, 137, 139, 141, 142]) openOnGitHub(n);
  // PR #146 open (not merged), as in the GitHub#177 test
  for (const g of findCopies(store, 'GigleAI/cavil-loop', 146)!.gql) Object.assign(g, { state: 'OPEN', merged: false });
  for (const r of findCopies(store, 'GigleAI/cavil-loop', 146)!.rest) Object.assign(r, { state: 'open', pull_request: { ...r.pull_request, merged_at: null } });
  let { app, page } = await launch(env);
  // fake time in the window: "5 s later" without waiting
  await page.clock.install();
  await page.reload();
  await page.waitForSelector('[data-testid="app-root"]');
  await signInWithSources(page);
  const detail = page.getByTestId('detail');
  const open = async (n: number) => {
    await page.getByTestId('search').fill(`#${n}`);
    if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').click();
    await card(page, n).click();
    await expect(detail).toHaveAttribute('data-key', `gigleai/cavil-loop#${n}`);
    await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
  };
  // GitHub#447: a close GitHub takes puts the panel away. This test is about the notice in the panel, so the panel
  // holds a reply while the close is sent (it then stays, and says why) and the reply is cleared once it was kept.
  const keepOpen = () => page.getByTestId('reply-input').fill('留着面板');
  const keptOpen = async (closed = true) => {
    if (closed) await expect(page.getByTestId('auto-close-held')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('reply-input').fill('');
  };
  const closeIt = async (n: number, closed = true) => {
    await open(n);
    await keepOpen();
    await page.getByTestId('close-issue').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    await keptOpen(closed);
  };
  const inDetail = (n: number) => page.locator(`[data-testid="notice-area"] [data-testid="op-notice"][data-key="gigleai/cavil-loop#${n}"]`);
  const onBoard = (n: number) => page.locator(`[data-testid="op-notice"][data-key="gigleai/cavil-loop#${n}"]`);
  const ff = async (ms: number) => {
    await page.clock.fastForward(ms);
    await page.waitForTimeout(100);
  };

  // ---- 1. in the detail: 4 s still there, 5 s gone; the pointer on it pauses, leaving starts over ----
  await closeIt(137);
  await expect(inDetail(137).getByTestId('op-notice-text')).toHaveText('issue #137 已关闭（已完成）', { timeout: 15_000 });
  await expect(inDetail(137)).toHaveAttribute('data-auto-dismiss', 'counting');
  await inDetail(137).hover();
  await expect(inDetail(137)).toHaveAttribute('data-auto-dismiss', 'paused');
  await ff(20_000);
  await expect(inDetail(137)).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(inDetail(137)).toHaveAttribute('data-auto-dismiss', 'counting');
  await ff(4_000);
  await expect(inDetail(137)).toBeVisible();
  await ff(1_100);
  await expect(inDetail(137)).toHaveCount(0);
  await page.getByTestId('detail-close').click();
  // put away for good: not above the board either
  await expect(onBoard(137)).toHaveCount(0);

  // ---- 2. above the board: keyboard focus inside pauses it ----
  await closeIt(139);
  await page.getByTestId('detail-close').click();
  // the notice may come up under the pointer (that pauses it, as it should): move it away first
  await page.mouse.move(5, 5);
  await expect(onBoard(139).getByTestId('op-notice-text')).toHaveText('issue #139 已关闭（已完成）', { timeout: 15_000 });
  await expect(onBoard(139)).toHaveAttribute('data-auto-dismiss', 'counting');
  await onBoard(139).getByTestId('op-dismiss').focus();
  await expect(onBoard(139)).toHaveAttribute('data-auto-dismiss', 'paused');
  await ff(20_000);
  await expect(onBoard(139)).toBeVisible();
  await page.getByTestId('search').focus();
  await expect(onBoard(139)).toHaveAttribute('data-auto-dismiss', 'counting');
  await ff(4_000);
  await expect(onBoard(139)).toBeVisible();
  await ff(1_100);
  await expect(onBoard(139)).toHaveCount(0);

  // ---- 3. counted 3 s, then the panel is put away: GitHub#488 — the notice is the same one in the same place, so it
  // keeps counting (it used to start over above the board); a window in the background or hidden pauses ----
  await closeIt(142);
  await expect(inDetail(142)).toHaveAttribute('data-auto-dismiss', 'counting');
  await ff(3_000);
  await page.getByTestId('detail-close').click();
  await page.mouse.move(5, 5);
  await expect(onBoard(142)).toHaveAttribute('data-auto-dismiss', 'counting');
  await ff(1_000);
  await expect(onBoard(142)).toBeVisible();
  await windowFocus(page, false);
  await expect(onBoard(142)).toHaveAttribute('data-auto-dismiss', 'paused');
  await ff(20_000);
  await expect(onBoard(142)).toBeVisible();
  await windowFocus(page, true);
  await expect(onBoard(142)).toHaveAttribute('data-auto-dismiss', 'counting');
  await ff(4_000);
  await expect(onBoard(142)).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(onBoard(142)).toHaveAttribute('data-auto-dismiss', 'paused');
  await ff(20_000);
  await expect(onBoard(142)).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(onBoard(142)).toHaveAttribute('data-auto-dismiss', 'counting');
  await ff(4_000);
  await expect(onBoard(142)).toBeVisible();
  await ff(1_100);
  await expect(onBoard(142)).toHaveCount(0);

  // ---- 3b. PR #259 review round 1: the window loses focus first, then a notice comes up — it starts paused ----
  await open(135);
  await keepOpen();
  await windowFocus(page, false);
  await page.getByTestId('close-issue').click();
  await page.getByTestId('confirm-ok').click();
  await keptOpen();
  await expect(inDetail(135).getByTestId('op-notice-text')).toHaveText('issue #135 已关闭（已完成）', { timeout: 15_000 });
  await page.mouse.move(5, 5);
  await expect(inDetail(135)).toHaveAttribute('data-auto-dismiss', 'paused');
  await ff(20_000);
  await expect(inDetail(135)).toBeVisible();
  await windowFocus(page, true);
  await expect(inDetail(135)).toHaveAttribute('data-auto-dismiss', 'counting');
  await ff(4_000);
  await expect(inDetail(135)).toBeVisible();
  await ff(1_100);
  await expect(inDetail(135)).toHaveCount(0);
  await page.getByTestId('detail-close').click();

  // ---- 4. what stays: merged but the linked issues were not read; refused; closed with the comment refused ----
  // GitHub says "there is a next page" of the issues this PR closes without saying where: that read fails
  env.fake.state.w.closingIssuesPageSize = 0;
  await page.getByTestId('search').fill('#146');
  await card(page, 146).click();
  await expect(page.getByTestId('pr-status')).toContainText('可以合并', { timeout: 15_000 });
  await page.getByTestId('merge').click();
  await page.getByTestId('confirm-ok').click();
  await expect(inDetail(146).getByTestId('op-notice-text')).toContainText('PR #146 已合并；', { timeout: 15_000 });
  await expect(inDetail(146).getByTestId('op-notice-text')).toContainText('关联的 issue', { timeout: 15_000 });
  // GitHub#279: every step worked but the linked issues were not read — a warning (it used to read "ok"); the
  // linked issues stay unreadable to the end of this test, so every round's re-read keeps the problem
  await expect(inDetail(146)).toHaveAttribute('data-kind', 'warn');
  await page.getByTestId('detail-close').click();

  env.fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
  await closeIt(136, false);
  await expect(inDetail(136)).toHaveAttribute('data-kind', 'error', { timeout: 15_000 });
  env.fake.state.w.readOnlyRepos.clear();
  await page.getByTestId('detail-close').click();

  env.fake.state.w.failComment = true;
  await open(141);
  await keepOpen();
  await page.getByTestId('close-issue').click();
  await page.getByTestId('close-comment').fill('做完了');
  await page.getByTestId('confirm-ok').click();
  await keptOpen();
  await expect(inDetail(141).getByTestId('op-notice-text')).toContainText('附的评论没有发出去', { timeout: 15_000 });
  env.fake.state.w.failComment = false;
  await page.getByTestId('detail-close').click();

  for (const n of [146, 136, 141]) await expect(onBoard(n)).not.toHaveAttribute('data-auto-dismiss', /./);
  await ff(60_000);
  for (const n of [146, 136, 141]) await expect(onBoard(n)).toBeVisible();
  await shot(page, '256-01-kept-notices');

  // ---- 5. result bars: a plain success goes after 5 s (GitHub#488: a field change says nothing — a comment still does) ----
  await open(144);
  await page.getByTestId('reply-input').fill('看过了 256');
  await page.getByTestId('reply-send').click();
  // GitHub#489: in the notice area
  const said = sendNotice(page).first();
  await expect(said).toHaveAttribute('data-kind', 'ok', { timeout: 15_000 });
  await expect(said).toHaveAttribute('data-auto-dismiss', 'counting');
  await ff(4_000);
  await expect(said).toBeVisible();
  await ff(1_100);
  await expect(sendNotice(page)).toHaveCount(0);
  // the same notice when its panel was put away before GitHub answered
  const holdSend = env.fake.holdWhen((e) => e.method === 'POST' && e.path.endsWith('/issues/144/comments'));
  await page.getByTestId('reply-input').fill('再看一遍 256');
  await page.getByTestId('reply-send').click();
  await expect.poll(() => env.fake.log.filter((l) => l.method === 'POST' && l.path.endsWith('/issues/144/comments')).length).toBe(2);
  await page.getByTestId('detail-close').click();
  await expect(sendNotice(page).first()).toHaveAttribute('data-kind', 'busy');
  holdSend();
  await expect(sendNotice(page).first()).toHaveAttribute('data-kind', 'ok', { timeout: 15_000 });
  await page.mouse.move(5, 5);
  await expect(sendNotice(page).first()).toHaveAttribute('data-auto-dismiss', 'counting');
  await ff(4_000);
  await expect(sendNotice(page).first()).toBeVisible();
  await ff(1_100);
  await expect(sendNotice(page)).toHaveCount(0);
  await expect(page.getByTestId('board-action-result')).toHaveCount(0);

  // ---- 6. restart: what went away stays away, what stayed is still there ----
  await app.close();
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  for (const n of [146, 136, 141]) await expect(onBoard(n)).toBeVisible();
  for (const n of [135, 137, 139, 142]) await expect(onBoard(n)).toHaveCount(0);
  await app.close();
  env.fake.state.w.closingIssuesPageSize = 100;
});

test('GitHub#296: a missed "pointer left" / "focus left" / "window back" never keeps a successful notice paused; a real pointer, focus or background window still does', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  for (const n of [137, 139]) {
    const c = findCopies(store, 'GigleAI/cavil-loop', n)!;
    for (const g of c.gql) Object.assign(g, { state: 'OPEN', stateReason: null });
    for (const r of c.rest) Object.assign(r, { state: 'open', state_reason: null });
  }
  const { app, page } = await launch(env);
  await page.clock.install();
  await page.reload();
  await page.waitForSelector('[data-testid="app-root"]');
  await signInWithSources(page);
  const ff = async (ms: number) => {
    await page.clock.fastForward(ms);
    await page.waitForTimeout(100);
  };
  const onBoard = (n: number) => page.locator(`[data-testid="op-notice"][data-key="gigleai/cavil-loop#${n}"]`);
  const closeOnBoard = async (n: number) => {
    await page.getByTestId('search').fill(`#${n}`);
    if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').click();
    await card(page, n).click();
    await expect(page.getByTestId('detail')).toHaveAttribute('data-key', `gigleai/cavil-loop#${n}`);
    await page.getByTestId('close-issue').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    // GitHub#447: GitHub took the close: the panel puts itself away; the notice shows in the strip at the top
    await expect(page.getByTestId('detail')).toHaveCount(0, { timeout: 15_000 });
    await page.mouse.move(600, 600);
    await expect(onBoard(n).getByTestId('op-notice-text')).toHaveText(`issue #${n} 已关闭（已完成）`, { timeout: 15_000 });
    await expect(onBoard(n)).toHaveAttribute('data-auto-dismiss', 'counting');
  };
  // the app never hears of the pointer / the focus leaving (what happens when it leaves while the window is in the background)
  const missLeaves = (on: boolean) =>
    page.evaluate((v) => {
      const w = window as unknown as { __miss?: (e: Event) => void };
      const types = ['mouseout', 'mouseover', 'pointerout', 'pointerover', 'focusout', 'focusin'];
      if (v && !w.__miss) {
        w.__miss = (e: Event) => e.stopImmediatePropagation();
        for (const t of types) window.addEventListener(t, w.__miss, true);
      } else if (!v && w.__miss) {
        for (const t of types) window.removeEventListener(t, w.__miss, true);
        delete w.__miss;
      }
    }, on);

  await closeOnBoard(137);
  const n137 = onBoard(137);
  // ---- 1. a real pointer on it keeps it paused, the once-a-second look included ----
  await n137.hover();
  await expect(n137).toHaveAttribute('data-auto-dismiss', 'paused');
  await ff(20_000);
  await expect(n137).toHaveAttribute('data-auto-dismiss', 'paused');
  // ---- 2. the pointer leaves, the app does not hear it: within a second it counts again, 5 s later it is gone ----
  await missLeaves(true);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(100);
  await expect(n137).toHaveAttribute('data-auto-dismiss', 'paused');
  await ff(1_100);
  await expect(n137).toHaveAttribute('data-auto-dismiss', 'counting');
  await missLeaves(false);
  await ff(4_000);
  await expect(n137).toBeVisible();
  await ff(1_100);
  await expect(n137).toHaveCount(0);

  await closeOnBoard(139);
  const n139 = onBoard(139);
  // ---- 3. pointer on it, window to the background, pointer moved away unheard, window back: counts again ----
  await n139.hover();
  await expect(n139).toHaveAttribute('data-auto-dismiss', 'paused');
  await windowFocus(page, false);
  await missLeaves(true);
  await page.mouse.move(5, 5);
  await ff(20_000);
  // a window really in the background keeps it paused, the once-a-second look included
  await expect(n139).toHaveAttribute('data-auto-dismiss', 'paused');
  await windowFocus(page, true);
  await expect(n139).toHaveAttribute('data-auto-dismiss', 'counting');
  await missLeaves(false);
  // ---- 4. the window comes back but the app is not told: within a second it counts again ----
  await windowFocus(page, false);
  await expect(n139).toHaveAttribute('data-auto-dismiss', 'paused');
  await windowFocus(page, true, false);
  await ff(1_100);
  await expect(n139).toHaveAttribute('data-auto-dismiss', 'counting');
  // ---- 5. the focus really in it keeps it paused; the focus leaves unheard: counts again ----
  await n139.getByTestId('op-dismiss').focus();
  await expect(n139).toHaveAttribute('data-auto-dismiss', 'paused');
  await ff(20_000);
  await expect(n139).toHaveAttribute('data-auto-dismiss', 'paused');
  await missLeaves(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(100);
  await expect(n139).toHaveAttribute('data-auto-dismiss', 'paused');
  await ff(1_100);
  await expect(n139).toHaveAttribute('data-auto-dismiss', 'counting');
  await missLeaves(false);
  await ff(4_000);
  await expect(n139).toBeVisible();
  await ff(1_100);
  await expect(n139).toHaveCount(0);
  await app.close();
});

test('GitHub#279: the close worked but the re-read right after it failed — a yellow warning that stays; the next sync re-reads it, the notice turns into a success and goes after 5 s', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const N = 138;
  const ITEM = `gigleai/cavil-loop#${N}`;
  const c0 = findCopies(store, 'GigleAI/cavil-loop', N)!;
  for (const g of c0.gql) Object.assign(g, { state: 'OPEN', stateReason: null });
  for (const r of c0.rest) Object.assign(r, { state: 'open', state_reason: null });
  const { app, page } = await launch(env);
  await page.clock.install();
  await page.reload();
  await page.waitForSelector('[data-testid="app-root"]');
  await signInWithSources(page);
  const ff = async (ms: number) => {
    await page.clock.fastForward(ms);
    await page.waitForTimeout(100);
  };
  const refreshes = () => env.fake.log.filter((e) => e.operation === 'CavilItemRefresh' && e.variables?.number === N).length;
  // the close goes through; only the one-item re-read after it fails
  env.fake.state.w.failRefresh.add(ITEM);
  await page.getByTestId('search').fill(`#${N}`);
  await card(page, N).click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', ITEM);
  await page.getByTestId('close-issue').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  // GitHub#447: GitHub took the close: the panel puts itself away; the notice shows in the strip at the top
  await expect(page.getByTestId('detail')).toHaveCount(0, { timeout: 15_000 });
  const notice = page.locator(`[data-testid="op-notice"][data-key="${ITEM}"]`);
  await expect(notice.getByTestId('op-notice-text')).toContainText('重读这一条失败', { timeout: 15_000 });
  expect(refreshes()).toBeGreaterThan(0);
  // yellow, the warning icon, never counting down
  await expect(notice).toHaveAttribute('data-kind', 'warn');
  await expect(notice).toHaveClass(/\bwarn\b/);
  await expect(notice).not.toHaveAttribute('data-auto-dismiss', /./);
  await page.mouse.move(5, 5);
  await ff(30_000);
  await expect(notice).toBeVisible();
  await shot(page, '279-01-reread-failed-warn');
  // GitHub answers again: the next round re-reads it
  env.fake.state.w.failRefresh.delete(ITEM);
  const n = refreshes();
  await page.getByTestId('refresh').click();
  await expect(notice.getByTestId('op-notice-text')).toHaveText(`issue #${N} 已关闭（已完成）`, { timeout: 15_000 });
  expect(refreshes()).toBeGreaterThan(n);
  await expect(notice).toHaveAttribute('data-kind', 'ok');
  await expect(notice).toHaveAttribute('data-auto-dismiss', 'counting');
  await ff(4_000);
  await expect(notice).toBeVisible();
  await ff(1_100);
  await expect(notice).toHaveCount(0);
  await app.close();
});

test('GitHub#258: a status group\'s "+" with the board left unticked — the board takes it in by itself; empty would be set, a value already there is only offered as a button', async () => {
  const PROJECT_KEY = 'project:org/gigleai/11';
  const PROJECT_NODE = 'PVT_fixture_435fd6e043de';
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const { app, page } = await launch(env);
  await signInWithSources(page);
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('status');
  const group = (title: string) => page.locator(`[data-testid="group"][data-title="${title}"]`);
  const line = (target: string) => page.locator(`[data-testid="new-issue-preset-line"][data-target="${target}"]`);

  await expect(group('In progress').getByTestId('group-add')).toBeEnabled({ timeout: 15_000 });
  await group('In progress').getByTestId('group-add').click();
  const box = page.locator(`[data-testid="new-issue-project"][data-project="${PROJECT_KEY}"]`);
  await expect(box).toBeChecked();
  await box.uncheck();
  // left unticked: watched (below), but never announced in the dialog (GitHub#270); only that no ticked board takes the status
  await expect(line(PROJECT_KEY)).toHaveCount(0);
  await expect(line('group')).toContainText('当前没有勾选看板，不会设置状态');
  await page.getByTestId('new-issue-title').fill('没勾看板，GitHub 自己收进去');
  await shot(page, '258-01-unticked-board');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  const key = await page.getByTestId('detail').getAttribute('data-key');
  const n = Number(String(key).split('#')[1]);
  await page.getByTestId('detail-close').click();
  // not added by the client
  expect(writes().filter((w) => w[0] === 'CavilAddProjectItem')).toHaveLength(0);

  // GitHub's auto-add puts it on the board, and a board rule (or a person) sets Backlog
  const nodeId = env.fake.state.repos.get('gigleai/cavil-loop')!.find((r: any) => r.number === n)!.node_id;
  handleGraphql(store, 'CavilAddProjectItem', { projectId: PROJECT_NODE, contentId: nodeId });
  const f = env.fake.state.projects.get('org/gigleai/11')![0].fields.nodes.find((x: any) => x.name === 'Status') as any;
  const item = env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((x: any) => x.content?.number === n && x.content?.repository?.nameWithOwner?.toLowerCase() === 'gigleai/cavil-loop') as any;
  handleGraphql(store, 'CavilSetStatus', { projectId: PROJECT_NODE, itemId: item.id, fieldId: f.id, optionId: f.options.find((o: any) => o.name === 'Backlog').id });

  // the first look (5 s after creating) sees Backlog: not overwritten, a button offered
  const bar = page.locator('[data-testid="create-bar"][data-status="partial"]');
  await expect(bar).toContainText('状态是「Backlog」，没有自动改成「In progress」', { timeout: 20_000 });
  expect(writes().filter((w) => w[0] === 'CavilSetStatus')).toHaveLength(0);
  await shot(page, '258-02-button');
  await bar.getByTestId('create-watch-apply').click();
  await expect.poll(() => writes().filter((w) => w[0] === 'CavilSetStatus').length).toBe(1);
  // read back after the write, then the notice goes and the row is in that group
  await expect(page.getByTestId('create-bar')).toHaveCount(0, { timeout: 30_000 });
  await page.getByTestId('refresh').press('Enter');
  await expect(group('In progress').locator(`[data-testid="row"][data-key="gigleai/cavil-loop#${n}"]`)).toBeVisible({ timeout: 15_000 });
  await app.close();
});

test('GitHub#260: the detail starts under the view bar and never moves — bars keep to its left, its own notices sit behind one button in the head, fields fold (remembered), the PR state is icons above send', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const node = env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((n: any) => n.content?.__typename === 'PullRequest')!;
  const prN = node.content.number as number;
  const c = findCopies(store, 'GigleAI/cavil-loop', prN)!;
  for (const g of c.gql) Object.assign(g, { state: 'OPEN', merged: false });
  for (const r of c.rest) Object.assign(r, { state: 'open', pull_request: { ...(r.pull_request ?? {}), merged_at: null } });
  const pull = pullOf(store, c);
  Object.assign(pull, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: 'SUCCESS', reviewDecision: null });
  let { app, page } = await launch(env);
  await signInWithSources(page);
  // wide enough for the PR line to fit on one line (narrower, the buttons wrap under the icons)
  await page.evaluate(() => (window as any).cavil.setView({ detailWidth: 720 }));
  await card(page, prN).click();
  const detail = page.getByTestId('detail');
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  const topOf = (sel: string) => page.locator(sel).first().evaluate((e) => Math.round(e.getBoundingClientRect().top));
  const discussionTop = () => topOf('[data-testid="timeline-frame"]');
  const vbarBottom = await page.locator('.vbar').evaluate((e) => Math.round(e.getBoundingClientRect().bottom));
  expect(await topOf('[data-testid="detail"]')).toBe(vbarBottom);
  const t0 = await discussionTop();

  // ---- 1. bars above the board appear: the panel and its discussion stay where they are; the bars keep to its left ----
  // (keyboard, not clicks: a click outside the panel puts it away, GitHub#191)
  await page.getByTestId('open-view-panel').press('Enter');
  await expect(page.getByTestId('view-panel')).toBeVisible();
  await page.getByTestId('search').fill(UNSUPPORTED);
  await expect(page.getByTestId('filter-unsupported')).toBeVisible();
  await expect(detail).toBeVisible();
  expect(await topOf('[data-testid="detail"]')).toBe(vbarBottom);
  expect(await discussionTop()).toBe(t0);
  const panelLeft = (await detail.boundingBox())!.x;
  for (const id of ['filter-unsupported', 'view-panel']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.x + b.width, id).toBeLessThanOrEqual(panelLeft);
  }
  // nothing covers a bar's own close button
  const close = (await page.getByTestId('filter-unsupported-close').boundingBox())!;
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid'), [close.x + close.width / 2, close.y + close.height / 2])).toBe('filter-unsupported-close');
  await shot(page, '260-01-bars-beside-detail');
  // put away: the bars take the whole width again
  await page.getByTestId('detail-close').click();
  await expect(detail).toHaveCount(0);
  const wide = (await page.getByTestId('filter-unsupported').boundingBox())!;
  expect(wide.x + wide.width).toBeGreaterThan(panelLeft + 100);
  await page.getByTestId('open-view-panel').press('Enter');
  await expect(page.getByTestId('view-panel')).toHaveCount(0);
  await page.getByTestId('search').fill('');
  await card(page, prN).click();
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  // opened again, the panel first shows this run's cached copy with a one-line "read at HH:MM" note above
  // the discussion until the fresh read lands (GitHub#229); t0 was taken with no note (first opening).
  // Compare like with like: wait for the fresh read (PR #272 review round 2 — measured before it landed,
  // the discussion sat one note lower: 234 → 253 px, reproduced by holding the read)
  await expect(page.getByTestId('detail-cached')).toHaveCount(0, { timeout: 15_000 });
  expect(await discussionTop()).toBe(t0);

  // the discussion's place inside the panel (GitHub#488: the notice area above every page may shift the whole window)
  // (against the panel's own head: the panel's content may scroll when the window above it changes height)
  const inPanel = async () => (await discussionTop()) - (await topOf('[data-testid="detail"] .detail-head'));
  const headH = () => detail.locator('.detail-head').evaluate((e) => Math.round(e.getBoundingClientRect().height));
  const headH0 = await headH();

  // ---- 2. a write made here: nothing in the head, the discussion does not move ----
  // (GitHub#488: a field change says nothing — the field shows it; GitHub#489: a comment says its result in the
  // window's notice area)
  const w2 = writes().length;
  await pickLabel(page, 'pending/PR');
  await savedQuietly(page, sentTo('POST', `/issues/${prN}/labels`), w2);
  await detail.getByTestId('reply-input').fill('看过了 260');
  await detail.getByTestId('reply-send').click();
  await expect(sendNotice(page).first().getByTestId('send-notice-text')).toHaveText('评论已发出');
  await expect(detail.getByTestId('action-result')).toHaveCount(0);
  await expect(detail.getByTestId('detail-notices-toggle')).toHaveCount(0);
  // the head keeps its height (a comment adds to the discussion itself — its tools row shows from the second
  // entry on — so its place is taken again below, once the comment is in)
  expect(await headH()).toBe(headH0);
  await expect(page.frameLocator('[data-testid="timeline-frame"]').locator('body')).toContainText('看过了 260');
  const inPanel0 = await inPanel();

  // ---- 3. a change GitHub refuses: GitHub's answer behind the notices button in the head (counted), never above the
  // discussion; GitHub#488: the change kept to send again is in the window's notice area (it shifts the whole window
  // down, the panel's own layout does not move) ----
  env.fake.state.w.failLabel = 'pending/human';
  await pickLabel(page, 'pending/human');
  await expect(page.getByTestId('notice-area').getByTestId('edit-issues')).toBeVisible({ timeout: 15_000 });
  await expect(detail.getByTestId('edit-issues')).toHaveCount(0);
  // a refused field change: nothing in the panel at all (said once, in the notice area)
  const toggle = detail.getByTestId('detail-notices-toggle');
  await page.waitForTimeout(500);
  await expect(toggle).toHaveCount(0);
  await expect(detail.getByTestId('action-result')).toHaveCount(0);
  // a refused comment (GitHub#489): said in the notice area, the text back in the reply box, nothing in the panel
  env.fake.state.w.failComment = true;
  await detail.getByTestId('reply-input').fill('被拒 260');
  await detail.getByTestId('reply-send').click();
  await expect(sendNotice(page).first()).toHaveAttribute('data-kind', 'error', { timeout: 15_000 });
  await expect(detail.getByTestId('reply-input')).toHaveValue('被拒 260');
  env.fake.state.w.failComment = false;
  await expect(toggle).toHaveCount(0);
  // a failed read of the shown detail is the panel's own: behind the notices button
  env.fake.state.w.failDetail.add(`gigleai/cavil-loop#${prN}`);
  await detail.getByTestId('detail-refresh').click();
  await expect(toggle).toHaveAttribute('data-tone', 'error', { timeout: 15_000 });
  await expect(toggle).toHaveAttribute('data-count', '1');
  env.fake.state.w.failDetail.clear();
  await expect(detail.getByTestId('detail-error')).toBeHidden();
  expect(await inPanel()).toBe(inPanel0);
  // a click shows them, with their own buttons; Esc puts them away, the panel stays
  await toggle.click();
  await expect(detail.getByTestId('detail-notices')).toBeVisible();
  await expect(detail.getByTestId('detail-error')).toBeVisible();
  await expect(page.locator('[data-testid="notice-area"] [data-testid="edit-issue"][data-field="label"]')).toHaveAttribute('data-edit', 'failed');
  expect(await inPanel()).toBe(inPanel0);
  await shot(page, '260-02-notices-open');
  await page.keyboard.press('Escape');
  await expect(detail.getByTestId('detail-notices')).toBeHidden();
  await expect(detail).toBeVisible();
  // a click elsewhere in the panel puts them away too
  await toggle.click();
  await expect(detail.getByTestId('detail-notices')).toBeVisible();
  await detail.getByTestId('reply-input').click();
  await expect(detail.getByTestId('detail-notices')).toBeHidden();
  // a click into the discussion (an isolated frame: its clicks never reach the window) puts them away too (PR #269 review round 1)
  await toggle.click();
  await expect(detail.getByTestId('detail-notices')).toBeVisible();
  await page.frameLocator('[data-testid="timeline-frame"]').locator('body').click({ position: { x: 20, y: 60 } });
  await expect(detail.getByTestId('detail-notices')).toBeHidden();
  // the narrowest panel (360 px): every head button and the open notices stay inside it, nothing scrolls sideways
  await page.evaluate(() => (window as any).cavil.setView({ detailWidth: 360 }));
  await expect(detail).toHaveAttribute('data-width', '360');
  await toggle.click();
  await expect(detail.getByTestId('detail-notices')).toBeVisible();
  const panel = (await detail.boundingBox())!;
  for (const id of ['detail-open-tab', 'detail-open-web', 'fields-toggle', 'detail-notices-toggle', 'detail-refresh', 'detail-close', 'detail-notices']) {
    const b = (await detail.getByTestId(id).boundingBox())!;
    expect(b.x, id).toBeGreaterThanOrEqual(panel.x);
    expect(b.x + b.width, id).toBeLessThanOrEqual(panel.x + panel.width);
  }
  expect(await detail.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await shot(page, '260-02b-narrow-notices');
  // GitHub#457: that narrow, 在标签页打开 keeps its icon and tooltip, without the words
  await expect(detail.getByTestId('detail-open-tab')).toHaveText('');
  await expect(detail.getByTestId('detail-open-tab')).toHaveAttribute('aria-label', '在标签页打开');
  // the change's own buttons are in the notice area, whatever the panel's width
  await expect(page.getByTestId('notice-area').getByTestId('edit-resend')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(detail.getByTestId('detail-notices')).toBeHidden();
  // the close button really is reachable: a click puts the panel away (the refused comment's text cleared first)
  await detail.getByTestId('reply-input').fill('');
  await detail.getByTestId('detail-close').click();
  await expect(detail).toHaveCount(0);
  await page.evaluate(() => (window as any).cavil.setView({ detailWidth: 720 }));
  await card(page, prN).click();
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  // sent again once GitHub accepts: the kept change goes, the count follows
  env.fake.state.w.failLabel = null;
  await page.getByTestId('notice-area').getByTestId('edit-resend').click();
  await expect(detail).toBeVisible();
  await expect(page.getByTestId('notice-area').getByTestId('edit-issues')).toHaveCount(0);
  await expect(detail.locator('[data-testid="detail-label"][data-label="pending/human"]')).toBeVisible();

  // ---- 4. the fields fold away; remembered across items and a restart; the label key brings them back with the picker ----
  await expect(detail.getByTestId('detail-fields')).toBeVisible();
  const fieldsH = await detail.getByTestId('detail-fields').evaluate((e) => e.getBoundingClientRect().height);
  const tOpen = await discussionTop();
  await detail.getByTestId('fields-toggle').click();
  await expect(detail.getByTestId('detail-fields')).toHaveCount(0);
  await expect(detail.getByTestId('fields-toggle')).toHaveAttribute('data-shown', 'no');
  expect(tOpen - (await discussionTop())).toBeGreaterThanOrEqual(Math.floor(fieldsH));
  await shot(page, '260-03-fields-folded');
  await page.getByTestId('detail-close').click();
  await card(page, 137).click();
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  await expect(detail.getByTestId('detail-fields')).toHaveCount(0);
  await app.close();
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await card(page, prN).click();
  await expect(page.getByTestId('detail').getByTestId('detail-fields')).toHaveCount(0);
  await expect(page.getByTestId('detail').getByTestId('label-add')).toHaveCount(0);
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  await page.getByTestId('detail').focus();
  await page.keyboard.press('l');
  await expect(page.getByTestId('detail').getByTestId('detail-fields')).toBeVisible();
  await expect(page.getByTestId('detail').getByTestId('label-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('detail').getByTestId('fields-toggle')).toHaveAttribute('data-shown', 'yes');

  // ---- 5. the PR's state: icons in the reply box, above send; the words on hover and for screen readers ----
  const d = page.getByTestId('detail');
  const bar = d.getByTestId('reply').getByTestId('pr-box');
  await expect(bar).toBeVisible();
  const icon = (k: string) => bar.locator(`[data-testid="pr-icon"][data-key="${k}"]`);
  await expect(icon('merge')).toHaveAttribute('data-tone', 'ok');
  await expect(icon('conflict')).toHaveAttribute('data-tone', 'ok');
  await expect(icon('checks')).toHaveAttribute('data-tone', 'ok');
  await expect(icon('checks')).toHaveAttribute('title', '检查：全部通过');
  await expect(icon('review')).toHaveAttribute('data-tone', 'none');
  await expect(d.getByTestId('pr-status')).toContainText('合并：可以合并');
  await expect(d.getByTestId('pr-branch')).toHaveAttribute('title', /→ main · 提交 [0-9a-f]{7}$/);
  // merge and close sit on the same line as the icons, above send
  const line = (await icon('merge').boundingBox())!;
  const mergeBtn = (await d.getByTestId('merge').boundingBox())!;
  expect(Math.abs(mergeBtn.y + mergeBtn.height / 2 - (line.y + line.height / 2))).toBeLessThan(8);
  expect(mergeBtn.y).toBeLessThan((await d.getByTestId('reply-send').boundingBox())!.y);
  await shot(page, '260-04-pr-bar');
  // a conflict: red icons, the merge button is off and says why, the red line is there
  Object.assign(pull, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  await d.getByTestId('detail-refresh').click();
  await expect(icon('conflict')).toHaveAttribute('data-tone', 'bad');
  await expect(icon('merge')).toHaveAttribute('data-tone', 'bad');
  await expect(bar.getByTestId('pr-conflict')).toContainText('有冲突');
  await expect(d.getByTestId('merge')).toBeDisabled();
  await expect(d.getByTestId('merge')).toHaveText('有冲突，不能合并');
  await shot(page, '260-05-pr-conflict');
  // still computing: never green
  Object.assign(pull, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', checks: 'PENDING' });
  await d.getByTestId('detail-refresh').click();
  await expect(icon('conflict')).toHaveAttribute('data-tone', 'pending');
  await expect(icon('checks')).toHaveAttribute('data-tone', 'pending');
  await expect(d.getByTestId('pr-status')).toContainText('检查：进行中');
  await app.close();
});

// ---- GitHub#275: the repository is the strongest heading; groups lighter; rows hang under their group;
// folded neighbours are one line; a PR that only names its issue (`Refs #N`) goes under it ----
test('GitHub#275: repository heading kept in view, lighter groups, rows under their group; folded neighbours are one line; a `Refs #N` PR goes under its issue', async () => {
  // a recorded PR GitHub does not link to any issue gets `Refs #<an Iteration 25 issue>` in its description
  const nodes = env.fake.state.projects.get('org/gigleai/11')!.flatMap((p: any) => p.items.nodes);
  const linked = new Set(nodes.flatMap((n: any) => (n.content?.closedByPullRequestsReferences?.nodes ?? []).map((x: any) => x.number)));
  const iterOf = (n: any) => n.fieldValues.nodes.find((v: any) => v.field?.name === 'Iteration')?.title ?? null;
  const loose = nodes.find((n: any) => n.content?.__typename === 'PullRequest' && !linked.has(n.content.number) && iterOf(n) !== 'Iteration 25');
  const host = nodes.find((n: any) => n.content?.__typename === 'Issue' && iterOf(n) === 'Iteration 25');
  loose.content.body = `## 背景\n\nRefs #${host.content.number}\n\n\`Refs #1\` 只是举例`;
  const prKey = `gigleai/cavil-loop#${loose.content.number}`;
  const hostKey = `gigleai/cavil-loop#${host.content.number}`;

  const { app, page } = await launch(env);
  await signInWithSources(page, '14'); // the PR named one more Iteration 25 issue
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await expect(page.getByTestId('table')).toBeVisible();
  await page.getByTestId('search').fill('');
  const C = 'repo:gigleai/cavil-loop';
  const group = (title: string) => page.locator(`[data-testid="group"][data-key^="${C}|"][data-title="${title}"]`);
  await expect(group('Iteration 25').getByTestId('row').first()).toBeVisible({ timeout: 15_000 });

  // the PR left its own group and sits right under the issue it names, one level in
  const pr = group('Iteration 25').locator(`[data-testid="row"][data-key="${prKey}"]`);
  await expect(pr).toHaveAttribute('data-under', hostKey);
  // right under it: between the two only other PRs of the same issue (the issue's PRs go newest first)
  const rows = await group('Iteration 25').getByTestId('row').evaluateAll((rs) => rs.map((r) => [r.getAttribute('data-key'), r.getAttribute('data-under')]));
  const at = rows.findIndex(([k]) => k === hostKey);
  const to = rows.findIndex(([k]) => k === prKey);
  expect(to).toBeGreaterThan(at);
  expect(rows.slice(at + 1, to).every(([, u]) => u === hostKey)).toBe(true);
  await expect(page.locator(`[data-testid="row"][data-key="${prKey}"]`)).toHaveCount(1);
  // the linked-PR column lists it, marked as named by the description
  const linkedCol = page.locator('[data-testid="columns-pick"] input[data-col="linkedPrs"]');
  await page.getByTestId('open-view-panel').click();
  if (!(await linkedCol.isChecked())) await linkedCol.check();
  await page.getByTestId('open-view-panel').click();
  const hostRow = group('Iteration 25').locator(`[data-testid="row"][data-key="${hostKey}"]`);
  await expect(hostRow.locator(`[data-testid="linked-pr"][data-via="body"]`)).toHaveText(`#${loose.content.number}`);

  // headings: the repository is the strongest and stays under the column heads; a group is lighter and stays under it
  const repoTd = page.getByTestId('repo-head').first().locator('td');
  const headTd = group('Iteration 25').getByTestId('group-head').locator('td');
  const css = (td: typeof repoTd) =>
    td.evaluate((el) => {
      const s = getComputedStyle(el);
      return { position: s.position, top: s.top, fontSize: parseFloat(s.fontSize), bar: s.boxShadow.includes('4px 0px 0px 0px'), bg: s.backgroundColor };
    });
  const repo = await css(repoTd);
  const head = await css(headTd);
  const surface = await page.locator('.table-scroll').evaluate((el) => getComputedStyle(el).backgroundColor);
  // no tint, no bar in front of a group any more
  expect([repo.position, repo.top, head.position, head.top, head.bar, head.bg]).toEqual(['sticky', '33px', 'sticky', '75px', false, surface]);
  expect(repo.fontSize).toBeGreaterThan(head.fontSize);
  // a row's title starts under its group's title; under a repository heading the row says only "#N"
  const row = group('Iteration 25').locator(`[data-testid="row"][data-key="${hostKey}"]`);
  await expect(row.getByTestId('row-ref')).toHaveText(`#${host.content.number}`);
  const titleX = await row.getByTestId('row-state').evaluate((el) => el.getBoundingClientRect().left);
  const groupTitleX = await headTd.locator('b').evaluate((el) => el.getBoundingClientRect().left);
  expect(Math.abs(titleX - groupTitleX)).toBeLessThanOrEqual(4);
  // scrolled to the middle: both headings are still in view, the group's right under the repository's
  await page.locator('.table-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
  await expect
    .poll(async () => {
      const r = (await page.getByTestId('repo-head').first().boundingBox())!;
      const t = (await page.locator('.table-scroll').boundingBox())!;
      return Math.round(r.y - t.y);
    })
    .toBeLessThanOrEqual(35);
  // the pinned headings follow one another with no gap: column heads, then the repository, then the group
  const edges = await page.evaluate(() => {
    const r = (q: string) => document.querySelector(q)!.getBoundingClientRect();
    return { th: r('table.items th').bottom, repoTop: r('[data-testid="repo-head"] td').top, repoBottom: r('[data-testid="repo-head"] td').bottom, groupTop: r('tbody.in-repo .group-head td').top };
  });
  expect(edges.repoTop).toBeLessThanOrEqual(edges.th);
  expect(edges.groupTop).toBeLessThanOrEqual(edges.repoBottom);
  await shot(page, '275-01-table-headings');
  await page.locator('.table-scroll').evaluate((el) => (el.scrollTop = 0));

  // fold the first two groups: one line naming both, with their counts
  const shape = (await tableShape(page)).filter((g) => g.key.startsWith(`${C}|`));
  const [a, b] = shape;
  await group(a.title).getByTestId('group-toggle').click();
  await group(b.title).getByTestId('group-toggle').click();
  const run = page.getByTestId('fold-run');
  await expect(run).toHaveCount(1);
  await expect(run).toHaveAttribute('data-keys', `${a.key} ${b.key}`);
  await expect(run.getByTestId('fold-run-title')).toHaveText(`已收起 2 组 · 共 ${a.rows.length + b.rows.length} 条`);
  await expect(run.getByTestId('fold-run-group')).toHaveText([`${a.title} ${a.rows.length}`, new RegExp(`^${b.title} ${b.rows.length}`)]);
  await expect(group(a.title)).toHaveCount(0);
  await shot(page, '275-02-table-folded-run');
  // a click on the line itself opens nothing
  const box = (await run.locator('td').boundingBox())!;
  await page.mouse.click(box.x + box.width - 20, box.y + box.height / 2);
  await expect(run).toHaveCount(1);
  // the second name opens just that group; the first is back to a single folded group
  // (a group key holds a NUL between title and start date: no attribute selector for it, pick by position)
  await expect(run.getByTestId('fold-run-group').nth(1)).toHaveAttribute('data-key', b.key);
  await run.getByTestId('fold-run-group').nth(1).click();
  await expect(run).toHaveCount(0);
  await expect(group(b.title).getByTestId('row').first()).toBeVisible();
  await expect(group(a.title).getByTestId('row')).toHaveCount(0);
  // folded again, then "全部展开": both open, and still open after a restart
  await group(b.title).getByTestId('group-toggle').click();
  await expect(run).toHaveCount(1);
  await run.getByTestId('fold-run-expand').click();
  await expect(run).toHaveCount(0);
  await expect(group(a.title).getByTestId('row').first()).toBeVisible();
  await expect(group(b.title).getByTestId('row').first()).toBeVisible();
  await app.close();
  const again = await launch(env);
  await expect(again.page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await expect(again.page.locator(`[data-testid="group"][data-key^="${C}|"][data-title="${a.title}"] [data-testid="row"]`).first()).toBeVisible({ timeout: 15_000 });
  await expect(again.page.getByTestId('fold-run')).toHaveCount(0);
  await again.app.close();
});

// ---- GitHub#276: a new issue lands in the current iteration of every ticked board ----

test('GitHub#276: a new issue gets the current iteration of the ticked board — nothing said when it lands; a "no iteration" group keeps none; two current at once is said, never guessed', async () => {
  const PROJECT_KEY = 'project:org/gigleai/11';
  const CURRENT = '0edf1752'; // Iteration 26: 2026-11-09 … 11-15 in the recorded board
  const newNumber = () =>
    1 +
    Math.max(
      ...env.fake.state.repos.get('gigleai/cavil-loop')!.map((r: any) => r.number),
      ...env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes.map((n: any) => n.content?.number ?? 0)),
    );
  const { app, page } = await launch(env);
  // the window's clock on a day inside Iteration 26 (local noon: the same date in any timezone the runner has)
  const noon = new Date(2026, 10, 11, 12, 0, 0);
  await page.clock.setFixedTime(noon);
  await page.reload();
  await page.waitForSelector('[data-testid="app-root"]');
  await signInWithSources(page);
  const dialog = page.getByTestId('confirm-dialog');
  const iterationWrites = () => writes().filter((w) => w[0] === 'CavilSetIteration');

  // ---- 1. the plain "新建": joined and put in Iteration 26; the dialog says nothing about it ----
  await page.getByTestId('write-entry').click();
  await expect(page.locator(`[data-testid="new-issue-project"][data-project="${PROJECT_KEY}"]`)).toBeChecked();
  await page.getByTestId('new-issue-title').fill('默认进当前迭代');
  await expect(page.getByTestId('new-issue-preset')).toHaveCount(0);
  await shot(page, '276-01-plain-new');
  const n1 = newNumber();
  const before1 = writes().length;
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', `gigleai/cavil-loop#${n1}`);
  await expect.poll(() => writes().slice(before1).map((w) => w[0])).toEqual(['POST', 'CavilAddProjectItem', 'CavilSetIteration']);
  expect((writes().slice(before1)[2][2] as any).iterationId).toBe(CURRENT);
  const node1 = env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((x: any) => x.content?.number === n1) as any;
  expect(node1.fieldValues.nodes.find((v: any) => v.__typename === 'ProjectV2ItemFieldIterationValue')?.title).toBe('Iteration 26');
  await page.getByTestId('detail-close').click();

  // ---- 2. a "no iteration" group's "+": joined, no iteration; a "no status" group's "+": the current one ----
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('iteration');
  const group = (title: string) => page.locator(`[data-testid="group"][data-title="${title}"]`);
  await expect(group('无迭代').getByTestId('group-add')).toBeEnabled({ timeout: 15_000 });
  await group('无迭代').getByTestId('group-add').click();
  await page.getByTestId('new-issue-title').fill('无迭代组里建的');
  await expect(page.getByTestId('new-issue-preset')).toHaveCount(0);
  const it0 = iterationWrites().length;
  const n2 = newNumber();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', `gigleai/cavil-loop#${n2}`);
  await expect.poll(() => writes().filter((w) => w[0] === 'CavilAddProjectItem').length).toBe(2);
  await page.waitForTimeout(500);
  expect(iterationWrites().length).toBe(it0);
  await page.getByTestId('detail-close').click();
  await page.getByTestId('group-by').selectOption('status');
  await expect(group('无状态').getByTestId('group-add')).toBeEnabled({ timeout: 15_000 });
  await group('无状态').getByTestId('group-add').click();
  await page.getByTestId('new-issue-title').fill('无状态组里建的');
  const n3 = newNumber();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', `gigleai/cavil-loop#${n3}`);
  await expect.poll(() => iterationWrites().length).toBe(it0 + 1);
  expect((iterationWrites().at(-1)![2] as any).iterationId).toBe(CURRENT);
  await page.getByTestId('detail-close').click();

  // ---- 3. two iterations current at once (dates overlap): said under the boards, nothing guessed ----
  const field = env.fake.state.projects.get('org/gigleai/11')![0].fields.nodes.find((f: any) => f.__typename === 'ProjectV2IterationField') as any;
  for (const pg of env.fake.state.projects.get('org/gigleai/11')!) {
    const f = pg.fields.nodes.find((x: any) => x.__typename === 'ProjectV2IterationField') as any;
    if (f && !f.configuration.iterations.some((x: any) => x.id === 'hotfix')) f.configuration.iterations.push({ id: 'hotfix', title: 'Hotfix', startDate: '2026-11-10', duration: 3 });
  }
  expect(field.configuration.iterations.some((x: any) => x.id === 'hotfix')).toBe(true);
  await page.getByTestId('refresh').press('Enter');
  await expect.poll(async () => {
    await page.getByTestId('write-entry').click();
    const n = await page.locator(`[data-testid="new-issue-preset-line"][data-target="${PROJECT_KEY}:iteration"]`).count();
    if (n === 0) await page.getByTestId('confirm-cancel').click();
    return n;
  }, { timeout: 20_000 }).toBe(1);
  const overlap = page.locator(`[data-testid="new-issue-preset-line"][data-target="${PROJECT_KEY}:iteration"]`);
  await expect(overlap).toContainText('同时有 2 个当前迭代');
  await expect(page.getByTestId('new-issue-projects').getByTestId('new-issue-preset')).toHaveAttribute('data-place', 'boards');
  await shot(page, '276-02-overlap');
  await page.getByTestId('new-issue-title').fill('重叠时不猜');
  const it1 = iterationWrites().length;
  const n4 = newNumber();
  await page.getByTestId('confirm-ok').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', `gigleai/cavil-loop#${n4}`);
  await expect.poll(() => writes().filter((w) => w[0] === 'CavilAddProjectItem').length).toBe(4);
  await page.waitForTimeout(500);
  expect(iterationWrites().length).toBe(it1);
  await app.close();
});

test('GitHub#299: the title of an issue / PR is edited from the detail; a plain Enter saves nothing; changed meanwhile = refused', async () => {
  const fake = env.fake;
  const copies = (n: number) => findCopies(fake.state, 'GigleAI/cavil-loop', n)!;
  const onGitHub = (n: number) => gqlContent(copies(n)).title as string;
  const retitle = (n: number, t: string) => {
    for (const r of copies(n).rest) r.title = t;
    for (const g of copies(n).gql) g.title = t;
  };
  fake.state.w.cannotUpdate.add(gqlContent(copies(137)).id);
  // #146 is a merged PR in the recording: open it, so it is an ordinary open PR on the board
  for (const r of copies(146).rest) Object.assign(r, { state: 'open', pull_request: { ...r.pull_request, merged_at: null } });
  for (const g of copies(146).gql) Object.assign(g, { state: 'OPEN', merged: false });

  const { app, page } = await launch(env);
  await signInWithSources(page);
  const detail = page.getByTestId('detail');
  const input = page.getByTestId('edit-title-input');

  // ---- 1. no permission on GitHub: no button ----
  await card(page, 137).click();
  await expect(detail.getByTestId('detail-title')).toBeVisible();
  await expect(detail.getByTestId('detail-refresh')).toHaveAttribute('data-loading', 'no', { timeout: 15_000 });
  await expect(detail.getByTestId('detail-edit-title')).toHaveCount(0);
  await page.getByTestId('detail-close').click();

  // ---- 2. an issue it may change: the dialog holds the title; a plain Enter, or ⌘↩ while composing, sends nothing ----
  await card(page, 138).click();
  const old = onGitHub(138);
  await detail.getByTestId('detail-edit-title').click();
  await expect(input).toHaveValue(old);
  await expect(input).toBeFocused();
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  await input.fill('   ');
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  await input.fill('客户端能改标题了');
  await input.press('Enter');
  await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, metaKey: true, isComposing: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(500);
  expect(fake.writes()).toEqual([]);
  await expect(input).toHaveValue('客户端能改标题了');
  // Esc with a changed title: kept, said
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('dialog-esc-hint')).toBeVisible();
  await expect(input).toHaveValue('客户端能改标题了');
  await shot(page, '299-01-edit-title');

  // ---- 3. ⌘↩ saves (the button's own action): one PATCH, the detail, the card and the table row show it ----
  await input.press(`${MOD}+Enter`);
  // GitHub#489: the dialog closes at once; the title shows the new one (marked 保存中… until GitHub answered); nothing else is said
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect.poll(() => writes().length).toBe(1);
  await expect(detail.getByTestId('detail-title')).toHaveAttribute('data-saving', 'no');
  expect(writes()).toEqual([['PATCH', '/api/repos/GigleAI/cavil-loop/issues/138', { title: '客户端能改标题了' }]]);
  expect(onGitHub(138)).toBe('客户端能改标题了');
  await expect(detail.getByTestId('detail-title')).toHaveText('客户端能改标题了');
  await expect(card(page, 138)).toContainText('客户端能改标题了');
  await expect(page.getByTestId('action-result')).toHaveCount(0);
  await expect(sendNotice(page)).toHaveCount(0);

  // ---- 4. changed on the web while being edited: refused, nothing written; said in the notice area (GitHub#489),
  // the dialog opens again with the typed text, theirs on GitHub ----
  await detail.getByTestId('detail-edit-title').click();
  retitle(138, '别人刚改的标题');
  await input.fill('又一版');
  const digest = fake.digest();
  await page.getByTestId('confirm-ok').click();
  await expect(sendNotice(page).first().getByTestId('send-notice-text')).toContainText('被别人改过');
  await expect(sendNotice(page).first().getByTestId('send-notice-text')).toContainText('原文已放回标题输入框');
  await expect(input).toHaveValue('又一版');
  expect(fake.digest()).toBe(digest);
  expect(onGitHub(138)).toBe('别人刚改的标题');
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  // the refusal read the detail again: it shows their title, and an edit started from it is saved
  await expect(detail.getByTestId('detail-title')).toHaveText('别人刚改的标题');
  await detail.getByTestId('detail-edit-title').click();
  await expect(input).toHaveValue('别人刚改的标题');
  await input.fill('又一版');
  await page.getByTestId('confirm-ok').click();
  await expect.poll(() => onGitHub(138)).toBe('又一版');
  await page.getByTestId('detail-close').click();

  // ---- 5. a PR, saved with the button, shown in the table ----
  await page.getByTestId('mode').selectOption('status');
  await card(page, 146).click();
  await detail.getByTestId('detail-edit-title').click();
  await input.fill('PR 的新标题');
  const b5 = writes().length;
  await page.getByTestId('confirm-ok').click();
  await expect.poll(() => writes().length).toBe(b5 + 1);
  expect(writes().slice(b5)).toEqual([['PATCH', '/api/repos/GigleAI/cavil-loop/issues/146', { title: 'PR 的新标题' }]]);
  await page.getByTestId('detail-close').click();
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await page.getByTestId('search').fill('');
  await expect(page.locator('[data-testid="row"][data-key="gigleai/cavil-loop#146"] [data-testid="row-title"]').first()).toContainText('PR 的新标题');
  await expect(page.locator('[data-testid="row"][data-key="gigleai/cavil-loop#138"] [data-testid="row-title"]').first()).toContainText('又一版');

  // ---- 6. offline: the button greys out, nothing is sent ----
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await card(page, 138).click();
  await expect(detail.getByTestId('detail-edit-title')).toBeEnabled();
  fake.state.offline = true;
  await page.getByTestId('refresh').press('Enter');
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(detail.getByTestId('detail-edit-title')).toBeDisabled();
  await expect(detail.getByTestId('detail-edit-title')).toHaveAttribute('title', '离线时不能修改');
  fake.state.offline = false;
  await app.close();
});

// ---- GitHub#297: each repository's swimlane scrolls on its own and folds to its head ----

test('GitHub#297: swimlanes — each repository scrolls sideways on its own, each column up and down within half the board; a lane folds to its head with its count, kept after a restart; filtering updates a folded count', async () => {
  // a second repository with three open issues (no Project): its lane is short
  const zeta = (n: number) => ({ number: n, node_id: `I_fixture_zeta${n}`, title: `zeta issue ${n}`, state: 'open', html_url: `https://github.com/GigleAI/zeta/issues/${n}`, updated_at: '2026-11-04T00:00:00Z', labels: [], assignees: [], milestone: null, user: { login: 'user-1' }, parent_issue_url: null, sub_issues_summary: null });
  env.fake.state.repos.set('gigleai/zeta', [zeta(1), zeta(2), zeta(3)]);
  let { app, page } = await launch(env);
  await signIn(page);
  await page.getByTestId('open-settings').click();
  for (const s of [PROJECT_URL, 'GigleAI/cavil-loop', 'GigleAI/zeta']) {
    await page.getByTestId('source-input').fill(s);
    await page.getByTestId('source-add').click();
  }
  await page.getByTestId('back').click();
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await page.getByTestId('search').fill('');
  await page.getByTestId('mode').selectOption('status');
  const done = rawCountFollowing('Status', 'name')['Done'];
  await expect.poll(async () => (await columnCounts(page))['Done'], { timeout: 15_000 }).toBe(done);
  await page.getByTestId('swimlanes').click();
  await expect(page.getByTestId('lane')).toHaveCount(2);
  const lane = (repo: string) => page.locator(`[data-testid="lane"][data-lane="${repo}"]`);
  const loop = lane('GigleAI/cavil-loop');
  const z = lane('GigleAI/zeta');
  await expect(z.locator('[data-testid="column"]').first()).toBeVisible();

  /** sideways scroll of each lane's row of columns, and of the whole board */
  const lefts = () =>
    page.evaluate(() => ({
      rows: Object.fromEntries([...document.querySelectorAll('[data-testid="lane"]')].map((l) => [l.getAttribute('data-lane'), (l.querySelector('.columns') as HTMLElement).scrollLeft])),
      board: (document.querySelector('.board') as HTMLElement).scrollLeft,
    }));
  // the rows are wider than the window (one column per status in every lane): each can scroll on its own
  const widths = await loop.locator('.columns').evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(widths[0]).toBeGreaterThan(widths[1]);
  const box = (await loop.locator('[data-testid="column"]').first().boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 20);
  await page.mouse.wheel(600, 0);
  await expect.poll(async () => (await lefts()).rows['GigleAI/cavil-loop']).toBeGreaterThan(0);
  expect(await lefts()).toMatchObject({ rows: { 'GigleAI/zeta': 0 }, board: 0 });
  await shot(page, '297-01-lanes-scrolled-apart');

  /** the "Done" column of cavil-loop: its height against the board's, and whether its cards scroll inside it */
  const doneCol = loop.locator('[data-testid="column"][data-title="Done"]');
  const shape = () =>
    doneCol.evaluate((col) => {
      const board = document.querySelector('.board') as HTMLElement;
      const body = col.querySelector('.column-body') as HTMLElement;
      const zHead = document.querySelector('[data-testid="lane"][data-lane="GigleAI/zeta"] [data-testid="lane-toggle"]')!.getBoundingClientRect();
      const b = board.getBoundingClientRect();
      return { col: col.getBoundingClientRect().height, board: board.clientHeight, body: [body.scrollHeight, body.clientHeight], nextHeadVisible: zHead.top >= b.top && zHead.bottom <= b.bottom };
    });
  for (const size of [{ width: 1280, height: 800 }, { width: 720, height: 480 }]) {
    await page.setViewportSize(size);
    await doneCol.scrollIntoViewIfNeeded();
    await page.locator('.board').evaluate((el) => (el.scrollTop = 0));
    await expect.poll(async () => (await shape()).col <= Math.floor((await shape()).board / 2) + 1).toBe(true);
    const s = await shape();
    expect(s.body[0]).toBeGreaterThan(s.body[1]); // more cards than fit: the column scrolls inside
    expect(s.nextHeadVisible).toBe(true); // the next repository's head is on screen without scrolling the board
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  // the wheel over that column scrolls the column, not the board
  const dbox = (await doneCol.locator('.column-body').boundingBox())!;
  await page.mouse.move(dbox.x + 40, dbox.y + 40);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => doneCol.locator('.column-body').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator('.board').evaluate((el) => el.scrollTop)).toBe(0);

  // fold cavil-loop: only its head is left, with the number of cards it holds; zeta is untouched
  const loopCards = async () => (await loop.locator('[data-testid="column-count"]').allTextContents()).reduce((n, t) => n + Number(t), 0);
  const before = await loopCards();
  expect(before).toBeGreaterThan(done - 1);
  await expect(loop.getByTestId('lane-count')).toHaveText(String(before));
  await loop.getByTestId('lane-toggle').click();
  await expect(loop).toHaveAttribute('data-folded', '');
  await expect(loop.locator('[data-testid="column"]')).toHaveCount(0);
  await expect(loop.getByTestId('lane-count')).toHaveText(String(before));
  await expect(loop.getByTestId('lane-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(z.locator('[data-testid="column"]').first()).toBeVisible();
  await expect(z.getByTestId('lane-count')).toHaveText('3');
  await shot(page, '297-02-lane-folded');

  // a filter changes the folded lane's count; it stays folded
  await page.getByTestId('search').fill('is:pr');
  await expect.poll(async () => Number(await loop.getByTestId('lane-count').textContent())).toBeLessThan(before);
  const prs = Number(await loop.getByTestId('lane-count').textContent());
  expect(prs).toBeGreaterThan(0);
  await expect(loop.locator('[data-testid="column"]')).toHaveCount(0);
  await expect(z).toHaveCount(0); // zeta has no PRs: no lane
  await page.getByTestId('search').fill('');
  await expect(z).toHaveCount(1);
  await expect(loop.getByTestId('lane-count')).toHaveText(String(before));

  // restart: still folded
  await app.close();
  ({ app, page } = await launch(env));
  const loop2 = page.locator('[data-testid="lane"][data-lane="GigleAI/cavil-loop"]');
  await expect(loop2).toHaveAttribute('data-folded', '', { timeout: 15_000 });
  await expect(loop2.locator('[data-testid="column"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="lane"][data-lane="GigleAI/zeta"] [data-testid="column"]').first()).toBeVisible();
  // unfold: its columns are back, the count matches them
  await loop2.getByTestId('lane-toggle').click();
  await expect(loop2).not.toHaveAttribute('data-folded', '');
  await expect.poll(async () => (await loop2.locator('[data-testid="column-count"]').allTextContents()).reduce((n, t) => n + Number(t), 0)).toBe(before);
  // swimlanes off: one row, no lane heads, as before
  await page.getByTestId('swimlanes').click();
  await expect(page.getByTestId('lane')).toHaveCount(0);
  await expect(page.getByTestId('lane-toggle')).toHaveCount(0);
  expect((await columnCounts(page))['Done']).toBe(done);

  // PR #300 review round 1: the smallest window with three bars above the board (update ready,
  // unsupported words, offline) — the columns shrink further, the next repository's head still shows
  await page.getByTestId('swimlanes').click();
  await page.setViewportSize({ width: 720, height: 480 });
  app.desktop.setUpdate({ supported: true, current: '0.5.0', auto: true, channel: 'stable', devUnavailable: null, problem: null, phase: 'ready', version: '0.5.1', dismissed: null, last: null });
  await expect(page.getByTestId('update-ready')).toBeVisible();
  await page.getByTestId('search').fill('updated:>2026-01-01');
  await expect(page.getByTestId('filter-unsupported')).toBeVisible();
  env.fake.state.offline = true;
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await page.locator('.board').evaluate((el) => (el.scrollTop = 0));
  const doneCol2 = page.locator('[data-testid="lane"][data-lane="GigleAI/cavil-loop"] [data-testid="column"][data-title="Done"]');
  const tight = () =>
    doneCol2.evaluate((col) => {
      const board = document.querySelector('.board') as HTMLElement;
      const b = board.getBoundingClientRect();
      const z = document.querySelector('[data-testid="lane"][data-lane="GigleAI/zeta"] [data-testid="lane-toggle"]')!.getBoundingClientRect();
      const body = col.querySelector('.column-body') as HTMLElement;
      return { board: board.clientHeight, col: col.getBoundingClientRect().height, nextTop: z.top, nextBottom: z.bottom, top: b.top, bottom: b.bottom, body: [body.scrollHeight, body.clientHeight] };
    });
  await expect.poll(async () => { const t = await tight(); return t.nextTop >= t.top && t.nextBottom <= t.bottom; }).toBe(true);
  const t = await tight();
  expect(t.board).toBeLessThan(260); // the bars really took the room (round 1 measured 191 px)
  expect(t.col).toBeLessThan(160); // so the column went below the old 160 px floor
  expect(t.col).toBeGreaterThanOrEqual(48);
  expect(t.body[0]).toBeGreaterThan(t.body[1]); // and still scrolls inside
  await shot(page, '297-03-small-window-three-bars');
  await app.close();
});

/**
 * A row dragged onto a target by hand (GitHub#294): press, a first move (the drag starts), then the
 * target brought into view and moved onto. Playwright's dragTo scrolls to the target before the drag
 * has started, and a long table then never starts one.
 */
async function dragRow(src: Locator, target: Locator) {
  const page = src.page();
  // in the middle of the view: a pointer near the edge makes the browser scroll the table while dragging
  await src.evaluate((el: Element) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const a = (await src.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 4 });
  // a group head: its group's body, not the (sticky) head itself: scrolling to a sticky row can leave it under the next group's head
  await target.evaluate((el: Element) => ((el.closest('.group-head') && el.closest('tbody')) || el).scrollIntoView({ block: 'center', inline: 'nearest' }));
  const b = (await target.boundingBox())!;
  const x = b.x + Math.min(20, b.width / 2);
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y, { steps: 6 });
  // WebKit only drops where the last "drag over" was accepted, and the last step above can end on an
  // element the pointer has only just entered: stay on it for two more moves before letting go — a hand
  // always does (GitHub#378: on WebKit the release right after entering dropped nothing)
  await page.mouse.move(x + 1, y);
  await page.mouse.move(x, y);
  await page.mouse.up();
}

test('GitHub#294: drag a table row to another group — the board\'s drop: set, clear, onto folded groups, "add to the board?" first; not when grouped by repository or offline', async () => {
  const { app, page } = await launch(env);
  await signInWithSources(page);
  // an item on no board, read from the board's own column before switching
  const lone = (await page.locator('[data-testid="column"][data-title="未加入看板"] [data-testid="card"]').first().getAttribute('data-key'))!;
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await expect(page.getByTestId('table')).toBeVisible();
  const group = (title: string) => page.locator(`[data-testid="group"][data-title="${title}"]`).first();
  const rowIn = (title: string, key: string) => group(title).locator(`[data-testid="row"][data-key="${key}"]`);
  const K = 'gigleai/cavil-loop#137';
  const from = (await page.locator(`[data-testid="row"][data-key="${K}"]`).first().locator('xpath=ancestor::tbody[1]').getAttribute('data-title'))!;
  // the table shows only groups that hold something: pick an iteration group that is there
  const T = 'Iteration 24';
  expect(from).not.toBe(T);
  await expect(group(T)).toBeVisible();
  const row = rowIn(from, K);
  await expect(row).toHaveAttribute('draggable', 'true');

  // ---- 1. onto another iteration's group: one iteration write, the row moves there ----
  const b1 = writes().length;
  await dragRow(row.locator('[data-testid="row-ref"]'), group(T).getByTestId('group-head'));
  // GitHub#488: said by the row moving, no result note
  await savedQuietly(page, sentOp('CavilSetIteration'), b1);
  await expect(rowIn(T, K)).toBeVisible();
  await expect(rowIn(from, K)).toHaveCount(0);
  await expect.poll(() => writes().slice(b1).map((w) => w[0])).toEqual(['CavilSetIteration']);
  expect((writes()[b1][2] as any).iterationId).toBeTruthy();
  // nothing stays lit once it is dropped
  await expect(page.locator('[data-drop-over]')).toHaveCount(0);
  await shot(page, '294-01-row-dropped');

  // ---- 2. onto 无迭代: cleared ----
  const b2 = writes().length;
  await dragRow(rowIn(T, K).locator('[data-testid="row-ref"]'), group('无迭代').locator('[data-testid="row"]').first());
  await expect(rowIn('无迭代', K)).toBeVisible();
  await expect.poll(() => writes().slice(b2).map((w) => w[0])).toEqual(['CavilClearField']);

  // ---- 3. onto a folded group's head, and onto a name in "已收起 N 组" ----
  await group(T).getByTestId('group-toggle').click();
  const b25 = writes().length;
  await dragRow(rowIn('无迭代', K).locator('[data-testid="row-ref"]'), group(T).getByTestId('group-head'));
  await savedQuietly(page, sentOp('CavilSetIteration'), b25);
  await expect.poll(async () => (await rowIn('无迭代', K).count())).toBe(0);
  await group(T).getByTestId('group-toggle').click();
  await expect(rowIn(T, K)).toBeVisible();
  // fold two groups next to each other, then drop on the second one's name in the joined line
  const titles = await page.locator('[data-testid="group"]').evaluateAll((gs) => gs.map((g) => g.getAttribute('data-title') ?? ''));
  const i = titles.findIndex((t, n) => t.startsWith('Iteration') && titles[n + 1]?.startsWith('Iteration') && t !== T && titles[n + 1] !== T && t !== from && titles[n + 1] !== from);
  expect(i).toBeGreaterThanOrEqual(0);
  const [g1, g2] = [titles[i], titles[i + 1]];
  await group(g1).getByTestId('group-toggle').click();
  await group(g2).getByTestId('group-toggle').click();
  const run = page.getByTestId('fold-run').first();
  await expect(run).toBeVisible();
  const target = run.locator(`[data-testid="fold-run-group"]`, { hasText: g2 });
  const b3 = writes().length;
  await dragRow(rowIn(T, K).locator('[data-testid="row-ref"]'), target);
  await savedQuietly(page, sentOp('CavilSetIteration'), b3);
  await expect.poll(() => writes().slice(b3).map((w) => w[0])).toEqual(['CavilSetIteration']);
  await expect(rowIn(T, K)).toHaveCount(0);
  await target.click();
  await expect(rowIn(g2, K)).toBeVisible();

  // ---- 4. an item on no board: "加入看板？" first; cancelled, nothing sent ----
  const loneFrom = (await page.locator(`[data-testid="row"][data-key="${lone}"]`).first().locator('xpath=ancestor::tbody[1]').getAttribute('data-title'))!;
  expect(loneFrom).toBe('无迭代');
  const b4 = writes().length;
  await dragRow(rowIn('无迭代', lone).locator('[data-testid="row-ref"]'), group(T).getByTestId('group-head'));
  await expect(page.getByTestId('confirm-question')).toContainText('还没加入看板');
  await shot(page, '294-02-add-to-board');
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  expect(writes().slice(b4)).toEqual([]);

  // ---- 5. grouped by repository: rows do not drag ----
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('repo');
  await page.getByTestId('open-view-panel').click();
  await expect(page.locator('[data-testid="row"]').first()).toBeVisible();
  expect(await page.locator('[data-testid="row"][draggable="true"]').count()).toBe(0);
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('iteration');
  await page.getByTestId('open-view-panel').click();
  await expect(page.locator('[data-testid="row"][draggable="true"]').first()).toBeVisible();

  // ---- 6. offline: rows do not drag ----
  env.fake.state.offline = true;
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="row"]').first()).toBeVisible();
  expect(await page.locator('[data-testid="row"][draggable="true"]').count()).toBe(0);
  await app.close();
});

/**
 * A repository dragged by hand (GitHub#304), the same way as a row (GitHub#294): press, a first move
 * (the drag starts), then onto the upper (or lower) part of the target.
 */
async function dragRepo(src: Locator, target: Locator, after = false) {
  const page = src.page();
  await src.evaluate((el: Element) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const a = (await src.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 6, a.y + a.height / 2 + 6, { steps: 4 });
  await target.evaluate((el: Element) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const b = (await target.boundingBox())!;
  const y = after ? b.y + b.height * 0.8 : b.y + b.height * 0.2;
  await page.mouse.move(b.x + Math.min(30, b.width / 2), y, { steps: 6 });
  await page.mouse.move(b.x + Math.min(30, b.width / 2) + 4, y, { steps: 2 });
  await expect(target).toHaveAttribute('data-drop-at', after ? 'after' : 'before'); // the drag started and reached the target
  await page.mouse.up();
  await expect(page.locator('[data-drop-at]')).toHaveCount(0);
}

test('GitHub#304: drag repositories in the table\'s list and by the board\'s swimlane heads — one order everywhere; a drag while the search hides one leaves it in its place; kept across a restart; "按名称排序"; cards and repositories do not drop on each other', async () => {
  // three repositories, one open issue each; the search "kept" hides alpha (GigleAI/aaa)
  const issue = (repo: string, n: number, title: string) => ({ number: n, node_id: `I_fixture_${repo}${n}`, title, state: 'open', html_url: `https://github.com/GigleAI/${repo}/issues/${n}`, updated_at: '2026-11-04T00:00:00Z', labels: [], assignees: [], milestone: null, user: { login: 'user-1' }, parent_issue_url: null, sub_issues_summary: null });
  env.fake.state.repos.set('gigleai/aaa', [issue('aaa', 1, 'alpha hidden')]);
  env.fake.state.repos.set('gigleai/bbb', [issue('bbb', 1, 'beta kept')]);
  env.fake.state.repos.set('gigleai/ccc', [issue('ccc', 1, 'gamma kept')]);
  const [A, B, C] = ['GigleAI/aaa', 'GigleAI/bbb', 'GigleAI/ccc'];

  let { app, page } = await launch(env);
  await signIn(page);
  await page.getByTestId('open-settings').click();
  for (const r of [A, B, C]) {
    await page.getByTestId('source-input').fill(r);
    await page.getByTestId('source-add').click();
  }
  await page.getByTestId('back').click();
  const search = page.getByTestId('search');
  await search.fill('');
  const layout = (l: 'board' | 'table') => page.locator(`[data-testid="layout"] button[data-value="${l}"]`).click();
  const slice = (r: string) => page.locator(`[data-testid="slice"][data-value="${r}"]`);
  const lane = (r: string) => page.locator(`[data-testid="lane"][data-lane="${r}"] [data-testid="lane-toggle"]`);
  const slices = () => page.$$eval('[data-testid="slice"]', (s) => s.map((x) => x.getAttribute('data-value')).filter((v) => v));
  const lanes = () => page.$$eval('[data-testid="lane"]', (s) => s.map((x) => x.getAttribute('data-lane')));
  const heads = async () => (await repoHeads(page)).map(([t]) => t);
  const saved = () => page.evaluate(async () => (await (window as any).cavil.get()).state.repoOrder as string[]);
  /**
   * What the back end has written to disk. The window queues setting writes to the back end; closing it
   * while one is still queued loses it (PR #408 review round 2: under load a restart came back with an
   * older order). A restart is only meaningful once the order is really stored, so every close waits here.
   */
  const stored = () => app.backend.call<{ settings: Record<string, unknown> }>('init', {}).then((r) => r.settings.repoOrder ?? null);
  /** the order on screen in the table (the slice list and the "all repositories" sections) and on the board (the swimlanes) */
  async function everywhere(want: string[]) {
    await layout('table');
    await expect.poll(slices, { timeout: 15_000 }).toEqual(want);
    await expect.poll(heads).toEqual(want);
    await layout('board');
    await expect.poll(lanes, { timeout: 15_000 }).toEqual(want);
  }

  // ---- 1. alphabetical to start with; the board's swimlanes on ----
  await layout('board');
  await page.getByTestId('swimlanes').check();
  await everywhere([A, B, C]);
  await layout('table');
  await expect(page.getByTestId('repo-order-reset')).toHaveCount(0);

  // ---- 2. table: c dragged to the top → c, a, b (not alphabetical); everywhere ----
  await dragRepo(slice(C), slice(A));
  await everywhere([C, A, B]);
  expect(await saved()).toEqual(['gigleai/ccc', 'gigleai/aaa', 'gigleai/bbb']);

  // ---- 3. table: the search hides a; b dragged before c; the search cleared → b, a, c (a kept its place) ----
  await layout('table');
  await search.fill('kept');
  await expect.poll(slices).toEqual([C, B]);
  await dragRepo(slice(B), slice(C));
  await expect.poll(slices).toEqual([B, C]);
  await search.fill('');
  await everywhere([B, A, C]);

  // ---- 4. a restart keeps it ----
  await expect.poll(stored, { timeout: 15_000 }).toEqual(['gigleai/bbb', 'gigleai/aaa', 'gigleai/ccc']);
  await app.close();
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('search').fill('');
  await everywhere([B, A, C]);
  await shot(page, '304-01-lanes-after-restart');

  // ---- 5. "按名称排序" → alphabetical again, the link goes away ----
  await layout('table');
  await page.getByTestId('repo-order-reset').click();
  await expect(page.getByTestId('repo-order-reset')).toHaveCount(0);
  await everywhere([A, B, C]);

  // ---- 6. the same round trip by the board's swimlane heads ----
  await dragRepo(lane(C), lane(A));
  await everywhere([C, A, B]);
  await page.getByTestId('search').fill('kept');
  await expect.poll(lanes).toEqual([C, B]);
  await dragRepo(lane(B), lane(C));
  await expect.poll(lanes).toEqual([B, C]);
  await page.getByTestId('search').fill('');
  await everywhere([B, A, C]);
  // dropped on the lower half: after the target
  await dragRepo(lane(B), lane(C), true);
  await everywhere([A, C, B]);
  await expect.poll(stored, { timeout: 15_000 }).toEqual(['gigleai/aaa', 'gigleai/ccc', 'gigleai/bbb']);
  await app.close();
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('search').fill('');
  await everywhere([A, C, B]);

  // ---- 7. a card dragged onto a swimlane head, a swimlane dragged onto a column: nothing changes, nothing is written ----
  const w0 = writes().length;
  const card = page.locator(`[data-testid="lane"][data-lane="${B}"] [data-testid="card"]`).first();
  const column = page.locator(`[data-testid="lane"][data-lane="${A}"] [data-testid="column"]`).first();
  {
    const a = (await card.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 6, a.y + a.height / 2 + 6, { steps: 4 });
    const c = (await column.boundingBox())!;
    await page.mouse.move(c.x + c.width / 2, c.y + 40, { steps: 6 });
    await page.mouse.move(c.x + c.width / 2 + 4, c.y + 44, { steps: 2 });
    await expect(column).toHaveClass(/drop-over/); // the card drag started and reached a column…
    const h = (await lane(A).boundingBox())!;
    await page.mouse.move(h.x + 30, h.y + h.height / 2, { steps: 6 });
    await page.mouse.move(h.x + 34, h.y + h.height / 2, { steps: 2 });
    await expect(lane(A)).not.toHaveAttribute('data-drop-at', /.*/); // …and the swimlane head does not take it
    await page.mouse.up();
  }
  {
    const h = (await lane(C).boundingBox())!;
    await page.mouse.move(h.x + 30, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 36, h.y + h.height / 2 + 6, { steps: 4 });
    const t = (await lane(B).boundingBox())!;
    await page.mouse.move(t.x + 30, t.y + t.height * 0.2, { steps: 6 });
    await page.mouse.move(t.x + 34, t.y + t.height * 0.2, { steps: 2 });
    await expect(lane(B)).toHaveAttribute('data-drop-at', 'before'); // the swimlane drag started…
    const c = (await column.boundingBox())!;
    await page.mouse.move(c.x + c.width / 2, c.y + 40, { steps: 6 });
    await page.mouse.move(c.x + c.width / 2 + 4, c.y + 44, { steps: 2 });
    await page.mouse.up(); // …and ended on a column
  }
  await page.waitForTimeout(500);
  expect(writes().slice(w0)).toEqual([]);
  await everywhere([A, C, B]);
  await expect(page.locator(`[data-testid="lane"][data-lane="${B}"] [data-testid="card"]`)).toHaveCount(1);
  await app.close();
});

test('GitHub#323 → GitHub#488: a field change from the table that GitHub did not take says nothing above the board — it is said once, in the notice area, and goes with the change (resent, abandoned, seen on GitHub); a success says nothing', async () => {
  const { app, page } = await launch(env);
  await signInWithSources(page);
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  const row = (n: number) => page.locator(`[data-testid="row"][data-key="gigleai/cavil-loop#${n}"]`).first();
  await expect(row(138)).toBeVisible({ timeout: 15_000 });
  const bar = page.getByTestId('board-action-result');
  const editsBar = page.locator('[data-testid="notice-area"] [data-testid="edits-bar"]');
  const issue = (n: number) => page.locator(`[data-testid="notice-area"] [data-testid="edit-issues-item"][data-key="gigleai/cavil-loop#${n}"]`);
  /** #n's own list in the notice area (the checks are per item: another item's record has its own life) */
  const itsList = (n: number) => page.locator('[data-testid="notice-area"] [data-testid="edit-issues"]', { has: page.locator(`[data-testid="edit-issues-item"][data-key="gigleai/cavil-loop#${n}"]`) });
  const addLabel = async (n: number, label: string) => {
    await row(n).locator('[data-testid="cell"][data-col="labels"]').click();
    await row(n).locator(`[data-testid="cell-label-picker"] [data-testid="picker-item"][data-name="${label}"]`).click();
    await page.keyboard.press('Escape');
  };
  const labelOnGitHub = (n: number, name: string) => {
    const c = findCopies(env.fake.state as any, 'GigleAI/cavil-loop', n)!;
    const now = new Date().toISOString();
    for (const g of c.gql) if (!g.labels.nodes.some((l: any) => l.name === name)) (g.labels.nodes.push({ name, color: 'ededed' }), (g.updatedAt = now));
    for (const r of c.rest) if (!r.labels.some((l: any) => (l.name ?? l) === name)) (r.labels.push({ name, color: 'ededed' }), (r.updated_at = now));
  };
  const unsure = async (n: number, label: string) => {
    env.fake.state.w.dropWrites = true;
    await addLabel(n, label);
    await expect(issue(n)).toBeVisible({ timeout: 15_000 });
    await expect(itsList(n).locator('[data-testid="edit-issue"][data-edit="unconfirmed"]')).toHaveCount(1);
    env.fake.state.w.dropWrites = false;
    // said once: in the notice area, never also above the board
    await expect(bar).toHaveCount(0);
    await expect(page.getByTestId('edits-bar')).toHaveCount(1);
  };

  // 1. no answer from GitHub: in the notice area; 全部放弃 → gone, nothing sent
  await unsure(138, 'Done');
  await shot(page, '488-323-01-unsure-in-notice-area');
  const w0 = env.fake.writes().length;
  await editsBar.getByTestId('edits-abandon-all').click();
  await expect(editsBar).toHaveCount(0);
  expect(env.fake.writes().length).toBe(w0);

  // 2. resent and accepted: gone by itself, the label on the row
  await unsure(138, 'Done');
  await itsList(138).getByTestId('edit-resend').click();
  await expect(issue(138)).toHaveCount(0, { timeout: 15_000 });
  await expect(bar).toHaveCount(0);
  await expect(row(138).locator('[data-testid="cell"][data-col="labels"] .label', { hasText: 'Done' })).toBeVisible();

  // 3. the change turns out to be on GitHub (a refresh reads it): gone by itself
  await unsure(137, 'Done');
  labelOnGitHub(137, 'Done');
  await page.getByTestId('refresh').click();
  await expect(issue(137)).toHaveCount(0, { timeout: 15_000 });
  await expect(bar).toHaveCount(0);

  // 4. refused for sure: in the notice area as 没保存上, nothing above the board; abandoned → gone
  env.fake.state.w.failLabel = 'pending/PR';
  await addLabel(137, 'pending/PR');
  await expect(itsList(137).locator('[data-testid="edit-issue"]')).toHaveAttribute('data-edit', 'failed', { timeout: 15_000 });
  await expect(bar).toHaveCount(0);
  await itsList(137).getByTestId('edit-abandon').click();
  await expect(issue(137)).toHaveCount(0);
  env.fake.state.w.failLabel = null;

  // 5. a plain success: the cell shows it, nothing is said anywhere
  const w5 = writes().length;
  await addLabel(144, 'pending/PR');
  await expect.poll(() => writes().slice(w5).some(sentTo('POST', '/issues/144/labels')), { timeout: 15_000 }).toBe(true);
  await expect(row(144).locator('[data-testid="cell"][data-col="labels"] .label', { hasText: 'pending/PR' })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(bar).toHaveCount(0);
  await expect(issue(144)).toHaveCount(0);
  await app.close();
});

test('GitHub#323 (PR #327 review round 1) → GitHub#488: a field change made in the detail and answered after the detail was closed or moved on is said in the notice area only, never above the board; a failed comment left behind is not taken away by an unrelated change', async () => {
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const bar = page.getByTestId('board-action-result');
  const editsBar = page.locator('[data-testid="notice-area"] [data-testid="edits-bar"]');
  const labelPosts = (n: number) => env.fake.log.filter((l) => l.method === 'POST' && l.path.endsWith(`/issues/${n}/labels`)).length;
  /** in #n's detail: add `label`, GitHub holds the answer; returns the release */
  const addHeld = async (n: number, label: string) => {
    await card(page, n).getByTestId('card-title').click();
    await expect(page.getByTestId('detail')).toHaveAttribute('data-key', `gigleai/cavil-loop#${n}`);
    const p0 = labelPosts(n);
    const release = env.fake.holdWhen((e) => e.method === 'POST' && e.path.endsWith(`/issues/${n}/labels`));
    await pickLabel(page, label);
    await expect.poll(() => labelPosts(n)).toBe(p0 + 1);
    return release;
  };

  /** a click on the board's bars may already have put the detail away */
  const putAway = async () => {
    if (await page.getByTestId('detail').count()) await page.getByTestId('detail-close').click();
    await expect(page.getByTestId('detail')).toHaveCount(0);
  };

  // 1. the detail is closed before GitHub refuses: said in the notice area, nothing above the board; abandoned → it goes
  env.fake.state.w.failLabel = 'pending/PR';
  let release = await addHeld(139, 'pending/PR');
  await page.getByTestId('detail-close').click();
  await expect(page.getByTestId('detail')).toHaveCount(0);
  release();
  await expect(editsBar).toHaveAttribute('data-count', '1', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await expect(bar).toHaveCount(0);
  await editsBar.getByTestId('edits-abandon-all').click();
  await expect(editsBar).toHaveCount(0);

  // 2. another item is opened before GitHub refuses: the same, and nothing in the item now open; resent and accepted → it goes
  release = await addHeld(139, 'pending/PR');
  await card(page, 138).click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', 'gigleai/cavil-loop#138');
  release();
  await expect(editsBar).toHaveAttribute('data-count', '1', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId('action-result')).toHaveCount(0);
  env.fake.state.w.failLabel = null;
  await editsBar.getByTestId('edits-resend-all').click();
  await expect(editsBar).toHaveCount(0, { timeout: 15_000 });
  await expect(bar).toHaveCount(0);
  await expect(card(page, 139).locator('.label', { hasText: 'pending/PR' })).toBeVisible();
  await putAway();

  // 3. a comment that failed after its detail was closed is not a field change: a field change of the
  //    same item coming and going leaves its bar alone; the × puts it away
  env.fake.state.w.failComment = true;
  await card(page, 137).getByTestId('card-title').click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  const c0 = env.fake.log.filter((l) => l.method === 'POST' && l.path.endsWith('/issues/137/comments')).length;
  release = env.fake.holdWhen((e) => e.method === 'POST' && e.path.endsWith('/issues/137/comments'));
  await page.getByTestId('reply-input').fill('留在看板上的失败评论');
  await page.getByTestId('reply-send').click();
  await expect.poll(() => env.fake.log.filter((l) => l.method === 'POST' && l.path.endsWith('/issues/137/comments')).length).toBe(c0 + 1);
  await page.getByTestId('detail-close').click();
  await expect(page.getByTestId('detail')).toHaveCount(0);
  release();
  // GitHub#489: the comment's result is in the notice area too; its text waits for #137's reply box
  const failed = page.locator('[data-testid="notice-area"] [data-testid="send-notice"][data-key="gigleai/cavil-loop#137"]');
  await expect(failed).toHaveAttribute('data-kind', 'error', { timeout: 15_000 });
  await expect(failed.getByTestId('send-notice-text')).toContainText('打开这一条时会放回回复框');
  await expect(bar).toHaveCount(0);
  env.fake.state.w.failComment = false;
  // a field change of #137 made and answered inside its detail (said in the notice area), then abandoned
  await card(page, 137).getByTestId('card-title').click();
  await expect(page.getByTestId('reply-input')).toHaveValue('留在看板上的失败评论');
  await expect(failed.getByTestId('send-notice-text')).toContainText('原文已放回回复框');
  const kept = await failed.getByTestId('send-notice-text').textContent();
  env.fake.state.w.dropWrites = true;
  await pickLabel(page, 'Done');
  await expect(editsBar).toHaveAttribute('data-count', '1', { timeout: 15_000 });
  env.fake.state.w.dropWrites = false;
  await expect(failed.getByTestId('send-notice-text')).toHaveText(kept ?? '');
  await editsBar.getByTestId('edits-abandon-all').click();
  await expect(editsBar).toHaveCount(0);
  // the box emptied without sending: the text is let go (PR #510 review round 1), the refusal itself stays
  await page.getByTestId('reply-input').fill('');
  await expect(failed.getByTestId('send-notice-text')).toHaveText((kept ?? '').replace('。原文已放回回复框', ''));
  await putAway();
  await page.waitForTimeout(500);
  await expect(failed.getByTestId('send-notice-text')).toHaveText((kept ?? '').replace('。原文已放回回复框', ''));
  await failed.getByTestId('send-dismiss').click();
  await expect(failed).toHaveCount(0);
  await expect(bar).toHaveCount(0);
  await app.close();
});

// ---- GitHub#322: the reply card is easy to hit — a click on its free space goes into the box; R works
// after a click in the discussion too (only R: every other key stays in the isolated frame, PR #171) ----
test('GitHub#322: a click on the reply card\'s free space types into the box; R from inside the discussion; the box grows with its text; buttons, selections, dialogs and offline keep their own way', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const node = env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((n: any) => n.content?.__typename === 'PullRequest')!;
  const prN = node.content.number as number;
  const c = findCopies(store, 'GigleAI/cavil-loop', prN)!;
  for (const g of c.gql) Object.assign(g, { state: 'OPEN', merged: false });
  for (const r of c.rest) Object.assign(r, { state: 'open', pull_request: { ...(r.pull_request ?? {}), merged_at: null } });
  Object.assign(pullOf(store, c), { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: 'SUCCESS', reviewDecision: null });
  const { app, page } = await launch(env);
  await signInWithSources(page);
  await page.evaluate(() => (window as any).cavil.setView({ detailWidth: 720 }));
  await card(page, prN).click();
  const detail = page.getByTestId('detail');
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  const reply = detail.getByTestId('reply-input');
  const box = detail.getByTestId('reply');
  const focused = () => reply.evaluate((el) => el === document.activeElement);
  const ring = () => box.evaluate((el) => getComputedStyle(el).boxShadow);
  /** a click on the bottom row's free space: the middle of its spacer (GitHub#433: the far-away "按 ⌘↩ 发送" hint is gone) */
  const clickRowSpace = async () => {
    const space = (await detail.locator('.reply .row.end > .spacer').boundingBox())!;
    expect(space.width).toBeGreaterThan(20);
    await page.mouse.click(space.x + space.width / 2, space.y + space.height / 2);
  };

  // ---- 1. the box says how to get there; about four lines tall ----
  await expect(reply).toHaveAttribute('placeholder', '回复（支持 markdown）· 按 R 随时跳到这里');
  expect(await reply.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96);

  // ---- 2. free space of the PR line and of the button row: into the box, the card lights up ----
  await blur(page);
  expect(await ring()).toBe('none');
  const status = (await detail.getByTestId('pr-status').boundingBox())!;
  const actions = (await detail.locator('.pr-actions').boundingBox())!;
  expect(actions.x - (status.x + status.width)).toBeGreaterThan(20); // there is free space between them
  await page.mouse.click((status.x + status.width + actions.x) / 2, status.y + status.height / 2);
  await expect(reply).toBeFocused();
  expect(await ring()).not.toBe('none');
  await blur(page);
  await clickRowSpace();
  await expect(reply).toBeFocused();

  // ---- 3. buttons and lists do their own thing, the box does not take the focus ----
  await blur(page);
  await detail.getByTestId('merge-method').click();
  expect(await focused()).toBe(false);
  await page.keyboard.press('Escape'); // the list's own Esc
  await reply.fill('看过了');
  await blur(page);
  await detail.getByTestId('reply-preview-toggle').click();
  await expect(detail.getByTestId('reply-preview')).toBeVisible();
  expect(await focused()).toBe(false);
  await detail.getByTestId('reply-preview-toggle').click();
  await reply.fill('');

  // ---- 4. dragging over the card's words to copy them: the selection stays, the box does not jump in ----
  await blur(page);
  const hint = (await detail.getByTestId('pr-status').boundingBox())!;
  await page.mouse.move(hint.x + 1, hint.y + hint.height / 2);
  await page.mouse.down();
  await page.mouse.move(hint.x + hint.width - 1, hint.y + hint.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => String(window.getSelection()))).not.toBe('');
  expect(await focused()).toBe(false);

  // ---- 5. inside the discussion: R goes to the reply box ----
  const summary = frame.locator('details.entry > summary').first();
  await summary.click({ position: { x: 40, y: 10 } });
  expect(await focused()).toBe(false);
  await page.keyboard.press('r');
  await expect(reply).toBeFocused();
  await page.keyboard.type('x');
  await expect(reply).toHaveValue('x'); // the R itself was not typed into the box
  await reply.fill('');
  // Esc still stays in the discussion (PR #171), so do the other keys
  await summary.click({ position: { x: 40, y: 10 } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('l');
  await page.waitForTimeout(300);
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('label-picker')).toHaveCount(0);
  // R with Shift / Alt, or while an input method composes: not ours
  await page.keyboard.press('Shift+R');
  await page.keyboard.press('Alt+r');
  const frameKeydown = (o: { key: string; isComposing?: boolean }) =>
    frame.locator('body').evaluate((_b, o) => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: o.key, isComposing: Boolean(o.isComposing) })), o);
  await frameKeydown({ key: 'r', isComposing: true });
  await page.waitForTimeout(300);
  expect(await focused()).toBe(false);
  await frameKeydown({ key: 'r' }); // the same event without composing does go through
  await expect(reply).toBeFocused();

  // ---- 6. a dialog on top takes the keys: R from the discussion does nothing ----
  await blur(page);
  await detail.getByTestId('close-pr').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await frameKeydown({ key: 'r' });
  await page.waitForTimeout(300);
  expect(await focused()).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

  // ---- 7. the box grows with its text up to 40% of the panel, then scrolls; a long word wraps ----
  const h0 = await reply.evaluate((el) => el.getBoundingClientRect().height);
  await reply.fill(Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
  const h10 = await reply.evaluate((el) => el.getBoundingClientRect().height);
  expect(h10).toBeGreaterThan(h0);
  expect(await reply.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true); // all ten lines show
  await reply.fill(Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
  const panelH = await detail.evaluate((el) => el.clientHeight);
  const hMax = await reply.evaluate((el) => el.getBoundingClientRect().height);
  expect(hMax).toBeLessThanOrEqual(Math.round(panelH * 0.4) + 1);
  expect(await reply.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await reply.fill(`https://example.com/${'a'.repeat(600)}`);
  expect(await reply.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await reply.fill('');
  expect(await reply.evaluate((el) => el.getBoundingClientRect().height)).toBeCloseTo(h0, 0);

  // ---- 7b. a smaller window: the limit follows the panel as it is now (PR #325 review round 1); a dragged height stays ----
  const height = () => reply.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const cap = async () => Math.round((await detail.evaluate((el) => el.clientHeight)) * 0.4);
  const size0 = page.viewportSize()!;
  await reply.fill(Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
  const tall = await height();
  expect(tall).toBeGreaterThan(200); // it did grow to the limit of the big window
  await page.setViewportSize({ width: size0.width, height: 500 });
  await expect.poll(async () => (await height()) <= (await cap()) + 1).toBe(true);
  expect(await height()).toBeLessThan(tall);
  expect(await height()).toBeGreaterThanOrEqual(96);
  await page.setViewportSize(size0);
  await expect.poll(height).toBe(tall); // and back up with the window
  // a narrower panel wraps more lines: the height is worked out again without typing
  await reply.fill('字'.repeat(300));
  const wide = await height();
  await page.setViewportSize({ width: 700, height: size0.height });
  await expect.poll(height).toBeGreaterThan(wide);
  await page.setViewportSize(size0);
  await expect.poll(height).toBe(wide);
  // dragging the box's own corner: that height is the least it goes back to, typing does not undo it
  await reply.fill('');
  const small = await height();
  const rb = (await reply.boundingBox())!;
  await page.mouse.move(rb.x + rb.width - 4, rb.y + rb.height - 4);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width - 4, rb.y + rb.height - 4 + 80, { steps: 8 });
  // Linux WebKit (what CI runs) draws no corner to drag on a text box — the macOS app's WebKit and
  // Chromium do. On that one engine only, the engine's part (the box gets a new height while the button
  // is held) is done here, between the same press and release, and what the app does with that height
  // is checked; everywhere else the real drag must have changed the height by itself (GitHub#378).
  const noCorner = process.platform === 'linux' && page.context().browser()?.browserType().name() === 'webkit';
  if (noCorner) {
    expect(await height()).toBe(small); // still true there: if Linux WebKit ever grows a corner, stop standing in for it
    await reply.evaluate((el: HTMLElement, h: number) => { el.style.height = `${h}px`; }, small + 80);
  }
  await page.mouse.up();
  const draggedH = await height();
  expect(draggedH).toBeGreaterThan(small + 40);
  await reply.fill('一行\n两行');
  expect(await height()).toBe(draggedH);
  await reply.fill('');
  expect(await height()).toBe(draggedH);
  await reply.fill(Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
  expect(await height()).toBe(tall); // more text still grows it to the limit
  await reply.fill('');
  expect(await height()).toBe(draggedH);

  // ---- 8. offline: the box cannot take text, a click on the card does nothing ----
  env.fake.state.offline = true;
  await page.getByTestId('refresh').press('Enter');
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(reply).toBeDisabled();
  await expect(reply).toHaveAttribute('placeholder', '离线时不能回复');
  await blur(page);
  await clickRowSpace();
  expect(await focused()).toBe(false);
  await expect(detail).toBeVisible();
  await app.close();
});

test('GitHub#357: a notice\'s colour follows what is going on — blue with a spinner while its own request runs, green then gone after 5 s, red when the last attempt failed; the same on the board and in the detail', async () => {
  // PR #146 open and mergeable, issue #138 open, in every copy
  for (const r of env.fake.state.repos.get('gigleai/cavil-loop')!) {
    if (r.number === 146) Object.assign(r, { state: 'open', pull_request: { ...r.pull_request, merged_at: null } });
    if (r.number === 138) Object.assign(r, { state: 'open', state_reason: null });
  }
  for (const p of env.fake.state.projects.get('org/gigleai/11')!)
    for (const n of p.items.nodes) {
      if (n.content?.number === 146) Object.assign(n.content, { state: 'OPEN', merged: false });
      if (n.content?.number === 138) Object.assign(n.content, { state: 'OPEN', stateReason: null });
    }
  const { app, page } = await launch(env);
  await page.clock.install();
  await page.reload();
  await page.waitForSelector('[data-testid="app-root"]');
  await signInWithSources(page);
  const ff = async (ms: number) => {
    await page.clock.fastForward(ms);
    await page.waitForTimeout(100);
  };
  const KEY = (n: number) => `gigleai/cavil-loop#${n}`;
  // GitHub#488: one place for both — the window's notice area, with the detail open and after it was put away
  const onBoard = (n: number) => page.locator(`[data-testid="notice-area"] [data-testid="op-notice"][data-key="${KEY(n)}"]`);
  const inDetail = onBoard;
  const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
  /** what the bar shows left of its words: the spinner, or which icon */
  const mark = (l: Locator) => l.evaluate((el) => (el.querySelector(':scope > .spin') ? 'spin' : (el.querySelector(':scope > svg.icon')?.getAttribute('data-icon') ?? 'none')));
  const looks = async (l: Locator, tone: string, icon: string) => {
    await expect(l).toHaveAttribute('data-kind', tone);
    await expect(l).toHaveClass(new RegExp(`\\b${tone}\\b`));
    expect(await mark(l)).toBe(icon);
  };

  // ---- 1. merge: on its way (blue, spinner) → accepted, waiting for GitHub's state (still blue, spinner, no tick) → read back (green, tick) → gone after 5 s ----
  const releaseMerge = env.fake.holdWhen((e) => e.method === 'PUT' && e.path === '/api/repos/GigleAI/cavil-loop/pulls/146/merge');
  await card(page, 146).click();
  await expect(page.getByTestId('pr-status')).toContainText('可以合并');
  await page.getByTestId('merge').click();
  await page.getByTestId('confirm-ok').click();
  await expect(inDetail(146).getByTestId('op-notice-text')).toHaveText('正在合并 PR #146…');
  await looks(inDetail(146), 'busy', 'spin');
  // GitHub#488: the panel's own notices button has nothing of it
  await expect(page.getByTestId('detail').getByTestId('detail-notices-toggle')).toHaveCount(0);
  // the re-reads after the answer are held: the merge is accepted, its result not read back yet
  const releaseReads = env.fake.holdWhen((e) => e.operation === 'CavilItemRefresh');
  releaseMerge();
  await expect(inDetail(146).getByTestId('op-notice-text')).toHaveText('PR #146 已合并（正在等 GitHub 的最新状态）');
  await looks(inDetail(146), 'busy', 'spin');
  // the same notice above the board says the same
  await page.getByTestId('detail-close').click();
  await expect(onBoard(146).getByTestId('op-notice-text')).toHaveText('PR #146 已合并（正在等 GitHub 的最新状态）');
  await looks(onBoard(146), 'busy', 'spin');
  const blue = await bg(onBoard(146));
  await expect(onBoard(146)).not.toHaveAttribute('data-auto-dismiss', /./);
  await shot(page, '357-01-merged-waiting-blue');
  releaseReads();
  await expect(onBoard(146).getByTestId('op-notice-text')).toHaveText('PR #146 已合并', { timeout: 15_000 });
  await looks(onBoard(146), 'ok', 'check');
  const green = await bg(onBoard(146));
  expect(green).not.toBe(blue);
  expect(green).toBe('rgb(218, 251, 225)');
  await expect(onBoard(146)).toHaveAttribute('data-auto-dismiss', /counting|paused/);
  await shot(page, '357-02-merged-green');
  await page.mouse.move(5, 5);
  await ff(4_000);
  await expect(onBoard(146)).toBeVisible();
  await ff(1_200);
  await expect(onBoard(146)).toHaveCount(0);
  expect(env.fake.writes().filter((w) => w.method === 'PUT' && w.path.endsWith('/pulls/146/merge'))).toHaveLength(1);

  // ---- 2. a close whose answer never came: being checked (blue, "正在查证") → the app's own checks could not read (GitHub#359: yellow,
  //         "这次没能查证" — every sync round checks again, there is no button for it) → the next round's check proves it (green) ----
  const late = env.fake.lateWhen((e) => e.method === 'PATCH' && e.path === '/api/repos/GigleAI/cavil-loop/issues/138');
  env.fake.state.w.failRefresh.add(KEY(138));
  let checkReads = 0;
  const releaseCheck = env.fake.holdWhen((e) => e.operation === 'CavilItemRefresh' && e.variables?.number === 138 && ++checkReads > 0);
  await page.getByTestId('search').fill('#138');
  await card(page, 138).click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', KEY(138));
  await page.getByTestId('close-issue').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect.poll(() => late.caught()).toBe(1);
  await expect(inDetail(138).getByTestId('op-notice-text')).toContainText('；正在查证…');
  await looks(inDetail(138), 'busy', 'spin');
  await expect(inDetail(138).getByTestId('op-recheck')).toHaveCount(0);
  await page.getByTestId('detail-close').click();
  await looks(onBoard(138), 'busy', 'spin');
  await shot(page, '357-03-checking-blue');
  releaseCheck();
  // the check made at once and the three after it (3 s, 10 s, 30 s apart) all fail: blue until the last one is through
  await expect(onBoard(138).getByTestId('op-notice-text')).toContainText('；这次没能查证：重读这一条失败', { timeout: 75_000 });
  await expect(onBoard(138).getByTestId('op-notice-text')).toContainText('之后每次同步还会再核对');
  await looks(onBoard(138), 'warn', 'warn');
  expect(await bg(onBoard(138))).toBe('rgb(255, 248, 197)');
  expect(checkReads).toBeGreaterThan(0);
  // (the hold above only counted until it was released) the later checks did read again
  expect(env.fake.log.filter((e) => e.operation === 'CavilItemRefresh' && e.variables?.number === 138).length).toBeGreaterThan(2);
  await expect(onBoard(138).getByTestId('op-recheck')).toHaveCount(0);
  await expect(onBoard(138).getByTestId('op-unlock')).toBeVisible();
  await shot(page, '357-04-check-could-not-read-yellow');
  // GitHub answers now, and the close has landed: the next round checks by itself and proves it (and catches up
  // the re-read that failed earlier); then it is a plain success
  env.fake.state.w.failRefresh.delete(KEY(138));
  late.land();
  await page.getByTestId('refresh').click();
  await expect(onBoard(138).getByTestId('op-notice-text')).toHaveText('issue #138 已关闭（已完成）', { timeout: 15_000 });
  await looks(onBoard(138), 'ok', 'check');
  expect(env.fake.writes().filter((w) => w.method === 'PATCH' && w.path === '/api/repos/GigleAI/cavil-loop/issues/138')).toHaveLength(1);
  // the pointer was on it for the click: away, then the 5 s start over
  await page.mouse.move(5, 5);
  await expect(onBoard(138)).toHaveAttribute('data-auto-dismiss', 'counting');
  await ff(5_200);
  await expect(onBoard(138)).toHaveCount(0);
  await page.getByTestId('search').fill('');

  // ---- 3. a new issue its board refused: never retried (yellow) → "再试加入看板" on its way (blue, no button to click twice) → refused again (red, why) → on its way again (blue, the reason gone) → joined (gone) ----
  env.fake.state.w.readOnlyProjects.add('org/gigleai/11');
  await page.getByTestId('write-entry').click();
  await expect(page.getByTestId('new-issue-project')).toBeChecked();
  await page.getByTestId('new-issue-title').fill('RETRY_357');
  await page.getByTestId('confirm-ok').click();
  const bar = page.locator('[data-testid="create-bar"][data-status="partial"]');
  await expect(bar).toContainText('没能加入看板', { timeout: 15_000 });
  // the new issue opened in the detail: put it away
  await page.getByTestId('detail-close').click();
  await looks(bar, 'warn', 'warn');
  const joins = () => env.fake.log.filter((e) => e.operation === 'CavilAddProjectItem').length;
  const j0 = joins();
  const releaseJoin = holdFirst((e) => e.operation === 'CavilAddProjectItem');
  await bar.getByTestId('create-retry-projects').click();
  await expect(bar.getByTestId('create-retrying')).toBeVisible();
  await expect(bar.getByTestId('create-retry-projects')).toHaveCount(0);
  await looks(bar, 'busy', 'spin');
  await expect.poll(joins).toBe(j0 + 1);
  await shot(page, '357-05-retry-blue');
  await schemeSettled(page, 'dark', 'retry running');
  await shot(page, '357-05-retry-blue-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  releaseJoin();
  await expect(bar.getByTestId('create-retry-error')).toContainText('cavil project', { timeout: 15_000 });
  await looks(bar, 'error', 'warn');
  await shot(page, '357-06-retry-failed-red');
  await schemeSettled(page, 'dark', 'retry failed');
  await shot(page, '357-06-retry-failed-red-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  // once more, the board takes it now
  env.fake.state.w.readOnlyProjects.delete('org/gigleai/11');
  const releaseJoin2 = holdFirst((e) => e.operation === 'CavilAddProjectItem');
  await bar.getByTestId('create-retry-projects').click();
  await expect(bar.getByTestId('create-retrying')).toBeVisible();
  await expect(bar.getByTestId('create-retry-error')).toHaveCount(0);
  await looks(bar, 'busy', 'spin');
  releaseJoin2();
  await expect(page.getByTestId('create-bar')).toHaveCount(0, { timeout: 15_000 });
  expect(joins()).toBe(j0 + 2);

  // ---- 4. the green of a result bar, in both schemes: readable, and green in dark too ----
  // (GitHub#488: a field change no longer says anything above the board — a comment answered after its panel
  // was put away still does)
  await page.getByTestId('search').fill('#137');
  await card(page, 137).click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', KEY(137));
  const holdReply = env.fake.holdWhen((e) => e.method === 'POST' && e.path.endsWith('/issues/137/comments'));
  await page.getByTestId('reply-input').fill('看过了 357');
  await page.getByTestId('reply-send').click();
  await expect.poll(() => env.fake.log.some((l) => l.method === 'POST' && l.path.endsWith('/issues/137/comments'))).toBe(true);
  await page.getByTestId('detail-close').click();
  holdReply();
  // GitHub#489: in the window's notice area
  const result = page.locator('[data-testid="notice-area"] [data-testid="send-notice"]').first();
  await expect(result).toHaveAttribute('data-kind', 'ok', { timeout: 15_000 });
  await expect(result).toHaveClass(/\bok\b/);
  expect(await mark(result)).toBe('check');
  await page.mouse.move(5, 5);
  // (the pointer rests on the bar while it is looked at, so it does not go meanwhile)
  await result.hover();
  for (const scheme of ['light', 'dark'] as const) {
    await schemeSettled(page, scheme, 'green result bar');
    const r = await lowContrast(page);
    expect(r.bad, `green result bar (${scheme})`).toEqual([]);
    expect(await bg(result)).toBe(scheme === 'light' ? 'rgb(218, 251, 225)' : 'rgb(18, 38, 30)');
    await shot(page, `357-07-result-green-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.mouse.move(5, 5);
  await ff(5_200);
  await expect(result).toHaveCount(0);
  await app.close();
});

test('GitHub#372 / #442: ⌘⇧1/2/3 (⌘1/2/3 before GitHub#442) switch the layout and ⌘N opens a new issue from anywhere — a C typed into a field stays a letter; the dialog starts in the title; an iteration and a milestone picked there land on GitHub, and a draft given back keeps them', async () => {
  const PROJECT_KEY = 'project:org/gigleai/11';
  const NEXT = '3d96a307'; // Iteration 27: 2026-11-16 … 11-22 in the recorded board
  env.fake.state.w.milestones.set('gigleai/cavil-loop', [
    { number: 5, title: 'v1.2', state: 'open', due_on: null },
    { number: 4, title: 'v0.9', state: 'closed', due_on: null },
  ]);
  const { app, page } = await launch(env);
  // a day inside Iteration 26: 25 is over, 27 not started yet
  await page.clock.setFixedTime(new Date(2026, 10, 11, 12, 0, 0));
  await page.reload();
  await page.waitForSelector('[data-testid="app-root"]');
  await signInWithSources(page);
  await blur(page);
  const dialog = page.getByTestId('confirm-dialog');
  const search = page.getByTestId('search');
  const title = page.getByTestId('new-issue-title');
  const layoutNow = () => page.locator('[data-testid="layout"] button.on').getAttribute('data-value');

  // ---- 1. ⌘⇧2 / ⌘⇧3 / ⌘⇧1 (GitHub#442): the layout buttons' own action; the buttons say their keys ----
  await page.keyboard.press(`${MOD}+Shift+2`);
  await expect(page.getByTestId('table')).toBeVisible();
  await page.keyboard.press(`${MOD}+Shift+3`);
  await expect(page.getByTestId('graph')).toBeVisible();
  await page.keyboard.press(`${MOD}+Shift+1`);
  await expect(page.getByTestId('board')).toBeVisible();
  expect(await layoutNow()).toBe('board');
  await expect(page.locator('[data-testid="layout"] button[data-value="graph"]')).toHaveAttribute('title', /依赖图（(⌃⌘3|Ctrl\+Shift\+3)）/);
  // the shortcut list has the new rows, in the table's order
  await page.keyboard.press('?');
  expect(await page.getByTestId('shortcut-help').getByTestId('shortcut-row').evaluateAll((rows) => rows.slice(0, 8).map((r) => r.getAttribute('data-id')))).toEqual([
    'search', 'newIssue', 'sync', 'settings', 'help', 'viewBoard', 'viewTable', 'viewGraph',
  ]);
  await shot(page, '372-01-shortcut-list');
  await page.keyboard.press('Escape');

  // ---- 2. typing in the search box: "cache" is text (its C opens nothing); ⌘2 and ⌘N still act ----
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await page.keyboard.type('cache');
  await expect(search).toHaveValue('cache');
  await page.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press(`${MOD}+Shift+2`);
  await expect(page.getByTestId('table')).toBeVisible();
  await search.fill('');
  await search.focus();
  await page.keyboard.press(`${MOD}+n`);
  await expect(dialog).toBeVisible();
  // the keyboard starts in the title: typing goes straight there
  await expect(title).toBeFocused();
  await page.keyboard.type('KEYS_372');
  await expect(title).toHaveValue('KEYS_372');
  await expect(search).toHaveValue('');
  // a layer on top takes ⌘1: the layout stays
  await page.keyboard.press(`${MOD}+Shift+1`);
  expect(await layoutNow()).toBe('table');
  await title.fill('');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // ---- 3. the reply box: a C is a letter; ⌘N opens the dialog and the typed reply stays ----
  await page.keyboard.press(`${MOD}+Shift+1`);
  await card(page, 138).click();
  const reply = page.getByTestId('reply-input');
  await reply.click();
  await page.keyboard.type('cc');
  await page.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
  await expect(reply).toHaveValue('cc');
  await page.keyboard.press(`${MOD}+n`);
  await expect(dialog).toBeVisible();
  await expect(title).toBeFocused();
  await page.getByTestId('confirm-cancel').click();
  await expect(reply).toHaveValue('cc');
  await reply.fill('');
  await page.getByTestId('detail-close').click();

  // ---- 4. a settings field: a C is a letter; ⌘N goes back to the board with the dialog; ⌘3 from settings shows the graph ----
  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId('settings')).toBeVisible();
  const sourceInput = page.getByTestId('source-input');
  await sourceInput.click();
  await page.keyboard.type('cache');
  await expect(sourceInput).toHaveValue('cache');
  await page.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.keyboard.press(`${MOD}+n`);
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(title).toBeFocused();
  await page.getByTestId('confirm-cancel').click();
  await page.keyboard.press(`${MOD}+,`);
  await expect(page.getByTestId('settings')).toBeVisible();
  await blur(page);
  await page.keyboard.press(`${MOD}+Shift+3`);
  await expect(page.getByTestId('graph')).toBeVisible();
  await page.keyboard.press(`${MOD}+Shift+1`);
  await expect(page.getByTestId('board')).toBeVisible();

  // ---- 5. the pickers: untouched they show what the plain "新建" gives; only open milestones and current / upcoming iterations ----
  await blur(page);
  await page.keyboard.press(`${MOD}+n`);
  const ms = page.getByTestId('new-issue-milestone');
  const it = page.getByTestId('new-issue-iteration');
  // GitHub#405: the three sit in one fold, shut when the dialog opens: not on the page, their values on its head line
  const fold = page.getByTestId('new-issue-more');
  const toggle = page.getByTestId('new-issue-more-toggle');
  const sumOf = (f: string) => page.getByTestId(`new-issue-more-${f}`);
  /** the text of the option a picker holds — what the shut fold's head line must say */
  const chosenText = (sel: typeof ms) => sel.evaluate((e: HTMLSelectElement) => e.options[e.selectedIndex]?.textContent ?? '');
  await expect(fold).toHaveAttribute('data-open', 'no');
  await expect(ms).toHaveCount(0);
  await expect(it).toHaveCount(0);
  await expect(page.getByTestId('new-issue-label-add')).toHaveCount(0);
  await expect(sumOf('labels')).toHaveText('未选标签');
  await expect(sumOf('milestone')).toHaveText('不设里程碑');
  await expect(sumOf('iteration')).toHaveText('当前迭代（Iteration 26）');
  await expect(toggle).toContainText('标签、里程碑、迭代');
  await shot(page, '405-01-new-issue-shut');
  // no board ticked: no iteration picker, so the line and the title leave the iteration out
  const board = page.locator(`[data-testid="new-issue-project"][data-project="${PROJECT_KEY}"]`);
  await board.uncheck();
  await expect(sumOf('iteration')).toHaveCount(0);
  await expect(toggle).toContainText('标签、里程碑');
  await expect(toggle).not.toContainText('迭代');
  await board.check();
  await expect(sumOf('iteration')).toHaveText('当前迭代（Iteration 26）');
  // the keyboard opens it: Tab lands on the head, Enter opens; the three come in the order labels → milestone → iteration
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(fold).toHaveAttribute('data-open', 'yes');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const order = await fold.locator('[data-testid="new-issue-labels"], [data-testid="new-issue-milestone"], [data-testid="new-issue-iteration"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(order).toEqual(['new-issue-labels', 'new-issue-milestone', 'new-issue-iteration']);
  expect(await chosenText(it)).toBe('当前迭代（Iteration 26）');
  await expect(ms).toBeEnabled();
  await expect(ms).toHaveValue('');
  expect(await ms.locator('option').evaluateAll((o) => o.map((x) => x.textContent))).toEqual(['不设里程碑', 'v1.2']);
  await expect(it).toHaveValue('auto');
  expect(await it.locator('option').evaluateAll((o) => o.map((x) => x.textContent))).toEqual(['当前迭代（Iteration 26）', '不设迭代', 'Iteration 26（2026-11-09 起）（当前）', 'Iteration 27（2026-11-16 起）']);
  await title.fill('选了迭代和里程碑');
  await ms.selectOption('v1.2');
  await it.selectOption({ label: 'Iteration 27（2026-11-16 起）' });
  await shot(page, '372-02-new-issue-picked');
  await shot(page, '405-02-new-issue-open');
  const itPicked = await chosenText(it);
  expect(itPicked).toBe('Iteration 27（2026-11-16 起）');
  // shut again (Space on the head): the head line says what the pickers held; created shut, the picks still go
  await toggle.focus();
  await page.keyboard.press(' ');
  await expect(fold).toHaveAttribute('data-open', 'no');
  await expect(it).toHaveCount(0);
  await expect(sumOf('milestone')).toHaveText('v1.2');
  await expect(sumOf('iteration')).toHaveText(itPicked);
  await shot(page, '405-03-new-issue-picked-shut');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(sumOf('iteration')).toHaveText(itPicked);
  await shot(page, '405-04-new-issue-picked-shut-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  const before = writes().length;
  await page.getByTestId('confirm-ok').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => writes().slice(before).map((w) => w[0])).toEqual(['POST', 'CavilAddProjectItem', 'CavilSetIteration']);
  expect(writes().slice(before)[0][2]).toEqual({ title: '选了迭代和里程碑', body: '', labels: [], milestone: 5 });
  expect((writes().slice(before)[2][2] as any).iterationId).toBe(NEXT);
  await page.getByTestId('detail-close').click();

  // ---- 6. "不设迭代": joined, no iteration written ----
  await page.getByTestId('write-entry').click();
  await expect(title).toBeFocused();
  await title.fill('不设迭代');
  // a new dialog: shut again, the picks of the last one gone
  await expect(sumOf('iteration')).toHaveText('当前迭代（Iteration 26）');
  await openMoreFields(page);
  await it.selectOption('none');
  expect(await chosenText(it)).toBe('不设迭代');
  await toggle.click();
  await expect(sumOf('iteration')).toHaveText('不设迭代');
  const before2 = writes().length;
  await page.getByTestId('confirm-ok').click();
  await expect.poll(() => writes().slice(before2).map((w) => w[0])).toEqual(['POST', 'CavilAddProjectItem']);
  await page.waitForTimeout(500);
  expect(writes().slice(before2).map((w) => w[0])).toEqual(['POST', 'CavilAddProjectItem']);
  expect(writes().slice(before2)[0][2]).toEqual({ title: '不设迭代', body: '', labels: [] });
  await page.getByTestId('detail-close').click();

  // ---- 7. the milestone list cannot be read: the picker is off, a plain issue is still created ----
  env.fake.state.w.failMilestones.add('gigleai/cavil-loop');
  await page.getByTestId('write-entry').click();
  // shut: the head line says so, in red
  await expect(sumOf('milestone')).toHaveText('里程碑读取失败');
  await expect(sumOf('milestone')).toHaveClass(/err/);
  await openMoreFields(page);
  await expect(ms).toHaveAttribute('data-read', 'error');
  await expect(ms).toBeDisabled();
  await title.fill('读不到里程碑也能建');
  await expect(page.getByTestId('confirm-ok')).toBeEnabled();
  const before3 = writes().length;
  await page.getByTestId('confirm-ok').click();
  await expect.poll(() => writes().slice(before3)[0]?.[2]).toEqual({ title: '读不到里程碑也能建', body: '', labels: [] });
  await page.getByTestId('detail-close').click();
  env.fake.state.w.failMilestones.delete('gigleai/cavil-loop');

  // ---- 8. refused for sure: the draft comes back with the title focused (caret at its end) and both picks kept ----
  env.fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
  await page.getByTestId('write-entry').click();
  await title.fill('REFUSED_372');
  await openMoreFields(page);
  await ms.selectOption('v1.2');
  await it.selectOption({ label: 'Iteration 27（2026-11-16 起）' });
  await page.getByTestId('confirm-ok').click();
  const refused = page.locator('[data-testid="create-bar"][data-status="failed"]');
  await expect(refused).toContainText('没能新建「REFUSED_372」');
  await refused.getByTestId('create-reopen').click();
  await expect(title).toHaveValue('REFUSED_372');
  await expect(title).toBeFocused();
  expect(await title.evaluate((e: HTMLInputElement) => [e.selectionStart, e.selectionEnd])).toEqual([11, 11]);
  // the draft comes back shut, its picks on the head line
  await expect(fold).toHaveAttribute('data-open', 'no');
  await expect(sumOf('milestone')).toHaveText('v1.2');
  await expect(sumOf('iteration')).toHaveText('Iteration 27（2026-11-16 起）');
  await openMoreFields(page);
  await expect(ms).toHaveValue('v1.2');
  await expect(it).toHaveValue(/Iteration 27/);
  await expect(page.locator(`[data-testid="new-issue-project"][data-project="${PROJECT_KEY}"]`)).toBeChecked();
  await app.close();
});

// ---- GitHub#405 (PR #410 review round 1): the shut fold's head line never draws one part over another ----
test('GitHub#405 (PR #410 review round 1): many / long labels, a long milestone, an unreadable list — the shut fold\'s head line wraps; no two parts overlap, none leaves the dialog, at full and narrow width', async () => {
  const REPO_KEY = 'gigleai/cavil-loop';
  const LONG = 'needs-design-review-before-anything-else-happens';
  const names = ['priority/p1', 'pending/human', LONG, 'bug', 'client'];
  env.fake.state.w.repoLabels.set(REPO_KEY, [...names, 'autopilot', 'pending/agent'].map((name, i) => ({ name, color: ['d73a4a', 'fbca04', '0e8a16', '1d76db', '5319e7', 'ededed', 'c5def5'][i] })));
  env.fake.state.w.milestones.set(REPO_KEY, [{ number: 7, title: '2026 年第四季度客户端正式版本（带完整的发布说明和下载页）', state: 'open', due_on: null }]);
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const toggle = page.getByTestId('new-issue-more-toggle');
  const sumOf = (f: string) => page.getByTestId(`new-issue-more-${f}`);

  /** every part of the head line: its box; none overlaps another, all inside the head button */
  const assertNoOverlap = async (what: string) => {
    const boxes = await page.evaluate(() => {
      const head = document.querySelector('[data-testid="new-issue-more-toggle"]')!;
      const sel = '.more-title, [data-testid="new-issue-more-label"], [data-testid="new-issue-more-extra"], [data-testid="new-issue-more-labels"], [data-testid="new-issue-more-milestone"], [data-testid="new-issue-more-iteration"]';
      const r = (e: Element) => {
        // a text part that broke onto two lines: each line box on its own
        const rects = [...e.getClientRects()];
        return rects.map((b) => ({ l: b.left, r: b.right, t: b.top, b: b.bottom }));
      };
      const h = head.getBoundingClientRect();
      return { head: { l: h.left, r: h.right, t: h.top, b: h.bottom }, parts: [...head.querySelectorAll(sel)].map((e) => ({ id: e.getAttribute('data-testid') ?? e.className, label: e.getAttribute('data-label'), rects: r(e) })) };
    });
    expect(boxes.parts.length, what).toBeGreaterThan(2);
    const flat = boxes.parts.flatMap((p) => p.rects.map((b) => ({ ...b, who: `${p.id}${p.label ? `:${p.label}` : ''}` })));
    for (const b of flat) {
      expect(b.l, `${what}: ${b.who} starts inside the head`).toBeGreaterThanOrEqual(boxes.head.l - 0.5);
      expect(b.r, `${what}: ${b.who} ends inside the head`).toBeLessThanOrEqual(boxes.head.r + 0.5);
      expect(b.b, `${what}: ${b.who} inside the head (height)`).toBeLessThanOrEqual(boxes.head.b + 0.5);
    }
    for (let i = 0; i < flat.length; i++)
      for (let j = i + 1; j < flat.length; j++) {
        const a = flat[i];
        const b = flat[j];
        if (a.who === b.who) continue;
        const overlap = Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5;
        expect(overlap, `${what}: ${a.who} and ${b.who} overlap`).toBe(false);
      }
  };

  await page.getByTestId('write-entry').click();
  await page.getByTestId('new-issue-title').fill('很多标签');
  await openMoreFields(page);
  await page.getByTestId('new-issue-milestone').selectOption({ index: 1 });
  await page.getByTestId('new-issue-label-add').click();
  for (const n of names) await page.locator(`[data-testid="new-issue-label-picker"] [data-testid="picker-item"][data-name="${n}"]`).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-issue-label-chip')).toHaveCount(5);
  await toggle.click();
  // the first three named, then "+2"; the cut long name keeps its full name on hover
  expect(await page.getByTestId('new-issue-more-label').evaluateAll((els) => els.map((e) => e.getAttribute('data-label')))).toEqual(names.slice(0, 3));
  await expect(page.getByTestId('new-issue-more-extra')).toHaveText('+2');
  await expect(page.getByTestId('new-issue-more-extra')).toHaveAttribute('title', 'bug、client');
  await expect(page.locator(`[data-testid="new-issue-more-label"][data-label="${LONG}"]`)).toHaveAttribute('title', LONG);
  await expect(sumOf('milestone')).toHaveText('2026 年第四季度客户端正式版本（带完整的发布说明和下载页）');
  await expect(sumOf('iteration')).toBeVisible();
  await assertNoOverlap('1280 wide');
  await shot(page, '405-05-many-labels-shut');
  // a narrow window: the dialog shrinks with it, the line wraps further
  await page.setViewportSize({ width: 560, height: 800 });
  await assertNoOverlap('560 wide');
  await shot(page, '405-06-many-labels-shut-narrow');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId('confirm-cancel').click();
  if (await page.getByTestId('dialog-esc-hint').count()) await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

  // the lists cannot be read: the red words are on the line, readable, overlapping nothing
  env.fake.state.w.failLabels.add(REPO_KEY);
  env.fake.state.w.failMilestones.add(REPO_KEY);
  await page.getByTestId('write-entry').click();
  await expect(sumOf('labels')).toHaveText('标签读取失败');
  await expect(sumOf('milestone')).toHaveText('里程碑读取失败');
  await expect(sumOf('labels')).toBeVisible();
  await expect(sumOf('milestone')).toBeVisible();
  await assertNoOverlap('unreadable, 1280 wide');
  await page.setViewportSize({ width: 560, height: 800 });
  await assertNoOverlap('unreadable, 560 wide');
  await page.setViewportSize({ width: 1280, height: 800 });
  env.fake.state.w.failLabels.delete(REPO_KEY);
  env.fake.state.w.failMilestones.delete(REPO_KEY);
  await app.close();
});

// ---- GitHub#381: code blocks in the discussion — copy, wrap long lines, syntax colours ----
const CODE381 = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'codeblocks.github.json'), 'utf8')) as {
  samples: Record<string, { markdown: string; html: string }>;
  comments: { url: string; body: string; bodyHTML: string }[];
};
/** what the author typed between the fences of a one-block sample: the text "copy" must put on the clipboard */
const fenced381 = (name: string) => CODE381.samples[name].markdown.replace(/^```[a-z]*\n/, '').replace(/\n```\n$/, '');

/** the cases about the end of a block, in the order they are shown */
const EDGE381 = [
  'with a language, a blank line before the closing fence',
  'with a language, no blank line at the end',
  'no language, a blank line before the closing fence',
  'no language, no blank line at the end',
  'raw <pre> ending in a line break',
  'raw <pre> ending in two line breaks',
];
/**
 * The sample comment on PR #386, block by block: what was typed, and what "copy" must give — the same as
 * GitHub's own copy button on that block.
 */
const GH381: [string, string][] = [
  ['```bash + a blank line before the closing fence', 'echo one\n'],
  ['```bash, no blank line', 'echo one'],
  ['``` (no language) + a blank line before the closing fence', 'echo one\n'],
  ['``` (no language), no blank line', 'echo one'],
  ['hand-written <pre> ending in a line break', 'raw one\nraw two\n'],
  ['hand-written <pre> ending in two line breaks', 'raw one\n\n'],
  ['hand-written <pre><code> ending in a line break (GitHub renders it exactly as block 4)', 'echo one'],
  ['hand-written <pre><code>, no line break at the end', 'echo one'],
  ['hand-written wrapper with a copy text of its own (GitHub drops it and writes the real one)', 'shown text'],
];

/** code blocks on screen: 2 in the real comment, 3 in C_CODE, the nine endings, the two odd ones, the six without a copy text */
const BLOCKS381 = 2 + 3 + GH381.length + 2 + EDGE381.length;

test('GitHub#381: code blocks — "复制" puts the block\'s exact text on the clipboard and says so (or says it failed); "换行" folds long lines everywhere and is remembered; GitHub\'s syntax marks are coloured, light and dark, in the discussion and the reply preview', async () => {
  const w = env.fake.state.w;
  const url = (id: string) => `https://github.com/GigleAI/cavil-loop/issues/138#${id}`;
  const TS = 'typescript: indentation, <, > and &';
  const SH = 'shell with a language, a long line';
  const PLAIN = 'no language';
  w.comments.set('gigleai/cavil-loop#138', [
    // a real comment as GitHub rendered it: a shell block, a block without a language, inline code, task boxes
    { id: 'C_REAL', url: url('C_REAL'), createdAt: '2026-11-02T01:00:00Z', bodyHTML: CODE381.comments[0].bodyHTML, author: { login: 'user-2' } },
    { id: 'C_GH', url: url('C_GH'), createdAt: '2026-11-01T02:00:00Z', bodyHTML: CODE381.comments[1].bodyHTML, author: { login: 'user-5' } },
    // not GitHub's: a copy text that is not the shown text, and one that is two line breaks short of it
    { id: 'C_ODD', url: url('C_ODD'), createdAt: '2026-11-01T03:00:00Z', bodyHTML: '<div data-snippet-clipboard-copy-content="rm -rf /"><pre><code>ls\n</code></pre></div><div data-snippet-clipboard-copy-content="ls"><pre><code>ls\n\n</code></pre></div>', author: { login: 'user-5' } },
    { id: 'C_EDGE', url: url('C_EDGE'), createdAt: '2026-11-01T01:00:00Z', bodyHTML: EDGE381.map((n) => CODE381.samples[n].html).join('\n'), author: { login: 'user-4' } },
    { id: 'C_CODE', url: url('C_CODE'), createdAt: '2026-11-03T01:00:00Z', bodyHTML: `<p>run <code class="notranslate">npm test</code></p>${CODE381.samples[SH].html}${CODE381.samples[TS].html}${CODE381.samples[PLAIN].html}`, author: { login: 'user-3' } },
  ]);
  let { app, page } = await launch(env);
  await signInWithSources(page);
  // the app is started three times here: everything is looked up on the window that is open now
  let iframe = page.getByTestId('timeline-frame');
  let frame = page.frameLocator('[data-testid="timeline-frame"]');
  let blocks = frame.locator('details.entry[data-entry="C_CODE"] .cb');
  let [sh, ts, plain] = [blocks.nth(0), blocks.nth(1), blocks.nth(2)];
  const open = async () => {
    iframe = page.getByTestId('timeline-frame');
    frame = page.frameLocator('[data-testid="timeline-frame"]');
    blocks = frame.locator('details.entry[data-entry="C_CODE"] .cb');
    [sh, ts, plain] = [blocks.nth(0), blocks.nth(1), blocks.nth(2)];
    await card(page, 138).click();
    await expect(iframe).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
    await page.getByTestId('unfold-toggle').click();
    await expect(iframe).toHaveAttribute('data-ready', 'yes');
    await expect(frame.locator('details.entry[data-entry="C_CODE"] .cb').first()).toBeVisible();

  };
  await open();
  const copyBtn = (b: Locator) => b.locator('button[data-code-copy]');
  const wrapBtn = (b: Locator) => b.locator('button[data-code-wrap]');
  /** what the clipboard really holds: pasted into the reply box with the keyboard, read back, box emptied again */
  const pasted = async () => {
    const box = page.getByTestId('reply-input');
    await box.fill('');
    await box.focus();
    await page.keyboard.press('ControlOrMeta+V');
    const v = await box.inputValue();
    await box.fill('');
    return v;
  };

  // ---- 1. every block has the two buttons, inline code has none; they show on hover / keyboard focus ----
  await expect(blocks).toHaveCount(3);
  await expect(frame.locator('details.entry[data-entry="C_REAL"] .cb')).toHaveCount(2);
  await expect(frame.locator('button[data-code-copy]')).toHaveCount(BLOCKS381);
  await expect(frame.locator('button[data-code-wrap]')).toHaveCount(BLOCKS381);
  expect(await frame.locator('code').evaluateAll((cs) => cs.filter((c) => !c.closest('pre') && c.closest('.cb')).length)).toBe(0);
  const barOpacity = (b: Locator) => b.locator('.cbar').evaluate((e) => getComputedStyle(e).opacity);
  await page.getByTestId('reply-input').hover();
  expect(await barOpacity(ts)).toBe('0');
  await ts.locator('pre').hover();
  expect(await barOpacity(ts)).toBe('1');
  expect(await barOpacity(plain)).toBe('0');
  await page.getByTestId('reply-input').hover();
  await copyBtn(plain).focus();
  expect(await barOpacity(plain)).toBe('1');
  // the task boxes of the real comment are still there and numbered
  await expect(frame.locator('details.entry[data-entry="C_REAL"] input[data-task]')).toHaveCount(2);
  await ts.locator('pre').hover();
  await shot(page, '381-code-buttons');

  // ---- 2. copy: the clipboard holds the block's text, character for character — line breaks, a tab, <, > and & ----
  expect(fenced381(TS)).toContain('\n\treturn');
  expect(fenced381(TS)).toContain('a > b && c');
  await copyBtn(ts).click();
  await expect(copyBtn(ts)).toHaveText('已复制 ✓');
  await expect(copyBtn(ts)).toHaveAttribute('data-state', 'ok');
  expect(await pasted()).toBe(fenced381(TS));
  await shot(page, '381-code-copied');
  // a block without a language: indentation, the blank line in it
  await plain.locator('pre').hover();
  await copyBtn(plain).click();
  await expect(copyBtn(plain)).toHaveText('已复制 ✓');
  // (this rendering is from GitHub's markdown endpoint, which gives no copy text: the line break at its end stays)
  expect(await pasted()).toBe(`${fenced381(PLAIN)}\n`);
  expect(fenced381(PLAIN)).toContain('    indented    columns\n\nlast line');
  // the long line, whole
  await sh.locator('pre').hover();
  await copyBtn(sh).click();
  await expect(copyBtn(sh)).toHaveText('已复制 ✓');
  const long = await pasted();
  expect(long).toBe(fenced381(SH));
  expect(long.split('\n')[2].length).toBeGreaterThan(300);
  // the button goes back by itself, nothing is left selected, and nothing was reported to the window or sent to GitHub
  await expect(copyBtn(ts)).toHaveText('复制', { timeout: 5000 });
  await expect(copyBtn(ts)).not.toHaveAttribute('data-state');
  expect(await frame.locator('body').evaluate(() => String(getSelection()))).toBe('');
  expect(env.fake.writes()).toEqual([]);

  // ---- 2b. the end of a block (PR #386 review rounds 1 and 2): what is copied is what GitHub's own copy button
  // copies. The nine blocks are one real comment as the discussion gets it (GitHub's copy text around each block) ----
  const gh = frame.locator('details.entry[data-entry="C_GH"] .cb');
  await expect(gh).toHaveCount(GH381.length);
  const copyAll = async (blocks: Locator, n: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      await blocks.nth(i).locator('pre').hover();
      await copyBtn(blocks.nth(i)).click();
      await expect(copyBtn(blocks.nth(i))).toHaveText('已复制 ✓');
      out.push(await pasted());
    }
    return out;
  };
  expect(await copyAll(gh, GH381.length)).toEqual(GH381.map(([, text]) => text));
  // 4 and 7 — a fence without a language, and a hand-written <pre><code> ending in a line break — are the same
  // HTML from GitHub, byte for byte: no rule can copy them differently, and GitHub's own button does not either
  const ghHtml = await gh.evaluateAll((bs) => bs.map((b) => b.parentElement!.outerHTML));
  expect(ghHtml[6]).toBe(ghHtml[3]);
  expect(ghHtml[3]).toContain('data-snippet-clipboard-copy-content="echo one"');
  // GitHub gave no copy text (its markdown endpoint gives none; a hand-written <pre> never has one): everything
  // the block shows is copied, nothing is taken off its end
  const edge = frame.locator('details.entry[data-entry="C_EDGE"] .cb');
  await expect(edge).toHaveCount(EDGE381.length);
  expect(await edge.evaluateAll((bs) => bs.filter((b) => b.parentElement!.hasAttribute('data-snippet-clipboard-copy-content')).length)).toBe(0);
  expect(await copyAll(edge, EDGE381.length)).toEqual(['echo one\n', 'echo one', 'echo one\n\n', 'echo one\n', 'raw one\nraw two\n', 'raw one\n\n']);
  // a copy text that differs from what is shown by more than the last line break is not GitHub's (it strips the
  // attribute from what people write — block 9 above): what is shown is copied
  const odd = frame.locator('details.entry[data-entry="C_ODD"] .cb');
  expect(await copyAll(odd, 2)).toEqual(['ls\n', 'ls\n\n']);

  // ---- 3. the clipboard refuses both ways: the button says so, the clipboard keeps what it had, the block stays selected ----
  await frame.locator('body').evaluate(() => {
    (window as any).__exec = document.execCommand;
    document.execCommand = (() => false) as any;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
  });
  await ts.locator('pre').hover();
  await copyBtn(ts).click();
  await expect(copyBtn(ts)).toHaveText('复制失败');
  await expect(copyBtn(ts)).toHaveAttribute('data-state', 'fail');
  expect((await frame.locator('body').evaluate(() => String(getSelection()))).trim()).toBe(fenced381(TS).trim());
  // still the last thing that was copied
  expect(await pasted()).toBe('ls\n\n');
  await shot(page, '381-code-copy-failed');
  // "select + copy" refused, the clipboard API takes it: copied
  await frame.locator('body').evaluate(() => {
    (window as any).__api = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t: string) => ((window as any).__api.push(t), Promise.resolve()) } });
  });
  await copyBtn(plain).click();
  await expect(copyBtn(plain)).toHaveText('已复制 ✓');
  expect(await frame.locator('body').evaluate(() => (window as any).__api)).toEqual([`${fenced381(PLAIN)}\n`]);
  await frame.locator('body').evaluate(() => {
    document.execCommand = (window as any).__exec;
  });

  // ---- 4. wrap: off at first (the long line scrolls sideways); one click folds every block, without drawing the frame again ----
  const overflow = (b: Locator) => b.locator('pre').evaluate((p) => [p.scrollWidth > p.clientWidth, getComputedStyle(p).whiteSpace] as const);
  const wrapped = () => frame.locator('body').evaluate((b) => b.hasAttribute('data-wrap'));
  expect(await wrapped()).toBe(false);
  expect(await overflow(sh)).toEqual([true, 'pre']);
  await expect(wrapBtn(sh)).toHaveAttribute('aria-pressed', 'false');
  const render = await iframe.getAttribute('data-render');
  await sh.locator('pre').hover();
  await wrapBtn(sh).click();
  expect(await wrapped()).toBe(true);
  expect(await overflow(sh)).toEqual([false, 'pre-wrap']);
  // every block, also in the other entry; every switch says "on"
  expect(await frame.locator('pre').evaluateAll((ps) => ps.map((p) => getComputedStyle(p).whiteSpace))).toEqual(Array(BLOCKS381).fill('pre-wrap'));
  expect(await frame.locator('button[data-code-wrap]').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-pressed')))).toEqual(Array(BLOCKS381).fill('true'));
  expect(await iframe.getAttribute('data-render')).toBe(render);
  // folded lines still copy as the one line they are
  await copyBtn(sh).click();
  await expect(copyBtn(sh)).toHaveText('已复制 ✓');
  expect(await pasted()).toBe(fenced381(SH));
  await sh.locator('pre').hover();
  await shot(page, '381-code-wrapped');
  // a new drawing of the frame keeps it
  await page.getByTestId('unfold-toggle').click();
  await expect(iframe).not.toHaveAttribute('data-render', render!);
  await expect(iframe).toHaveAttribute('data-ready', 'yes');
  expect(await wrapped()).toBe(true);
  await page.getByTestId('unfold-toggle').click();
  await expect(iframe).toHaveAttribute('data-ready', 'yes');
  expect(await overflow(sh)).toEqual([false, 'pre-wrap']);

  // ---- 5. remembered: the app closed and started again, another opening of the item ----
  await app.close();
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await open();
  expect(await wrapped()).toBe(true);
  expect(await overflow(sh)).toEqual([false, 'pre-wrap']);
  await expect(wrapBtn(ts)).toHaveAttribute('aria-pressed', 'true');
  // and off again, from any block
  await ts.locator('pre').hover();
  await wrapBtn(ts).click();
  expect(await wrapped()).toBe(false);
  expect(await overflow(sh)).toEqual([true, 'pre']);
  await app.close();
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await open();
  expect(await wrapped()).toBe(false);

  // ---- 6. syntax colours: GitHub's marks, light and dark; a block without a language stays in the text colour ----
  const colour = (l: Locator) => l.first().evaluate((e) => getComputedStyle(e).color);
  const seen = async () => ({
    keyword: await colour(ts.locator('.pl-k')),
    comment: await colour(ts.locator('.pl-c')),
    string: await colour(sh.locator('.pl-s')),
    plain: await colour(plain.locator('code')),
    text: await colour(frame.locator('body')),
  });
  await page.emulateMedia({ colorScheme: 'light' });
  // a change of theme draws the frame again: wait for the new drawing before reading colours from it
  await expect.poll(() => colour(ts.locator('.pl-k')).catch(() => '')).toBe('rgb(207, 34, 46)');
  await expect(iframe).toHaveAttribute('data-ready', 'yes');
  const light = await seen();
  expect(light).toMatchObject({ keyword: 'rgb(207, 34, 46)', comment: 'rgb(89, 99, 110)', string: 'rgb(10, 48, 105)' });
  expect(light.plain).toBe(light.text);
  await ts.locator('pre').hover();
  await shot(page, '381-code-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => colour(ts.locator('.pl-k')).catch(() => '')).toBe('rgb(255, 123, 114)');
  await expect(iframe).toHaveAttribute('data-ready', 'yes');
  const dark = await seen();
  expect(dark).toMatchObject({ keyword: 'rgb(255, 123, 114)', comment: 'rgb(145, 152, 161)', string: 'rgb(165, 214, 255)' });
  expect(dark.plain).toBe(dark.text);
  await ts.locator('pre').hover();
  await shot(page, '381-code-dark');

  // ---- 7. the reply preview: the same colours for the same marks, no buttons, nothing runs ----
  w.markdownHtml = CODE381.samples[TS].html;
  await page.getByTestId('reply-input').fill(CODE381.samples[TS].markdown);
  await page.getByTestId('reply-preview-toggle').click();
  const preview = page.frameLocator('[data-testid="reply-preview"]');
  await expect(preview.locator('pre')).toBeVisible();
  expect(await colour(preview.locator('.pl-k'))).toBe(dark.keyword);
  expect(await colour(preview.locator('.pl-c'))).toBe(dark.comment);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => colour(preview.locator('.pl-k'))).toBe(light.keyword);
  expect(await colour(preview.locator('.pl-c'))).toBe(light.comment);
  await expect(preview.locator('button')).toHaveCount(0);
  await expect(preview.locator('script')).toHaveCount(0);
  expect(await page.getByTestId('reply-preview').getAttribute('sandbox')).not.toContain('allow-scripts');
  await shot(page, '381-code-preview');
  w.markdownHtml = null;
  await app.close();
});


test('GitHub#395: release attachment images are fetched with the sign-in and shown; a refusal, a rate limit and an ordinary image that did not load each get a box with "重新加载"', async () => {
  const { fake } = env;
  const w = fake.state.w;
  const PICTURE = readFileSync(join(root, 'build', 'icon.png'));
  const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  fake.state.releases.set('acme/private-app', [
    {
      tag: 'preview/pr-412',
      assets: [
        { id: 11, name: 'home.png', bytes: PICTURE },
        { id: 12, name: 'map.png', bytes: PICTURE },
      ],
    },
  ]);
  const rel = (file: string, repo = 'acme/private-app') => `${fake.web}/${repo}/releases/download/preview/pr-412/${file}`;
  const linked = (src: string, alt: string) => `<p><a target="_blank" rel="noopener noreferrer" href="${src}"><img src="${src}" alt="${alt}" style="max-width: 100%;"></a></p>`;
  const comment = (broken: string) => ({
    id: 'C_IMG',
    url: 'https://github.com/GigleAI/cavil-loop/issues/138#c-img',
    createdAt: '2026-11-05T01:00:00Z',
    author: { login: 'user-2' },
    bodyHTML:
      '<p>预览已更新，截图如下</p>' +
      linked(rel('home.png'), '首页截图') +
      linked(rel('wrong-book.png', 'acme/other-app'), '错题本截图') +
      linked(rel('map.png'), '知识图谱截图') +
      `<p><img src="${broken}" alt="手机预览码"></p>`,
  });
  w.comments.set('gigleai/cavil-loop#138', [comment('data:image/png;base64,xx')]);
  // the third image's download is rate limited, for 4 seconds
  const limit = (e: { path: string }) => (e.path.includes('/releases/assets/12') ? { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '4' } } : null);
  fake.state.answerOverride = limit;
  const of = (part: string) => fake.log.filter((l) => l.path.includes(part));

  const { app, page } = await launch(env);
  await signInWithSources(page);
  await card(page, 138).click();
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  const box = (alt: string) => frame.locator('.imgbox', { has: frame.locator('.alt', { hasText: alt }) });
  const natural = (alt: string) => frame.locator(`img[alt="${alt}"]`).evaluate((el: HTMLImageElement) => el.naturalWidth);

  // ---- 1. the private repo's attachment is shown; the credential went to the API, the file was fetched without it ----
  await expect(frame.locator('img[alt="首页截图"]')).toBeVisible({ timeout: 15_000 });
  expect(await natural('首页截图')).toBeGreaterThan(100);
  await expect(box('首页截图')).toHaveCount(0);
  // the release's tag holds a slash (`preview/pr-412`), as this repo's own client releases do
  expect(of('/api/repos/acme/private-app/releases/tags/preview/pr-412').map((l) => l.status)).toContain(200);
  expect(of('/api/repos/acme/private-app/releases/assets/11').map((l) => [l.status, Boolean(l.auth)])).toEqual([[302, true]]);
  expect(of('/web/release-assets/11').map((l) => [l.status, l.auth])).toEqual([[200, null]]);
  // the window itself never asked for a release address
  expect(of('/releases/download/')).toEqual([]);

  // ---- 2. a repo this sign-in cannot read: says so, without a word about GitHub Apps (signed in the default way) ----
  await expect(box('错题本截图').locator('.why')).toHaveText('没取到：当前登录读不到这个仓库的发布附件');
  await expect(box('错题本截图').locator('button')).toBeEnabled();

  // ---- 3. rate limited: says until when, nothing about access; the button waits for that time ----
  const limited = box('知识图谱截图');
  await expect(limited.locator('.why')).toHaveText(/^GitHub 限流，\d\d:\d\d 之后可以再试$/);
  await expect(limited.locator('button')).toBeDisabled();
  expect(of('/releases/assets/12').map((l) => l.status)).toEqual([429]);
  // ---- 4. an ordinary image that did not load ----
  await expect(box('手机预览码').locator('.why')).toHaveText('图片没加载出来');
  await box('错题本截图').scrollIntoViewIfNeeded();
  await shot(page, '395-images');

  // the limit is over on GitHub's side at once, but nothing is asked before the time GitHub gave
  fake.state.answerOverride = null;
  await page.waitForTimeout(1500);
  expect(of('/releases/assets/12')).toHaveLength(1);
  await expect(limited.locator('button')).toBeEnabled({ timeout: 10_000 });
  await limited.locator('button').click();
  await expect(frame.locator('img[alt="知识图谱截图"]')).toBeVisible({ timeout: 15_000 });
  expect(await natural('知识图谱截图')).toBeGreaterThan(100);
  expect(of('/web/release-assets/12').map((l) => [l.status, l.auth])).toEqual([[200, null]]);

  // ---- 5. "重新加载" on the ordinary image reads the discussion again; GitHub now gives an address that loads ----
  const reads = () => fake.log.filter((l) => l.operation === 'CavilItemDetail').length;
  const before = reads();
  w.comments.set('gigleai/cavil-loop#138', [comment(TINY)]);
  await box('手机预览码').locator('button').click();
  await expect.poll(reads).toBeGreaterThan(before);
  await expect(frame.locator('img[alt="手机预览码"]')).toBeVisible({ timeout: 15_000 });
  await expect(box('手机预览码')).toHaveCount(0);
  // the images fetched before come back from memory: no second download
  await expect(frame.locator('img[alt="首页截图"]')).toBeVisible();
  expect(of('/web/release-assets/11')).toHaveLength(1);
  expect(of('/web/release-assets/12')).toHaveLength(1);
  await shot(page, '395-images-reloaded');
  expect(fake.writes()).toEqual([]);
  await app.close();
});

// ---- GitHub#398: a repository's GitHub page, one click from where the repository is shown ----

test('GitHub#398: "open this repository on GitHub" on the board\'s swimlane heads, the table\'s repository sections and its repository list — one request with the repository\'s address each; folding, the slice filter and the dragged order stay as they were and still work', async () => {
  const issue = (repo: string, n: number, title: string) => ({ number: n, node_id: `I_fixture_${repo}${n}`, title, state: 'open', html_url: `https://github.com/GigleAI/${repo}/issues/${n}`, updated_at: '2026-11-04T00:00:00Z', labels: [], assignees: [], milestone: null, user: { login: 'user-1' }, parent_issue_url: null, sub_issues_summary: null });
  env.fake.state.repos.set('gigleai/aaa', [issue('aaa', 1, 'alpha')]);
  env.fake.state.repos.set('gigleai/bbb', [issue('bbb', 1, 'beta')]);
  const [A, B] = ['GigleAI/aaa', 'GigleAI/bbb'];

  const { app, page } = await launch(env);
  await signIn(page);
  await page.getByTestId('open-settings').click();
  for (const r of [A, B]) {
    await page.getByTestId('source-input').fill(r);
    await page.getByTestId('source-add').click();
  }
  await page.getByTestId('back').click();
  await page.getByTestId('search').fill('');
  const layout = (l: 'board' | 'table') => page.locator(`[data-testid="layout"] button[data-value="${l}"]`).click();
  /** every address the app asked the system browser to open after sign-in, in order */
  const base = existsSync(env.opened) ? readFileSync(env.opened, 'utf8').split('\n').filter(Boolean).length : 0;
  const opened = () => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8').split('\n').filter(Boolean).slice(base) : []);
  const want: string[] = [];
  const expectOpened = async (url: string) => {
    want.push(url);
    await expect.poll(opened).toEqual(want);
    await page.waitForTimeout(200); // a second request for the same click would have arrived by now
    expect(opened()).toEqual(want);
  };
  const lanes = () => page.$$eval('[data-testid="lane"]', (s) => s.map((x) => x.getAttribute('data-lane')));
  const slices = () => page.$$eval('[data-testid="slice"]', (s) => s.map((x) => x.getAttribute('data-value')).filter((v) => v));
  const savedOrder = () => page.evaluate(async () => (await (window as any).cavil.get()).state.repoOrder as string[]);

  // ---- 1. board: swimlane heads ----
  await layout('board');
  await page.getByTestId('swimlanes').check();
  await expect.poll(lanes, { timeout: 15_000 }).toEqual([A, B]);
  const lane = (r: string) => page.locator(`[data-testid="lane"][data-lane="${r}"]`);
  const laneWeb = (r: string) => lane(r).getByTestId('repo-web');
  await expect(page.locator('[data-testid="lane"] [data-testid="repo-web"]')).toHaveCount(2);
  await expect(laneWeb(A)).toHaveAttribute('title', '在 GitHub 打开这个仓库');
  await expect(laneWeb(A)).toHaveAttribute('aria-label', `在 GitHub 打开这个仓库：${A}`);
  // the link is a button of its own next to the fold button, not inside it
  expect(await laneWeb(A).evaluate((el) => !!el.closest('[data-testid="lane-toggle"]'))).toBe(false);
  await laneWeb(A).click();
  await expectOpened('https://github.com/GigleAI/aaa');
  await expect(lane(A).getByTestId('lane-toggle')).toHaveAttribute('aria-expanded', 'true'); // the click did not fold the lane
  expect(await lanes()).toEqual([A, B]);
  // the keyboard reaches it right after the fold button, and Enter opens the page
  await lane(B).getByTestId('lane-toggle').focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => [document.activeElement?.getAttribute('data-testid'), document.activeElement?.getAttribute('data-repo')])).toEqual(['repo-web', B]);
  await page.keyboard.press('Enter');
  await expectOpened('https://github.com/GigleAI/bbb');
  await expect(lane(B).getByTestId('lane-toggle')).toHaveAttribute('aria-expanded', 'true');
  // folding still works, from the name and from the empty part of the row right of the link; a folded lane keeps its link
  await lane(A).getByTestId('lane-toggle').click();
  await expect(lane(A).getByTestId('lane-toggle')).toHaveAttribute('aria-expanded', 'false');
  await laneWeb(A).click();
  await expectOpened('https://github.com/GigleAI/aaa');
  await expect(lane(A).getByTestId('lane-toggle')).toHaveAttribute('aria-expanded', 'false');
  const row = (await lane(A).getByTestId('lane-head').boundingBox())!;
  await page.mouse.click(row.x + row.width - 40, row.y + row.height / 2);
  await expect(lane(A).getByTestId('lane-toggle')).toHaveAttribute('aria-expanded', 'true');
  expect(opened()).toEqual(want);
  // dragging a lane by its head still reorders (b above a), and the links follow their repositories
  await dragRepo(lane(B).getByTestId('lane-toggle'), lane(A).getByTestId('lane-toggle'));
  await expect.poll(lanes).toEqual([B, A]);
  expect(await savedOrder()).toEqual(['gigleai/bbb', 'gigleai/aaa']);
  await shot(page, '398-01-board-lanes');

  // ---- 2. table: the repository sections ----
  await layout('table');
  await expect.poll(async () => (await repoHeads(page)).map(([t]) => t), { timeout: 15_000 }).toEqual([B, A]);
  const section = (r: string) => page.locator(`[data-testid="repo-group"][data-title="${r}"]`);
  await expect(page.locator('[data-testid="repo-head"] [data-testid="repo-web"]')).toHaveCount(2);
  const rowsShown = () => page.locator('[data-testid="row"]').count();
  const before = await rowsShown();
  expect(before).toBeGreaterThan(0);
  await section(A).getByTestId('repo-web').click();
  await expectOpened('https://github.com/GigleAI/aaa');
  await expect(section(A).getByTestId('repo-toggle')).toHaveAttribute('aria-label', '收起这个仓库'); // still unfolded
  expect(await rowsShown()).toBe(before);
  // the head still folds on a click anywhere else on it
  await section(A).getByTestId('repo-head').click({ position: { x: 600, y: 10 } });
  await expect(section(A).getByTestId('repo-toggle')).toHaveAttribute('aria-label', '展开这个仓库');
  expect(await rowsShown()).toBeLessThan(before);
  await section(A).getByTestId('repo-web').click(); // folded: the link stays and still only opens the page
  await expectOpened('https://github.com/GigleAI/aaa');
  await expect(section(A).getByTestId('repo-toggle')).toHaveAttribute('aria-label', '展开这个仓库');
  await section(A).getByTestId('repo-head').click({ position: { x: 600, y: 10 } });
  await expect(section(A).getByTestId('repo-toggle')).toHaveAttribute('aria-label', '收起这个仓库');

  // ---- 3. table: the repository list on the left ----
  const sliceRow = (r: string) => page.locator('.slice-row', { has: page.locator(`[data-testid="slice"][data-value="${r}"]`) });
  const slice = (r: string) => page.locator(`[data-testid="slice"][data-value="${r}"]`);
  await expect.poll(slices).toEqual([B, A]);
  await expect(page.locator('[data-testid="slices"] [data-testid="repo-web"]')).toHaveCount(2); // "全部" has none
  const shownAt = (r: string) => sliceRow(r).getByTestId('repo-web').evaluate((el) => getComputedStyle(el).opacity);
  await page.mouse.move(700, 400);
  expect(await shownAt(B)).toBe('0'); // not shown until the pointer or the focus is on its row
  await sliceRow(B).hover();
  await expect.poll(() => shownAt(B)).toBe('1');
  expect(await shownAt(A)).toBe('0');
  await sliceRow(B).getByTestId('repo-web').click();
  await expectOpened('https://github.com/GigleAI/bbb');
  await expect(page.locator('[data-testid="slice"][data-value=""]')).toHaveClass(/\bon\b/); // still "all repositories"
  await expect(slice(B)).not.toHaveClass(/\bon\b/);
  // keyboard: Tab from the slice lands on its link, which shows itself; Enter opens the page
  await page.mouse.move(700, 400);
  await slice(A).focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => [document.activeElement?.getAttribute('data-testid'), document.activeElement?.getAttribute('data-repo')])).toEqual(['repo-web', A]);
  expect(await shownAt(A)).toBe('1');
  await page.keyboard.press('Enter');
  await expectOpened('https://github.com/GigleAI/aaa');
  await expect(slice(A)).not.toHaveClass(/\bon\b/);
  await shot(page, '398-02-table');
  // the slice still filters on a click, and its link still works when picked
  await slice(A).click();
  await expect(slice(A)).toHaveClass(/\bon\b/);
  await sliceRow(A).getByTestId('repo-web').click();
  await expectOpened('https://github.com/GigleAI/aaa');
  await expect(slice(A)).toHaveClass(/\bon\b/);
  await page.locator('[data-testid="slice"][data-value=""]').click();
  // dragging in the list still reorders (a back above b)
  await dragRepo(slice(A), slice(B));
  await expect.poll(slices).toEqual([A, B]);
  expect(await savedOrder()).toEqual(['gigleai/aaa', 'gigleai/bbb']);
  expect(opened()).toEqual(want);
  expect(want.length).toBe(8);
  await app.close();
});

// ---- GitHub#413 / #433: 关闭 issue / 交给 agent / 托管 from the keyboard (⌘⇧X / ⌘⇧Z / ⌘⇧C, Ctrl+Shift here). A key
// only presses the button: the same handler behind the same "is it showing, can it be pressed" condition, so what GitHub
// receives is compared with what the button sends, and every "nothing happened" has a "this did happen" next to it.
// GitHub#433: they also act from the reply box (its text stays) and from inside the discussion frame.
test('GitHub#413 / #433: Ctrl+Shift+X opens the close dialog, Ctrl+Shift+Z hands to the agent, Ctrl+Shift+C is autopilot — the button\'s own write; from the reply box and the discussion too; never from another field, offline, busy, without the button', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  const openOnGitHub = (n: number) => {
    const c = findCopies(store, 'GigleAI/cavil-loop', n)!;
    for (const g of c.gql) Object.assign(g, { state: 'OPEN', stateReason: null });
    for (const r of c.rest) Object.assign(r, { state: 'open', state_reason: null });
  };
  openOnGitHub(137);
  openOnGitHub(139);
  const prN = env.fake.state.projects.get('org/gigleai/11')!.flatMap((p) => p.items.nodes).find((n: any) => n.content?.__typename === 'PullRequest')!.content.number as number;
  for (const g of findCopies(store, 'GigleAI/cavil-loop', prN)!.gql) Object.assign(g, { state: 'OPEN', merged: false });
  for (const r of findCopies(store, 'GigleAI/cavil-loop', prN)!.rest) Object.assign(r, { state: 'open', pull_request: { ...r.pull_request, merged_at: null } });
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const detail = page.getByTestId('detail');
  const dialog = page.getByTestId('confirm-dialog');
  const reply = page.getByTestId('reply-input');
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  const CLOSE = 'Control+Shift+X';
  const HAND = 'Control+Shift+Z';
  const AUTO = 'Control+Shift+C';
  const open = async (n: number) => {
    await page.getByTestId('search').fill(`#${n}`);
    if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').click();
    await card(page, n).click();
    await expect(detail).toHaveAttribute('data-key', `gigleai/cavil-loop#${n}`);
    await expect(frame.locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
    await blur(page);
  };
  /** put the keyboard inside the discussion frame (a click on an entry's title, then back to how it was) */
  const intoFrame = async () => {
    const summary = frame.locator('details.entry > summary').first();
    await summary.click({ position: { x: 40, y: 10 } });
    await summary.click({ position: { x: 40, y: 10 } });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('timeline-frame');
  };
  const autopilotWrites = (n: number) => [
    ['POST', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels`, { labels: ['autopilot'] }],
    ['POST', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels`, { labels: ['pending/agent'] }],
    ['DELETE', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels/pending%2Fhuman`, undefined],
  ];
  const handBackWrites = (n: number) => autopilotWrites(n).slice(1);
  /** the operation of the item on screen has settled: the panel's last notice is no longer busy */
  const settled = () => expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first()).not.toHaveAttribute('data-kind', 'busy', { timeout: 15_000 });

  // ---- 1. every key of the bottom row sits on its own button and in its tooltip (this window runs as Linux: Ctrl+Shift) ----
  await open(137);
  await expect(page.getByTestId('close-issue')).toHaveText('关闭 issue…Ctrl+Shift+X');
  await expect(page.getByTestId('reply-preview-toggle')).toHaveText('预览Ctrl+Shift+P');
  await expect(page.getByTestId('hand-back')).toHaveText('交给 agentCtrl+Shift+Z');
  await expect(page.getByTestId('autopilot')).toHaveText('托管（自动合并）…Ctrl+Shift+C');
  await expect(page.getByTestId('reply-send')).toHaveText('发送Ctrl+↩');
  for (const id of ['close-issue', 'reply-preview-toggle', 'hand-back', 'autopilot', 'reply-send']) await expect(page.getByTestId(id).locator('kbd'), id).toHaveCount(1);
  await expect(detail.locator('.reply .keys-hint')).toHaveCount(0); // the far-away "按 ⌘↩ 发送" is gone
  await expect(page.getByTestId('close-issue')).toHaveAttribute('title', '在 GitHub 上关闭这个 issue（先选原因，Ctrl+Shift+X）');
  await expect(page.getByTestId('hand-back')).toHaveAttribute('title', /（标签名在设置里改，Ctrl\+Shift\+Z）$/);
  await expect(page.getByTestId('autopilot')).toHaveAttribute('title', /（Ctrl\+Shift\+C）$/);
  await shot(page, '433-01-keys-on-buttons');

  // ---- 2. Ctrl+Shift+X: the close dialog of #137, nothing sent; Esc cancels it, the panel stays ----
  await page.keyboard.press(CLOSE);
  await expect(dialog.locator('h3')).toHaveText('关闭 issue #137？');
  await shot(page, '433-02-key-opens-close-dialog');
  expect(env.fake.writes()).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  // with the dialog up the other two keys are the dialog's: nothing
  await page.keyboard.press(CLOSE);
  await expect(dialog).toBeVisible();
  await page.keyboard.press(HAND);
  await page.keyboard.press(AUTO);
  await expect(page.getByTestId('autopilot-explain')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(env.fake.writes()).toEqual([]);
  // the old keys (X, Shift+A, Shift+P) are nobody's now
  await page.keyboard.press('x');
  await page.keyboard.press('Shift+A');
  await page.keyboard.press('Shift+P');
  await page.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('autopilot-explain')).toHaveCount(0);
  expect(env.fake.writes()).toEqual([]);

  // ---- 3. the reply box: letters stay letters, the three keys act and leave the text alone ----
  await reply.click();
  await page.keyboard.type('已看过');
  await page.keyboard.press('x');
  await page.keyboard.press('Shift+A');
  await page.keyboard.press('Shift+P');
  await expect(reply).toHaveValue('已看过xAP');
  await page.keyboard.press(CLOSE);
  await expect(dialog.locator('h3')).toHaveText('关闭 issue #137？');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(reply).toHaveValue('已看过xAP');
  expect(env.fake.writes()).toEqual([]);

  // ---- 4. Ctrl+Shift+Z from the reply box (text in it): GitHub#451 — the text goes out first as a comment, then the
  // hand-back write; the box is emptied (the operation keeps the text); while it is held the keys do nothing more ----
  await reply.focus();
  await expect(page.getByTestId('hand-back')).toHaveText('评论并交给 agentCtrl+Shift+Z');
  await expect(page.getByTestId('autopilot')).toHaveText('评论并托管（自动合并）…Ctrl+Shift+C');
  await expect(page.getByTestId('hand-back')).toHaveAttribute('title', /^先把回复框里的字作为评论发出，发成功后再加上「pending\/agent」/);
  const release = env.fake.holdWhen((e) => e.method === 'DELETE' && e.path.includes('/issues/137/labels/'));
  await page.keyboard.press(HAND);
  await expect.poll(() => writes().length).toBe(3);
  await expect(page.getByTestId('hand-back')).toBeDisabled();
  await expect(reply).toHaveValue('');
  await page.keyboard.press(HAND);
  await page.keyboard.press(CLOSE);
  await page.keyboard.press(AUTO);
  await page.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
  release();
  await settled();
  expect(writes()).toEqual([['POST', '/api/repos/GigleAI/cavil-loop/issues/137/comments', { body: '已看过xAP' }], ...handBackWrites(137)]);
  await expect(page.getByTestId('hand-back')).toHaveText('交给 agentCtrl+Shift+Z');

  // ---- 5. Ctrl+Shift+C from the empty reply box with "ask first" on: the autopilot dialog; Esc cancels; Ctrl+↩ confirms the same write as the button ----
  await expect(page.getByTestId('hand-back')).toBeEnabled();
  await reply.fill('');
  await reply.focus();
  let before = writes().length;
  await page.keyboard.press(AUTO);
  await expect(page.getByTestId('autopilot-explain')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(writes()).toHaveLength(before);
  await page.keyboard.press(AUTO);
  await expect(page.getByTestId('autopilot-explain')).toBeVisible();
  await page.keyboard.press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await settled();
  expect(writes().slice(before)).toEqual(autopilotWrites(137));
  await expect(reply).toHaveValue('');

  // ---- 5b. another field (the search box): the three keys do nothing there, while Ctrl+R from the same box still syncs ----
  await page.getByTestId('search').focus();
  before = writes().length;
  await page.keyboard.press(CLOSE);
  await page.keyboard.press(HAND);
  await page.keyboard.press(AUTO);
  await page.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('autopilot-explain')).toHaveCount(0);
  expect(writes()).toHaveLength(before);
  const synced = (await lastOnline(page)) ?? 0;
  await page.waitForTimeout(20);
  await page.keyboard.press('Control+r');
  await expect.poll(async () => (await lastOnline(page)) ?? 0, { timeout: 15_000 }).toBeGreaterThan(synced);
  await expect(page.getByTestId('search')).toBeFocused();
  await blur(page);

  // ---- 6. the button on #139 (ticking "不再提示"): its write is the key's write on another item ----
  await open(139);
  before = writes().length;
  await page.getByTestId('autopilot').click();
  await page.getByTestId('autopilot-no-more-ask').check();
  await page.getByTestId('confirm-ok').click();
  await settled();
  const byButton = writes().slice(before);
  expect(byButton).toEqual(autopilotWrites(139));

  // ---- 7. an open PR, keys pressed inside the discussion frame: no "close issue" there, so Ctrl+Shift+X does nothing;
  // the frame keeps its own keys (Ctrl+A / Ctrl+C, a bare x); Ctrl+Shift+C now autopilots at once (no dialog) ----
  await open(prN);
  await expect(page.getByTestId('close-issue')).toHaveCount(0);
  await expect(page.getByTestId('autopilot')).toHaveText('托管（自动合并）Ctrl+Shift+C');
  await intoFrame();
  before = writes().length;
  await page.keyboard.press(CLOSE);
  await page.keyboard.press('x');
  await page.keyboard.press('Control+a'); // select all — inside the frame
  expect(await frame.locator('body').evaluate(() => String(window.getSelection()).length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => String(window.getSelection()))).toBe('');
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('new-issue')).toHaveCount(0);
  expect(writes()).toHaveLength(before);
  await page.keyboard.press(AUTO);
  await settled();
  await expect(dialog).toHaveCount(0);
  expect(writes().slice(before)).toEqual(byButton.map(([m, p, b]) => [m, String(p).replace('/issues/139/', `/issues/${prN}/`), b]));

  // ---- 8. Ctrl+Shift+X inside the discussion frame, then ⌘↩ (Ctrl here): #139 really closes ----
  await open(139);
  await intoFrame();
  before = writes().length;
  await page.keyboard.press(CLOSE);
  await expect(dialog.locator('h3')).toHaveText('关闭 issue #139？');
  // the key came from the discussion frame: the dialog takes the keyboard out of it (else ⌘↩ would stay in the frame)
  await expect(dialog.getByRole('dialog')).toBeFocused();
  await page.keyboard.press('Control+Enter');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => writes().slice(before)).toEqual([['PATCH', '/api/repos/GigleAI/cavil-loop/issues/139', { state: 'closed', state_reason: 'completed' }]]);
  // GitHub#447: GitHub took it: the panel puts itself away, the result is in the strip at the top of the window
  await expect(detail).toHaveCount(0, { timeout: 15_000 });
  // (the newest of #139's notices: the 托管 one before it may still be counting its 5 s)
  await expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"][data-key="gigleai/cavil-loop#139"]').first()).not.toHaveAttribute('data-kind', 'busy', { timeout: 15_000 });

  // ---- 9. no autopilot label in Settings: no button, so Ctrl+Shift+C does nothing (from the frame neither); Ctrl+Shift+Z from the frame still hands back ----
  await page.getByTestId('open-settings').click();
  await page.getByTestId('hand-back-autopilot').fill('');
  await page.getByTestId('hand-back-autopilot').blur();
  await page.getByTestId('back').click();
  await open(137);
  await expect(page.getByTestId('autopilot')).toHaveCount(0);
  await intoFrame();
  before = writes().length;
  await page.keyboard.press(AUTO);
  await page.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
  expect(writes()).toHaveLength(before);
  await page.keyboard.press(HAND);
  await expect.poll(() => writes().slice(before)).toEqual(handBackWrites(137));
  await settled();

  // ---- 10. offline: the buttons grey out and the keys do nothing ----
  before = writes().length;
  env.fake.state.offline = true;
  await page.getByTestId('refresh').press('Enter');
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('close-issue')).toBeDisabled();
  await expect(page.getByTestId('hand-back')).toBeDisabled();
  await blur(page);
  await page.keyboard.press(CLOSE);
  await page.keyboard.press(HAND);
  await page.keyboard.press(AUTO);
  await page.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
  expect(writes()).toHaveLength(before);
  await app.close();
});

// GitHub#487: keys changed in Settings → 快捷键. The new key acts (from the panel and from inside the discussion
// frame), the old one does not; the button, the tooltip and the shortcut list show it; a key another shortcut
// has is refused, and so is putting a shortcut back when its default key is taken; it survives a restart.
test('GitHub#487: a shortcut changed in Settings acts everywhere the old one did (panel, discussion frame), the old key no longer does; conflicts and a blocked restore are refused; kept after a restart', async () => {
  const store = { projects: env.fake.state.projects, repos: env.fake.state.repos, w: env.fake.state.w };
  for (const n of [137, 138, 139]) {
    const c = findCopies(store, 'GigleAI/cavil-loop', n)!;
    for (const g of c.gql) Object.assign(g, { state: 'OPEN', stateReason: null });
    for (const r of c.rest) Object.assign(r, { state: 'open', state_reason: null });
  }
  let { app, page } = await launch(env);
  await signInWithSources(page);
  const detail = page.getByTestId('detail');
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  const row = (id: string) => page.locator(`[data-testid="shortcut-setting"][data-id="${id}"]`);
  const handBackWrites = (n: number) => [
    ['POST', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels`, { labels: ['pending/agent'] }],
    ['DELETE', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels/pending%2Fhuman`, undefined],
  ];
  const open = async (n: number) => {
    await page.getByTestId('search').fill(`#${n}`);
    if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').click();
    await card(page, n).click();
    await expect(detail).toHaveAttribute('data-key', `gigleai/cavil-loop#${n}`);
    await expect(frame.locator('details.entry').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
    await blur(page);
  };
  const settled = () => expect(page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first()).not.toHaveAttribute('data-kind', 'busy', { timeout: 15_000 });

  // ---- 1. Settings → 快捷键: the section is in the contents; 交给 agent → Ctrl+Shift+A ----
  await page.getByTestId('open-settings').click();
  await expect(page.locator('.settings-nav a', { hasText: '快捷键' })).toHaveCount(1);
  await expect(row('handBack').getByTestId('shortcut-setting-keys')).toHaveText('CtrlShiftZ');
  await expect(row('hide').getByTestId('shortcut-change')).toHaveCount(0); // Esc is fixed
  await row('handBack').getByTestId('shortcut-change').click();
  await expect(row('handBack').getByTestId('shortcut-recording')).toBeVisible();
  // ⌘⇧B is 等前置's: refused, said so, still recording; the window's own shortcuts did not act meanwhile
  await page.keyboard.press('Control+Shift+B');
  await expect(page.getByTestId('shortcut-problem')).toContainText('「等前置」');
  await expect(row('handBack').getByTestId('shortcut-recording')).toBeVisible();
  await expect(page.getByTestId('settings')).toBeVisible();
  await shot(page, '487-01-conflict-refused');
  await page.keyboard.press('Control+Shift+A');
  await expect(row('handBack').getByTestId('shortcut-setting-keys')).toHaveText('CtrlShiftA已改');
  await expect(row('handBack')).toHaveAttribute('data-custom', 'yes');
  await expect(page.getByTestId('shortcut-problem')).toHaveCount(0);
  await shot(page, '487-02-changed');

  // PR #498 review round 1: Ctrl+Shift+] (the browser reports "}") for 跳到搜索框 is 下一个标签页's key: refused
  await row('search').getByTestId('shortcut-change').click();
  await page.keyboard.press('Control+Shift+BracketRight');
  await expect(page.getByTestId('shortcut-problem')).toContainText('「下一个标签页」');
  await page.keyboard.press('Escape');
  await expect(row('search').getByTestId('shortcut-setting-keys')).toHaveText('/');

  // ---- 2. the blocked restore of the review: 新建 → Ctrl+Shift+I, 搜索 → C, then restore 新建: refused, both stay ----
  await row('newIssue').getByTestId('shortcut-change').click();
  await page.keyboard.press('Control+Shift+I');
  await expect(row('newIssue')).toHaveAttribute('data-custom', 'yes');
  await row('search').getByTestId('shortcut-change').click();
  await page.keyboard.press('c');
  await expect(row('search').getByTestId('shortcut-setting-keys')).toHaveText('C已改');
  await row('newIssue').getByTestId('shortcut-restore').click();
  await expect(page.getByTestId('shortcut-problem')).toContainText('恢复不了');
  await expect(page.getByTestId('shortcut-problem')).toContainText('「跳到搜索框」');
  await expect(row('newIssue').getByTestId('shortcut-setting-keys')).toHaveText('CtrlShiftI已改');
  await shot(page, '487-03-restore-refused');
  // in the other order it works
  await row('search').getByTestId('shortcut-restore').click();
  await row('newIssue').getByTestId('shortcut-restore').click();
  await expect(row('newIssue').getByTestId('shortcut-setting-keys')).toHaveText('C / CtrlN');
  await expect(row('search').getByTestId('shortcut-setting-keys')).toHaveText('/');
  await page.getByTestId('back').click();

  // ---- 3. the button, its tooltip and the shortcut list say Ctrl+Shift+A ----
  await open(137);
  await expect(page.getByTestId('hand-back')).toHaveText('交给 agentCtrl+Shift+A');
  await expect(page.getByTestId('hand-back')).toHaveAttribute('title', /（标签名在设置里改，Ctrl\+Shift\+A）$/);
  // the old key does nothing now
  let before = writes().length;
  await page.keyboard.press('Control+Shift+Z');
  await page.waitForTimeout(400);
  expect(writes()).toHaveLength(before);
  // the new key hands back, the button's own writes
  await page.keyboard.press('Control+Shift+A');
  await expect.poll(() => writes().slice(before)).toEqual(handBackWrites(137));
  await settled();

  // ---- 4. from inside the discussion frame: the window sent it the new keys ----
  await open(138);
  const summary = frame.locator('details.entry > summary').first();
  await summary.click({ position: { x: 40, y: 10 } });
  await summary.click({ position: { x: 40, y: 10 } });
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('timeline-frame');
  before = writes().length;
  await page.keyboard.press('Control+Shift+Z');
  await page.waitForTimeout(400);
  expect(writes()).toHaveLength(before);
  await page.keyboard.press('Control+Shift+A');
  await expect.poll(() => writes().slice(before)).toEqual(handBackWrites(138));
  await settled();

  // ---- 4b. PR #498 review round 1: changed to a key without Ctrl (G), it does nothing from the discussion, as the
  // settings page says; from the panel itself it hands back ----
  await page.getByTestId('open-settings').click();
  await row('handBack').getByTestId('shortcut-change').click();
  await page.keyboard.press('g');
  await expect(row('handBack').getByTestId('shortcut-setting-keys')).toHaveText('G已改');
  await expect(row('handBack').getByTestId('shortcut-plain-note')).toHaveText('不带 Ctrl 的键在回复框、讨论区里按不生效');
  await page.getByTestId('back').click();
  await open(139);
  await summary.click({ position: { x: 40, y: 10 } });
  await summary.click({ position: { x: 40, y: 10 } });
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('timeline-frame');
  before = writes().length;
  await page.keyboard.press('g');
  await page.waitForTimeout(600);
  expect(writes()).toHaveLength(before);
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#139');
  // R (跳到回复框) still comes from the discussion, as before
  await page.keyboard.press('r');
  await expect(page.getByTestId('reply-input')).toBeFocused();
  await blur(page);
  await page.keyboard.press('g');
  await expect.poll(() => writes().slice(before)).toEqual(handBackWrites(139));
  await settled();

  // ---- 5. the shortcut list marks it, and leads to the settings section ----
  await blur(page);
  await page.keyboard.press('Shift+?');
  const help = page.getByTestId('shortcut-help');
  await expect(help.locator('[data-testid="shortcut-row"][data-id="handBack"]')).toContainText('已改');
  await expect(help.locator('[data-testid="shortcut-row"][data-id="handBack"] kbd')).toHaveText(['G']);
  await shot(page, '487-04-help');
  await help.getByTestId('shortcut-help-edit').click();
  await expect(page.getByTestId('shortcut-settings')).toBeInViewport();

  // ---- 6. a restart keeps it; 全部恢复默认 puts Ctrl+Shift+Z back ----
  await app.close();
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('open-settings').click();
  await expect(row('handBack').getByTestId('shortcut-setting-keys')).toHaveText('G已改');
  await page.getByTestId('shortcut-reset-all').click();
  await expect(row('handBack').getByTestId('shortcut-setting-keys')).toHaveText('CtrlShiftZ');
  await expect(row('handBack')).toHaveAttribute('data-custom', 'no');
  await app.close();
});

test('GitHub#451: text in the reply box — 托管 quotes it in the dialog and posts it before any label; a refused comment leaves every label alone and comes back to the reply box', async () => {
  const { app, page } = await launch(env);
  await signInWithSources(page);
  await card(page, 138).click();
  const detail = page.getByTestId('detail');
  const reply = page.getByTestId('reply-input');
  const dialog = page.getByTestId('confirm-dialog');
  const notice = () => page.locator('[data-testid="notice-area"] [data-testid="op-notice"]').first();
  const comment = (n: number, body: string) => ['POST', `/api/repos/GigleAI/cavil-loop/issues/${n}/comments`, { body }];
  const autopilotWrites = (n: number) => [
    ['POST', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels`, { labels: ['autopilot'] }],
    ['POST', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels`, { labels: ['pending/agent'] }],
    ['DELETE', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels/pending%2Fhuman`, undefined],
  ];

  // ---- 1. the dialog quotes what will be posted; cancel sends nothing and keeps the text ----
  await reply.fill('补充：只改客户端\n第二行');
  await expect(page.getByTestId('autopilot')).toHaveText('评论并托管（自动合并）…Ctrl+Shift+C');
  await page.getByTestId('autopilot').click();
  await expect(dialog.locator('h3')).toHaveText('评论并托管 issue #138？');
  await expect(page.getByTestId('autopilot-comment')).toHaveText('补充：只改客户端\n第二行');
  await expect(page.getByTestId('autopilot-explain-labels')).toContainText('评论发成功后，再加上标签');
  await shot(page, '451-01-autopilot-with-comment');
  await page.getByTestId('confirm-cancel').click();
  expect(env.fake.writes()).toEqual([]);
  await expect(reply).toHaveValue('补充：只改客户端\n第二行');

  // ---- 2. refused comment: it reached GitHub, no label request after it; the text is kept and goes back into the box ----
  env.fake.state.w.readOnlyRepos.add('gigleai/cavil-loop');
  await page.getByTestId('autopilot').click();
  await page.getByTestId('confirm-ok').click();
  await expect(dialog).toHaveCount(0);
  await expect(reply).toHaveValue('');
  await expect(notice()).toHaveAttribute('data-kind', 'error', { timeout: 15_000 });
  expect(writes()).toEqual([comment(138, '补充：只改客户端\n第二行')]);
  await openNotices(page);
  await expect(notice().getByTestId('op-notice-text')).toContainText('评论没有发出去');
  await expect(notice().getByTestId('op-notice-text')).toContainText('标签都没动');
  await shot(page, '451-02-comment-refused');
  // "重新托管…" quotes the comment this operation kept, not the (now empty) reply box; cancelled, nothing sent
  await notice().getByTestId('op-retry').click();
  await expect(dialog.locator('h3')).toHaveText('评论并托管 issue #138？');
  await expect(page.getByTestId('autopilot-explain-comment')).toHaveText('先发出上一次没发出去的评论：');
  await expect(page.getByTestId('autopilot-comment')).toHaveText('补充：只改客户端\n第二行');
  await page.getByTestId('confirm-cancel').click();
  expect(writes()).toEqual([comment(138, '补充：只改客户端\n第二行')]);
  await openNotices(page);
  await notice().getByTestId('op-to-reply').click();
  await expect(reply).toHaveValue('补充：只改客户端\n第二行');

  // ---- 3. allowed again: the kept text goes out first, then the three label writes, in that order ----
  env.fake.state.w.readOnlyRepos.clear();
  const before = writes().length;
  await page.getByTestId('autopilot').click();
  await expect(page.getByTestId('autopilot-comment')).toHaveText('补充：只改客户端\n第二行');
  await page.getByTestId('confirm-ok').click();
  await expect.poll(() => writes().slice(before), { timeout: 15_000 }).toEqual([comment(138, '补充：只改客户端\n第二行'), ...autopilotWrites(138)]);
  await expect(reply).toHaveValue('');
  await app.close();
});

// ---- GitHub#496: the label picker lists what the item carries first, then autopilot / pending/human / pending/agent ----

test('GitHub#496: label pickers (detail, table cell, new issue) list the checked labels first, then the pinned flow labels; a click only moves the tick, reopening re-sorts', async () => {
  const N = 140;
  const C = (name: string, color: string) => ({ name, color });
  // the repository's labels, in GitHub's order; pending/agent is in the list this time
  const repoLabels = [C('doing/agent', 'c2e0c6'), C('Done', '555555'), C('autopilot', 'e4572e'), C('pending/PR', 'ededed'), C('pending/human', 'fbca04'), C('priority/p2', 'c5def5'), C('pending/agent', '0e8a16'), C('pending/review', 'fbca04'), C('enhancement', 'a2eeef')];
  env.fake.state.w.repoLabels.set('gigleai/cavil-loop', repoLabels);
  const carried = [C('pending/review', 'fbca04'), C('enhancement', 'a2eeef')];
  for (const r of env.fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === N) r.labels = carried;
  for (const p of env.fake.state.projects.get('org/gigleai/11')!) for (const node of p.items.nodes) if (node.content?.number === N) node.content.labels.nodes = carried;
  env.fake.state.w.milestones.set('gigleai/cavil-loop', [
    { number: 1, title: 'v1', state: 'open', due_on: null },
    { number: 2, title: 'v2', state: 'open', due_on: null },
  ]);
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const names = (picker: Locator) => picker.getByTestId('picker-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));
  const ticks = (picker: Locator) => picker.locator('[data-testid="picker-item"][data-checked="yes"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));
  const REST = ['doing/agent', 'Done', 'pending/PR', 'priority/p2'];

  // ---- 1. detail ----
  const detail = page.getByTestId('detail');
  await card(page, N).click();
  await expect(detail).toHaveAttribute('data-key', `gigleai/cavil-loop#${N}`);
  await expect(detail.getByTestId('label-add')).toBeEnabled({ timeout: 15_000 });
  await detail.getByTestId('label-add').click();
  const picker = detail.getByTestId('label-picker');
  await expect(picker).toBeVisible();
  const opened = ['pending/review', 'enhancement', 'autopilot', 'pending/human', 'pending/agent', ...REST];
  expect(await names(picker)).toEqual(opened);
  expect(await picker.locator('[data-testid="picker-item"][data-active="yes"]').getAttribute('data-name')).toBe('pending/review');
  await shot(page, '496-01-detail-picker');
  // a click takes the tick off / puts it on; no row moves while the picker is open
  const before = writes().length;
  await picker.locator('[data-name="enhancement"]').click();
  await expect(picker.locator('[data-name="enhancement"]')).toHaveAttribute('data-checked', 'no');
  await picker.locator('[data-name="Done"]').click();
  await expect(picker.locator('[data-name="Done"]')).toHaveAttribute('data-checked', 'yes');
  await expect.poll(() => writes().slice(before).map(([m, p]) => `${m} ${p}`)).toEqual([
    `DELETE /api/repos/GigleAI/cavil-loop/issues/${N}/labels/enhancement`,
    `POST /api/repos/GigleAI/cavil-loop/issues/${N}/labels`,
  ]);
  expect(await names(picker)).toEqual(opened);
  // the filter keeps the order
  await picker.getByTestId('picker-filter').fill('pending/');
  expect(await names(picker)).toEqual(['pending/review', 'pending/human', 'pending/agent', 'pending/PR']);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  // reopened: sorted by what it carries now
  await detail.getByTestId('label-add').click();
  await expect(picker).toBeVisible();
  const now = ['Done', 'pending/review', 'autopilot', 'pending/human', 'pending/agent', 'doing/agent', 'pending/PR', 'priority/p2', 'enhancement'];
  expect(await names(picker)).toEqual(now);
  expect(await ticks(picker)).toEqual(['Done', 'pending/review']);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);

  // ---- 2. the milestone picker: the current one first ----
  await blur(page);
  await page.keyboard.press('m');
  const ms = detail.getByTestId('milestone-picker');
  await expect(ms).toBeVisible();
  expect(await names(ms)).toEqual(['v1', 'v2']);
  await page.keyboard.type('v2');
  await page.keyboard.press('Enter');
  await expect(ms).toHaveCount(0);
  await expect(detail.getByTestId('milestone-select')).toHaveValue('v2');
  await page.keyboard.press('m');
  await expect(ms).toBeVisible();
  expect(await names(ms)).toEqual(['v2', 'v1']);
  await page.keyboard.press('Escape');
  await expect(ms).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);

  // ---- 3. the table cell: the same order ----
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  const row = page.locator(`[data-testid="row"][data-key="gigleai/cavil-loop#${N}"]`).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('[data-testid="cell"][data-col="labels"]').click();
  const cell = row.getByTestId('cell-label-picker');
  await expect(cell).toBeVisible();
  expect(await names(cell)).toEqual(now);
  await cell.locator('[data-name="pending/human"]').click();
  await expect(cell.locator('[data-name="pending/human"]')).toHaveAttribute('data-checked', 'yes');
  expect(await names(cell)).toEqual(now);
  await page.keyboard.press('Escape');
  await expect(cell).toHaveCount(0);
  await row.locator('[data-testid="cell"][data-col="labels"]').click();
  await expect(cell).toBeVisible();
  // pending/human is checked now: among the checked ones, the pinned label comes first
  expect(await names(cell)).toEqual(['pending/human', 'Done', 'pending/review', 'autopilot', 'pending/agent', 'doing/agent', 'pending/PR', 'priority/p2', 'enhancement']);
  await page.keyboard.press('Escape');
  await expect(cell).toHaveCount(0);

  // ---- 4. new issue: nothing chosen yet, so the pinned labels lead ----
  await page.getByTestId('write-entry').click();
  await page.getByTestId('new-issue-title').fill('标签顺序');
  await openMoreFields(page);
  await page.getByTestId('new-issue-label-add').click();
  const np = page.getByTestId('new-issue-label-picker');
  await expect(np).toBeVisible();
  const fresh = ['autopilot', 'pending/human', 'pending/agent', ...REST, 'pending/review', 'enhancement'];
  expect(await names(np)).toEqual(fresh);
  await np.locator('[data-name="enhancement"]').click();
  await expect(np.locator('[data-name="enhancement"]')).toHaveAttribute('data-checked', 'yes');
  expect(await names(np)).toEqual(fresh);
  await page.keyboard.press('Escape');
  await expect(np).toHaveCount(0);
  await page.getByTestId('new-issue-label-add').click();
  await expect(np).toBeVisible();
  expect(await names(np)).toEqual(['enhancement', 'autopilot', 'pending/human', 'pending/agent', ...REST, 'pending/review']);
  await shot(page, '496-02-new-issue-picker');
  await app.close();
});

// ---- GitHub#513: pending/later is pinned right after pending/human, in all three pickers, and follows Settings ----

test('GitHub#513: label pickers (detail, table cell, new issue) pin the parked label right after pending/human; renamed in Settings it follows, emptied it is not pinned', async () => {
  const N = 140;
  const C = (name: string, color: string) => ({ name, color });
  // the repository's labels, in GitHub's order: the parked label was created last, so without the pin it is listed last
  const repoLabels = [C('doing/agent', 'c2e0c6'), C('Done', '555555'), C('autopilot', 'e4572e'), C('pending/PR', 'ededed'), C('pending/human', 'fbca04'), C('parked', 'cccccc'), C('pending/agent', '0e8a16'), C('enhancement', 'a2eeef'), C('pending/later', 'bfdadc')];
  env.fake.state.w.repoLabels.set('gigleai/cavil-loop', repoLabels);
  // the item carries nothing, so the pinned labels lead in every picker
  for (const r of env.fake.state.repos.get('gigleai/cavil-loop')!) if (r.number === N) r.labels = [];
  for (const p of env.fake.state.projects.get('org/gigleai/11')!) for (const node of p.items.nodes) if (node.content?.number === N) node.content.labels.nodes = [];
  const { app, page } = await launch(env);
  await signInWithSources(page);
  const names = (picker: Locator) => picker.getByTestId('picker-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));
  const detail = page.getByTestId('detail');
  const row = page.locator(`[data-testid="row"][data-key="gigleai/cavil-loop#${N}"]`).first();

  /** open the label picker in each of the three places and return what each lists, in order */
  const allThree = async () => {
    // 1. detail (the floating panel over the board)
    await card(page, N).click();
    await expect(detail).toHaveAttribute('data-key', `gigleai/cavil-loop#${N}`);
    await expect(detail.getByTestId('label-add')).toBeEnabled({ timeout: 15_000 });
    await detail.getByTestId('label-add').click();
    const picker = detail.getByTestId('label-picker');
    await expect(picker).toBeVisible();
    const inDetail = await names(picker);
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    // 2. the table's label cell
    await page.locator('[data-testid="layout"] button[data-value="table"]').click();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator('[data-testid="cell"][data-col="labels"]').click();
    const cell = row.getByTestId('cell-label-picker');
    await expect(cell).toBeVisible();
    const inTable = await names(cell);
    await page.keyboard.press('Escape');
    await expect(cell).toHaveCount(0);
    await page.locator('[data-testid="layout"] button[data-value="board"]').click();
    // 3. new issue
    await page.getByTestId('write-entry').click();
    await openMoreFields(page);
    await page.getByTestId('new-issue-label-add').click();
    const np = page.getByTestId('new-issue-label-picker');
    await expect(np).toBeVisible();
    const inNew = await names(np);
    await page.keyboard.press('Escape');
    await expect(np).toHaveCount(0);
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('new-issue')).toHaveCount(0);
    return { detail: inDetail, table: inTable, newIssue: inNew };
  };
  const same = (list: string[]) => ({ detail: list, table: list, newIssue: list });
  const setLater = async (value: string) => {
    await page.getByTestId('open-settings').click();
    await page.getByTestId('hand-back-later').fill(value);
    await page.getByTestId('hand-back-later').blur();
    await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.handBack.later)).toBe(value);
    await page.getByTestId('back').click();
  };

  // ---- default: pending/later right after pending/human ----
  expect(await allThree()).toEqual(same(['autopilot', 'pending/human', 'pending/later', 'pending/agent', 'doing/agent', 'Done', 'pending/PR', 'parked', 'enhancement']));
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('hand-back-later')).toHaveValue('pending/later');
  await page.getByTestId('back').click();

  // ---- renamed: the new name takes the place, pending/later goes back where the repository has it ----
  await setLater('parked');
  expect(await allThree()).toEqual(same(['autopilot', 'pending/human', 'parked', 'pending/agent', 'doing/agent', 'Done', 'pending/PR', 'enhancement', 'pending/later']));

  // ---- empty: nothing pinned in its place (the order before GitHub#513) ----
  await setLater('');
  expect(await allThree()).toEqual(same(['autopilot', 'pending/human', 'pending/agent', 'doing/agent', 'Done', 'pending/PR', 'parked', 'enhancement', 'pending/later']));
  expect(writes()).toEqual([]);
  await app.close();
});
