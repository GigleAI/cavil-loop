// UI tests: the real window (built with --test-bridge) driven by Playwright,
// the real back end (Rust, the harness build of crates/core) behind a loopback
// bridge, talking to the local fake GitHub over loopback (test/e2e/bridge.ts).
// Screenshots of each step land in test-results/screens/ (uploaded by CI).

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub, loadCavilProjectPages } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';
import { findCopies, pullOf } from '../fake-github/writes';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';

type Env = AppEnv;

async function launch(env: Env) {
  const app = await launchApp(env);
  return { app, page: app.page };
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(screens, `${name}.png`) });
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

  // the Project brought its first saved web view along ("Pending": table, -label:Done -status:Done);
  // this test is about the board, so switch back to it and clear the filter
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('search')).toHaveValue('-label:Done -status:Done');
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await page.getByTestId('search').fill('');

  // iteration (default): each iteration column holds what the Project says
  await expect.poll(() => countOf(page, 'Iteration 25'), { timeout: 15_000 }).toBe('12');
  const iter = rawCount('Iteration', 'title');
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
  expect(got['未加入看板'] ?? 0).toBe(repoOnly);
  await shot(page, '04-by-iteration');

  await page.getByTestId('mode').selectOption('status');
  const status = rawCount('Status', 'name');
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

  // a source that fails mid-pagination keeps last round's data, banner says so
  env.fake.state.failProjectPage.set('org/gigleai/11', 1);
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('incomplete')).toBeVisible();
  expect(await countOf(page, 'Iteration 25')).toBe('12');
  await shot(page, '07-incomplete');
  env.fake.state.failProjectPage.clear();

  // restart: no login needed
  await app.close();
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('incomplete')).toHaveCount(0, { timeout: 15_000 });
  await app.close();

  // offline restart: content from the cache, flagged offline, writes grey
  env.fake.state.offline = true;
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('offline')).toContainText('离线 · 数据截至', { timeout: 15_000 });
  expect(await countOf(page, 'Iteration 25')).toBe('12');
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

async function signInWithSources(page: Page) {
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
  // adding the Project imported its saved web view (#137: table, -label:Done -status:Done);
  // these tests are about the board, so switch back to it and clear the filter
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-testid="layout"] button[data-value="board"]').click();
  await page.getByTestId('search').fill('');
  await expect.poll(() => countOf(page, 'Iteration 25'), { timeout: 15_000 }).toBe('12');
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

const card = (page: Page, n: number) => page.locator(`[data-testid="card"][data-key="gigleai/cavil-loop#${n}"]`).first();
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
  await expect(frameEl).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  await expect(frame.locator('details.entry')).toHaveCount(3);
  expect(await frame.locator('details.entry').evaluateAll((els) => els.map((e) => e.getAttribute('data-entry')))).toEqual(['C-new', 'C-old', expect.stringMatching(/^I_/)]);
  await shot(page, '20-detail-newest-first');
  // a link in GitHub's HTML opens the system browser; the frame itself never navigates
  await frame.locator('a', { hasText: 'link' }).click();
  await expect.poll(() => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '')).toContain('https://github.com/GigleAI/cavil-loop\n');
  await expect(frame.locator('details.entry')).toHaveCount(3);

  // ---- labels: add in the detail, remove on the card ----
  await pickLabel(page, 'Done');
  await expect(page.getByTestId('action-result')).toHaveAttribute('data-kind', 'ok');
  await expect(card(page, 138).locator('.label', { hasText: 'Done' })).toBeVisible();
  await card(page, 138).hover();
  await card(page, 138).locator('[data-testid="card-label-remove"][data-label="Done"]').click();
  await expect(page.getByTestId('board-action-result')).toHaveAttribute('data-kind', 'ok');
  await expect(card(page, 138).locator('.label', { hasText: 'Done' })).toHaveCount(0);

  // ---- status and milestone in the detail ----
  await detail.getByTestId('status-select').selectOption('In progress');
  await expect(page.getByTestId('action-result')).toContainText('状态已改');
  await detail.getByTestId('milestone-select').selectOption('v1');
  await expect(page.getByTestId('action-result')).toContainText('里程碑改成「v1」');
  await shot(page, '21-detail-fields');

  // ---- reply with preview, then hand back to the agent ----
  await detail.getByTestId('reply-input').fill('看过了，按 **A** 做');
  await detail.getByTestId('reply-preview-toggle').click();
  await expect(page.frameLocator('[data-testid="reply-preview"]').locator('body')).toContainText('看过了');
  await detail.getByTestId('reply-send').click();
  await expect(page.getByTestId('action-result')).toContainText('评论已发出');
  await expect(frame.locator('details.entry').first()).toContainText('看过了');
  await shot(page, '22-replied');
  await detail.getByTestId('hand-back').click();
  await expect(page.getByTestId('action-result')).toContainText('已交回 agent');
  await expect(card(page, 138).locator('.label', { hasText: 'pending/agent' })).toBeVisible();
  await expect(card(page, 138).locator('.label', { hasText: 'pending/human' })).toHaveCount(0);
  await page.getByTestId('detail-close').click();

  // ---- drag a card to another iteration: only that Project's value changes ----
  const before137 = writes().length;
  await card(page, 137).dragTo(page.locator('[data-testid="column"][data-title="Iteration 26"]'));
  await expect(page.getByTestId('board-action-result')).toHaveAttribute('data-kind', 'ok');
  await expect(page.locator('[data-testid="column"][data-title="Iteration 26"] [data-testid="card"][data-key="gigleai/cavil-loop#137"]')).toBeVisible();
  expect(writes().slice(before137).map((w) => w[0])).toEqual(['CavilSetIteration']);
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
  await expect(page.getByTestId('action-result')).toHaveAttribute('data-kind', 'error');
  await expect(page.getByTestId('action-result')).toContainText('新提交');
  expect(env.fake.digest()).toBe(digest);
  await shot(page, '24-merge-refused');
  await page.getByTestId('detail-refresh').click();
  await expect(page.getByTestId('pr-status')).toContainText('fffffff');
  await expect(page.getByTestId('merge-method')).toHaveValue('squash');
  await page.getByTestId('merge').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('action-result')).toContainText('已合并');
  await expect(card(page, prN).getByTestId('card-state')).toContainText('已合并');
  expect(env.fake.writes().filter((w) => w.path.endsWith('/merge')).map((w) => w.body)).toEqual([
    { merge_method: 'squash', sha: seen },
    { merge_method: 'squash', sha: 'f'.repeat(40) },
  ]);
  await shot(page, '25-merged');
  await page.getByTestId('detail-close').click();

  // ---- new issue: joins the ticked Project ----
  await page.getByTestId('write-entry').click();
  await page.getByTestId('new-issue-title').fill('客户端里建的 issue');
  await page.getByTestId('new-issue-body').fill('正文');
  await page.locator('[data-testid="new-issue-label"][data-label="pending/human"]').check();
  await expect(page.getByTestId('new-issue-projects')).toContainText('cavil project');
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
  await expect(card(page, next)).toBeVisible();

  // ---- offline: every change entry greys out, nothing is sent ----
  env.fake.state.offline = true;
  await page.getByTestId('refresh').click();
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
  await expect(page.getByTestId('action-result')).toContainText('已合并');
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

test('a slow answer for the item you left never lands on the one you are looking at; images only from github.com', async () => {
  const w = env.fake.state.w;
  w.bodies.set('gigleai/cavil-loop#138', '<p>BODY_138</p>');
  w.bodies.set('gigleai/cavil-loop#137', [
    '<p>BODY_137</p>',
    '<p><img alt="via proxy" src="https://camo.githubusercontent.com/probe-138"></p>',
    '<p><img alt="attachment" src="https://private-user-images.githubusercontent.com/probe.png"></p>',
    '<p><img alt="on github" src="https://github.com/GigleAI/cavil-loop/raw/main/probe.png"></p>',
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

  // 2. images: only the github.com one is requested; the others are not even tried, and the entry says so
  await expect(frame.locator('[data-blocked]')).toHaveAttribute('data-blocked', '2');
  // (every request the window made outside its own bridge; the app's page policy is what stops the rest)
  await expect.poll(() => (existsSync(env.requests) ? readFileSync(env.requests, 'utf8') : '')).toContain('request https://github.com/GigleAI/cavil-loop/raw/main/probe.png');
  const seen = readFileSync(env.requests, 'utf8');
  // GitHub's image proxy and attachment hosts: never even asked; the avatar host is the one exception (#155)
  expect(seen).not.toContain('camo.githubusercontent.com');
  expect(seen).not.toContain('private-user-images.githubusercontent.com');
  expect(seen.split('\n').filter((l) => l && !/^request https:\/\/((api\.)?github\.com|avatars\.githubusercontent\.com)\//.test(l))).toEqual([]);
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
  await expect(page.getByTestId('board-action-result')).toContainText('GigleAI/cavil-loop#137：已加上标签「Done」');
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
  await expect(page.getByTestId('board-action-result')).toContainText('GigleAI/cavil-loop#138：评论已发出');
  await expect(detail.getByTestId('reply-input')).toHaveValue('NEW_UNSENT_DRAFT_AFTER_RETURN');
  await expect(detail.getByTestId('reply-send')).toBeEnabled(); // the new opening is not left "busy"
  await expect(page.getByTestId('action-result')).toHaveCount(0);
  await expect(detail.getByTestId('hand-back')).toHaveCount(0); // "hand back" belongs to the opening that replied
  expect(w.comments.get('gigleai/cavil-loop#138')!.map((c) => c.bodyHTML)).toEqual(['<p>OLD_MESSAGE_SENT</p>']);

  // within one opening, a newer call of the same kind wins: [detail] the re-read after a change vs. a slow refresh, [preview] typing after asking
  w.bodies.set('gigleai/cavil-loop#138', '<p>BODY_REFRESH_OLD</p>');
  const releaseRefresh = holdFirst((e) => e.operation === 'CavilItemDetail' && e.variables?.number === 138);
  await detail.getByTestId('detail-refresh').click();
  await expect.poll(() => env.fake.log.filter((l) => l.operation === 'CavilItemDetail' && l.variables?.number === 138).at(-1)?.status).toBe(0);
  w.bodies.set('gigleai/cavil-loop#138', '<p>BODY_REFRESH_NEW</p>');
  // a change made meanwhile re-reads the detail: that newer read must win
  await pickLabel(page, 'pending/PR');
  await expect(page.getByTestId('action-result')).toContainText('pending/PR');
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
  await expect(page.getByTestId('board-action-result')).toContainText('GigleAI/cavil-loop#138：已加上标签「Done」');
  await expect(detail.getByTestId('reply-input')).toHaveValue('DRAFT_AFTER_REOPEN');
  await expect(page.getByTestId('action-result')).toHaveCount(0);
  await shot(page, '30-round-trip');
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
  await expect(page.getByTestId('search')).toHaveValue('-label:Done -status:Done');
  const server = filterResults.find((r) => r.query === '-label:Done -status:Done')!.server;
  const iter = rawIteration();
  const want: Record<string, number> = {};
  for (const k of server) want[iter.get(k)!] = (want[iter.get(k)!] ?? 0) + 1;
  await expect.poll(() => groupCounts(page)).toEqual(want);
  const rows = await page.$$eval('[data-testid="row"]', (rs) => rs.map((r) => r.getAttribute('data-key')!));
  expect([...rows].sort()).toEqual(server);
  await expect(page.getByTestId('filter-unsupported')).toHaveCount(0);
  await shot(page, '10-table-imported');
  // a row's title opens the same detail panel as a card on the board (#138)
  await page.locator(`[data-testid="row"][data-key="${rows[0]}"] [data-testid="row-title"]`).click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', rows[0]);
  await page.getByTestId('detail-close').click();
  await expect(page.getByTestId('detail')).toHaveCount(0);

  // search: GitHub syntax, and Chinese in the middle of a word
  await page.getByTestId('search').fill('label:pending/human');
  await expect.poll(async () => (await page.$$eval('[data-testid="row"]', (rs) => rs.length))).toBe(
    filterResults.find((r) => r.query === 'label:pending/human')!.server.length,
  );
  await page.getByTestId('search').fill('客户端');
  await expect.poll(async () => (await page.$$eval('[data-testid="row"]', (rs) => rs.length))).toBeGreaterThan(
    filterResults.find((r) => r.query === '客户端')!.server.length,
  );

  // words this client does not support: a yellow bar naming them, never "0 results"
  await page.getByTestId('search').fill('label:pending/human updated:>2026-01-01 priority:High');
  await expect(page.getByTestId('filter-unsupported')).toContainText('updated:>2026-01-01');
  await expect(page.getByTestId('filter-unsupported')).toContainText('priority:High');
  await expect.poll(async () => (await page.$$eval('[data-testid="row"]', (rs) => rs.length))).toBe(
    filterResults.find((r) => r.query === 'label:pending/human')!.server.length,
  );
  await shot(page, '11-unsupported-words');
  // a Chinese custom field is named and ignored too, not searched as text
  await page.getByTestId('search').fill('优先级:高 label:pending/human');
  await expect(page.getByTestId('filter-unsupported')).toContainText('优先级:高');
  await expect.poll(async () => (await page.$$eval('[data-testid="row"]', (rs) => rs.length))).toBe(
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
  await expect.poll(() => groupCounts(page)).toEqual(Object.fromEntries(Object.entries(rawCountByStatus())));
  await shot(page, '12-table-custom');
  await page.waitForTimeout(500); // the search box saves 300 ms after typing stops
  await app.close();

  ({ app, page } = await launch(env));
  await expect(page.getByTestId('table')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('search')).toHaveValue('');
  await expect.poll(() => groupCounts(page)).toEqual(Object.fromEntries(Object.entries(rawCountByStatus())));
  await expect(page.getByTestId('slices')).toBeVisible();
  await expect(page.locator('table.items th')).not.toContainText(['标签']);
  await app.close();
});

function rawCountByStatus(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of loadCavilProjectPages())
    for (const n of p.items.nodes) {
      const v = n.fieldValues.nodes.find((x: any) => x.field?.name === 'Status');
      const k = v ? v.name : '无状态';
      out[k] = (out[k] ?? 0) + 1;
    }
  return out;
}

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
  // (near the start of the line: the middle of it may be the "在网页上看" link)
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
}

/** the saved search text as the main process holds it (the box saves 300 ms after typing stops) */
const savedQuery = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).state.view.query as string);

/** a copy of the recorded Project whose only saved web view uses `filter` */
function projectWithView(filter: string) {
  return loadCavilProjectPages().map((p: any) => ({ ...p, views: { nodes: [{ ...p.views.nodes[1], number: 1, filter }] } }));
}

const P11 = 'org/gigleai/11';
const sourceErr = (page: Page, key: string) => page.locator(`[data-testid="source-row"][data-key="${key}"] .err`);

test('yellow bars: × closes one bar; time passing and page switches keep it closed; another failure, recovery, or a new filter shows it again', async () => {
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
  await expect(page.getByTestId('search')).toHaveValue('-label:Done -status:Done', { timeout: 15_000 });
  const key = (await page.evaluate(async () => (await (window as any).cavil.get()).state.sources[0].key)) as string;

  // a source fails: two bars (the filter is on); × closes only the one clicked
  env.fake.state.failProjectPage.set(P11, 1);
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('incomplete')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('filter-incomplete')).toBeVisible();
  await expect(page.getByTestId('incomplete-close')).toHaveAccessibleName('关闭提示');
  await shot(page, '14-bars-with-close');
  await page.getByTestId('incomplete-close').click();
  await expect(page.getByTestId('incomplete')).toHaveCount(0);
  await expect(page.getByTestId('filter-incomplete')).toBeVisible();

  // only time passes: the wording ("… 分钟前") changes, the problem does not → stays closed
  for (const step of ['00:15', '01:00', '59:00']) { // 15 s, 1 min, then past 1 h in all
    await page.clock.fastForward(step);
    await page.waitForTimeout(100);
  }
  await expect(page.getByTestId('sync-status')).toContainText('上次同步 1 小时前'); // the window's clock really moved
  await expect(page.getByTestId('incomplete')).toHaveCount(0);
  await expect(page.getByTestId('filter-incomplete')).toBeVisible();

  // board → settings → board: stays closed
  await page.getByTestId('open-settings').click();
  await page.getByTestId('back').click();
  await expect(page.getByTestId('filter-incomplete')).toBeVisible();
  await expect(page.getByTestId('incomplete')).toHaveCount(0);

  // "filter may be incomplete": closed → filter cleared (the bar is gone, so is the record) → filtering again → back
  await page.getByTestId('filter-incomplete-close').click();
  await expect(page.getByTestId('filter-incomplete')).toHaveCount(0);
  await page.getByTestId('search').fill('label:x');
  await expect(page.getByTestId('filter-incomplete')).toHaveCount(0); // other words, same failure: still closed
  await page.getByTestId('search').fill('');
  await page.getByTestId('search').fill('-label:Done -status:Done');
  await expect(page.getByTestId('filter-incomplete')).toBeVisible();
  await expect(page.getByTestId('incomplete')).toHaveCount(0);

  // recovers, then fails the same way again → shows again
  env.fake.state.failProjectPage.clear();
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('filter-incomplete')).toHaveCount(0, { timeout: 15_000 }); // the round really recovered
  env.fake.state.failProjectPage.set(P11, 1);
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('incomplete')).toBeVisible({ timeout: 15_000 });

  // closed, then recovers and fails again while the settings page is up → shows again back on the board
  await page.getByTestId('incomplete-close').click();
  await expect(page.getByTestId('incomplete')).toHaveCount(0);
  await page.getByTestId('open-settings').click();
  await expect(sourceErr(page, key)).toBeVisible();
  env.fake.state.failProjectPage.clear();
  await page.getByTestId('source-input').fill('GigleAI/cavil-loop'); // adding a source starts a round
  await page.getByTestId('source-add').click();
  await expect(sourceErr(page, key)).toHaveCount(0, { timeout: 15_000 });
  env.fake.state.failProjectPage.set(P11, 1);
  await page.locator('[data-testid="source-row"][data-key="repo:gigleai/cavil-loop"] [data-testid="source-remove"]').click();
  await page.getByTestId('source-input').fill('GigleAI/cavil-loop');
  await page.getByTestId('source-add').click();
  await expect(sourceErr(page, key)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('back').click();
  await expect(page.getByTestId('incomplete')).toBeVisible();
  await shot(page, '15-bar-back-after-recovery');
  await app.close();
});

test('yellow bars: a closed "unsupported words" bar comes back when an import in settings changes the filter and changes it back', async () => {
  env.fake.state.projects.set('org/gigleai/21', projectWithView('updated:>2026-01-01'));
  env.fake.state.projects.set('org/gigleai/22', projectWithView('-label:Done'));
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
  await expect.poll(() => savedQuery(page), { timeout: 15_000 }).toBe('-label:Done');
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
  await page.getByTestId('open-settings').click();
  for (const s of sources) {
    await page.getByTestId('source-input').fill(s);
    await page.getByTestId('source-add').click();
  }
}

test('pending/human: start-up summary, one notification per new label at the next beat, badge, label setting, a click opens the item', async () => {
  const { app, page } = await launch(env);
  await signInForReminders(page, [PROJECT_URL, 'GigleAI/cavil-loop']);

  // expected numbers come from the recording itself (re-recorded by record.mjs, never typed in)
  const pendingInRecording = new Set<string>();
  for (const pg of loadCavilProjectPages())
    for (const n of pg.items.nodes)
      if (!n.isArchived && n.content?.labels?.nodes.some((l: any) => l.name === 'pending/human'))
        pendingInRecording.add(`${n.content.repository.nameWithOwner.toLowerCase()}#${n.content.number}`);
  for (const i of env.fake.state.repos.get('gigleai/cavil-loop')!)
    if (i.labels.some((l: any) => (l.name ?? l) === 'pending/human')) pendingInRecording.add(`gigleai/cavil-loop#${i.number}`);
  const N = pendingInRecording.size;
  expect(N).toBeGreaterThan(0);
  // a merged PR without the label, only on the board
  const mergedPr = loadCavilProjectPages()
    .flatMap((pg) => pg.items.nodes)
    .find((n: any) => n.content?.__typename === 'PullRequest' && n.content.merged && !n.content.labels.nodes.some((l: any) => l.name === 'pending/human'))!.content.number;
  await expect(page.getByTestId('pending-count')).toHaveText(String(N), { timeout: 15_000 });
  const notes = () => app.desktop.records.filter((a) => a.op === 'notify').map((a) => a.alert);
  const badge = () => app.desktop.records.filter((a) => a.op === 'badge').pop()?.count;
  await expect.poll(() => notes().length).toBeGreaterThan(0);
  expect(notes().filter((a) => a.kind === 'item')).toEqual([]);
  expect(notes().filter((a) => a.kind === 'summary').map((a) => a.title)).toContain(`${N} 条待处理`);
  expect(badge()).toBe(N);
  await expect(page.getByTestId('launch-at-login')).not.toBeChecked();
  // the box follows what the system says, not the click: it turns on once the system answered
  await page.getByTestId('launch-at-login').click();
  await expect.poll(() => app.desktop.records.filter((a) => a.op === 'loginItem').map((a) => a.on)).toEqual([true]);
  await expect(page.getByTestId('launch-at-login')).toBeChecked();
  await shot(page, '20-pending-settings');

  // a merged PR gets the label on GitHub → exactly one notification at the next beat from the shell
  for (const pg of env.fake.state.projects.get('org/gigleai/11')!)
    for (const n of pg.items.nodes)
      if (n.content?.number === mergedPr) {
        n.content.labels = { nodes: [...n.content.labels.nodes, { name: 'pending/human', color: 'ededed' }] };
        n.content.updatedAt = new Date().toISOString();
      }
  await page.getByTestId('back').click();
  app.desktop.push({ kind: 'tick' });
  await expect.poll(() => notes().filter((a) => a.kind === 'item').map((a) => a.key)).toEqual([`gigleai/cavil-loop#${mergedPr}`]);
  const itemNote = notes().find((a) => a.kind === 'item');
  expect(itemNote.title).toContain('已合并');
  await expect.poll(badge).toBe(N + 1);
  app.desktop.push({ kind: 'tick' });
  await page.waitForTimeout(800);
  expect(notes().filter((a) => a.kind === 'item')).toHaveLength(1);

  // a click on that notification opens the item in the app (also from the settings page)
  await page.getByTestId('open-settings').click();
  app.desktop.push({ kind: 'open', key: itemNote.key, url: itemNote.url });
  await expect(page.getByTestId('detail')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('detail')).toContainText(`#${mergedPr}`);
  await shot(page, '22-notification-click');
  // closed, then the settings page and back: an old click never reopens it
  await page.getByTestId('detail-close').click();
  await expect(page.getByTestId('detail')).toHaveCount(0);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('back').click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('detail')).toHaveCount(0);

  // another label name: recounted, nothing notified
  await page.getByTestId('open-settings').click();
  // the reminder label is the same setting as the "hand back to agent" one
  await page.getByTestId('hand-back-human').fill('doing/agent');
  await page.getByTestId('hand-back-human').blur();
  await expect(page.getByTestId('pending-label')).toHaveText('doing/agent');
  await expect(page.getByTestId('pending-count')).not.toHaveText(String(N + 1));
  const count = Number(await page.getByTestId('pending-count').textContent());
  await expect.poll(badge).toBe(count);
  expect(notes().filter((a) => a.kind === 'item')).toHaveLength(1);
  await app.close();
});

test('notifications refused by the system: the board says so and how to allow them', async () => {
  const { app, page } = await launch(env);
  app.desktop.refuse = 'Notifications are not allowed for this application';
  await signInForReminders(page, [PROJECT_URL]);
  // the start-up summary was sent (and refused)
  await expect.poll(() => app.desktop.records.filter((a) => a.op === 'notify').length, { timeout: 15_000 }).toBe(1);
  await expect(page.getByTestId('notify-problem')).toContainText('系统设置 → 通知 → Cavil Loop');
  await page.getByTestId('back').click();
  await expect(page.getByTestId('board-notify-problem')).toContainText('Notifications are not allowed');
  await shot(page, '21-notify-refused');
  // like every yellow bar (GitHub#153): × closes it, and the same refusal again does not bring it back
  await page.getByTestId('board-notify-problem-close').click();
  await expect(page.getByTestId('board-notify-problem')).toHaveCount(0);
  // one more item gets the label: a second notification, refused for the same reason
  const another = env.fake.state.projects
    .get('org/gigleai/11')!
    .flatMap((pg) => pg.items.nodes)
    .find((n: any) => !n.isArchived && n.content?.__typename === 'Issue' && !n.content.labels.nodes.some((l: any) => l.name === 'pending/human'))!;
  another.content.labels = { nodes: [...another.content.labels.nodes, { name: 'pending/human', color: 'ededed' }] };
  another.content.updatedAt = new Date().toISOString();
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
    expect(await badge.evaluate((el) => getComputedStyle(el).fontSize), r.why).toBe('13px');
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
  await expect(page.getByTestId('detail-error')).toBeVisible({ timeout: 15_000 });
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
      if (acc[3] < 1) acc = over(acc, matchMedia('(prefers-color-scheme: dark)').matches ? [13, 17, 23, 1] : [255, 255, 255, 1]);
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
    for (const row of document.querySelectorAll('.hdr, .vbar')) {
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
  expect(r.rows, `${where}: both header rows are there`).toBe(2);
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
  await app.close();
});

test('GitHub#181 many sources: at 1024 and 1280 px every source in the top bar can be reached with the wheel, is readable, and really switches what the board shows', async () => {
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

  const strip = page.getByTestId('source-pick');
  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await headerFits(page, `board, ${width} px, 20 sources`);
    // the strip really overflows here, so this is not "everything fits anyway"
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth), `${width} px: strip overflows`).toBe(true);
    await strip.evaluate((el) => (el.scrollLeft = 0));

    for (const [k, name] of [names[names.length - 1], names[10]].entries()) {
      const key = `repo:${name.toLowerCase()}`;
      const chip = strip.locator('label.src-chip', { has: page.locator(`input[data-key="${key}"]`) });
      // a plain mouse wheel over the strip, as a user without a trackpad would do, until the chip is fully in view
      const box = (await strip.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 40; i++) {
        const inView = await chip.evaluate((c) => {
          const s = c.parentElement!.getBoundingClientRect();
          const r = c.getBoundingClientRect();
          return r.left >= s.left - 0.5 && r.right <= s.right + 0.5;
        });
        if (inView) break;
        await page.mouse.wheel(0, k === 0 ? 120 : -120);
        await page.waitForTimeout(30);
      }
      // fully inside the strip, the name readable (not squeezed away), and the checkbox is what a click there hits
      const seen = await chip.evaluate((c) => {
        const s = c.parentElement!.getBoundingClientRect();
        const r = c.getBoundingClientRect();
        const input = c.querySelector('input')!.getBoundingClientRect();
        const hit = document.elementFromPoint(input.left + input.width / 2, input.top + input.height / 2);
        const nameEl = c.querySelector('.src-name') as HTMLElement;
        return {
          inside: r.left >= s.left - 0.5 && r.right <= s.right + 0.5,
          hitsOwnBox: hit === c.querySelector('input'),
          nameWidth: nameEl.getBoundingClientRect().width,
          nameText: nameEl.textContent,
        };
      });
      expect(seen.inside, `${width} px: ${name} scrolled into view with the wheel`).toBe(true);
      expect(seen.hitsOwnBox, `${width} px: a click on ${name}'s box hits that box`).toBe(true);
      expect(seen.nameText).toBe(name);
      expect(seen.nameWidth, `${width} px: ${name}'s name is not squeezed away`).toBeGreaterThan(100);

      // a real click switches the source off and on again, and the board follows
      const box2 = (await chip.locator('input').boundingBox())!;
      await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
      await expect(chip.locator('input')).not.toBeChecked();
      await expect(total).toHaveText('19 个条目');
      await expect(page.getByText(`item from ${name}`)).toHaveCount(0);
      await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
      await expect(chip.locator('input')).toBeChecked();
      await expect(total).toHaveText('20 个条目');
    }
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
  await expect(hide).toHaveAttribute('title', '收起（Esc；回复框里有没发出的文字时 Esc 不收起；点过讨论后，先点一下讨论以外的地方再按 Esc）');
  await expect(page.getByTestId('close-issue')).toHaveText('关闭 issue…');
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
  await expect(page.getByTestId('action-result')).toHaveAttribute('data-kind', 'ok');
  await expect(page.getByTestId('action-result')).toHaveText('issue #137 已关闭（不计划）');
  expect(writes()).toEqual([
    ['PATCH', '/api/repos/GigleAI/cavil-loop/issues/137', { state: 'closed', state_reason: 'not_planned' }],
    ['POST', '/api/repos/GigleAI/cavil-loop/issues/137/comments', { body: '不做了' }],
  ]);
  // badge, card and table row all grey (GitHub: not planned), and the close entry is gone
  await expect(badge).toHaveAttribute('data-tone', 'neutral');
  await expect(badge).toHaveText('Issue·已关闭（不计划）');
  await expect(card(page, 137).getByTestId('card-state')).toHaveAttribute('data-tone', 'neutral');
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
  await expect(page.getByTestId('action-result')).toHaveText('issue #139 已关闭（已完成）');
  expect(writes().slice(2)).toEqual([['PATCH', '/api/repos/GigleAI/cavil-loop/issues/139', { state: 'closed', state_reason: 'completed' }]]);
  await expect(badge).toHaveAttribute('data-tone', 'done');
  await hide.click();

  // ---- 5. offline: the close entry greys out, nothing sent ----
  openOnGitHub(139);
  await page.getByTestId('refresh').click();
  await open(139);
  await expect(page.getByTestId('close-issue')).toBeEnabled();
  const before = env.fake.writes().length;
  env.fake.state.offline = true;
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('close-issue')).toBeDisabled();
  await expect(page.getByTestId('close-issue')).toHaveAttribute('title', '离线时不能修改');
  expect(env.fake.writes()).toHaveLength(before);
  await app.close();
});

// ---- GitHub#192: keyboard shortcuts. Keys are pressed in the real window; what counts is what
// the screen shows and what the fake GitHub received. Ctrl stands for ⌘ off macOS (both work). ----
const MOD = 'ControlOrMeta';
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const lastOnline = (page: Page) => page.evaluate(async () => (await (window as any).cavil.get()).state.sync.lastOnlineAt as number | null);

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
    'search', 'newIssue', 'sync', 'settings', 'help', 'confirm', 'cancel', 'labels', 'milestone', 'reply', 'hide',
    'send', 'preview', 'leaveReply', 'pickerUp', 'pickerDown', 'pickerToggle', 'pickerClose', 'helpClose',
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
  expect(env.fake.writes().filter((w) => w.method === 'POST' && w.path === '/api/repos/GigleAI/cavil-loop/issues').map((w) => (w.body as { title?: string } | undefined)?.title)).toEqual(['KEYS_NEW']);
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
  await shot(page, '61-settings-after-keys');
  // the earlier "/" and "C" were done once: back on the board (by the button), nothing repeats
  await page.getByTestId('back').click();
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
  await expect(page.getByTestId('action-result')).toHaveText('评论已发出');
  expect(writes()).toEqual([['POST', '/api/repos/GigleAI/cavil-loop/issues/137/comments', { body: 'lmc/?r' }]]);
  await expect(reply).toHaveValue('');
  await reply.fill('   ');
  await page.keyboard.press(`${MOD}+Enter`);
  await page.waitForTimeout(500);
  expect(writes()).toHaveLength(1);
  await expect(page.getByTestId('action-result')).toHaveAttribute('data-kind', 'ok'); // no "empty comment" refusal either
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
  expect(writes().slice(before)).toEqual([['POST', '/api/repos/GigleAI/cavil-loop/issues/137/labels', { labels: ['pending/PR'] }]]);
  expect(await active()).toBe('pending/PR');
  await page.keyboard.press('Enter');
  await expect(picker.locator('[data-name="pending/PR"]')).toHaveAttribute('data-checked', 'no', { timeout: 15_000 });
  expect(writes().slice(before)).toEqual([
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
  await expect(page.getByTestId('action-result')).toHaveText('里程碑改成「v1」');
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
  await expect(page.getByTestId('action-result')).toHaveText('issue #137 已关闭（已完成）');
  expect(writes().slice(n)).toEqual([['PATCH', '/api/repos/GigleAI/cavil-loop/issues/137', { state: 'closed', state_reason: 'completed' }]]);
  await app.close();
});
