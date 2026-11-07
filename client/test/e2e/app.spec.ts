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
import { TASK_CHANGED as TASK_CHANGED193 } from '../../src/data/actions';

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

  // a source that fails mid-pagination keeps last round's data; the ⚠️ next to refresh says so (GitHub#248)
  env.fake.state.failProjectPage.set('org/gigleai/11', 1);
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('sync-trouble')).toBeVisible();
  expect(await countOf(page, 'Iteration 25')).toBe('12');
  await page.getByTestId('sync-trouble').click();
  await expect(page.getByTestId('sync-trouble-source')).toContainText('读取失败');
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
  await expect(page.getByTestId('action-result')).toContainText('已交给 agent');
  await expect(card(page, 138).locator('.label', { hasText: 'pending/agent' })).toBeVisible();
  await expect(card(page, 138).locator('.label', { hasText: 'pending/human' })).toHaveCount(0);
  await page.getByTestId('detail-close').click();

  // ---- drag a card to another iteration: only that Project's value changes ----
  const before137 = writes().length;
  await card(page, 137).dragTo(page.locator('[data-testid="column"][data-title="Iteration 26"]'));
  await expect(page.getByTestId('board-action-result')).toHaveAttribute('data-kind', 'ok');
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

  // ---- new issue: labels from the picker (GitHub's colours), joins the Project ticked in the dialog (GitHub#205) ----
  await page.getByTestId('write-entry').click();
  await page.getByTestId('new-issue-title').fill('客户端里建的 issue');
  await page.getByTestId('new-issue-body').fill('正文');
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
  expect(writes().at(-1)?.[0]).toBe('CavilAddProjectItem');
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

  // 2. images (GitHub#205): GitHub's own hosts are requested (and shown); the others are not even tried, and the entry says so
  await expect(frame.locator('[data-blocked]')).toHaveAttribute('data-blocked', '3');
  // (every request the window made outside its own bridge; the app's page policy is what stops the rest)
  const reqs = () => (existsSync(env.requests) ? readFileSync(env.requests, 'utf8') : '');
  for (const u of [
    'https://github.com/GigleAI/cavil-loop/raw/main/probe.png',
    'https://camo.githubusercontent.com/probe-138',
    'https://private-user-images.githubusercontent.com/probe.png?jwt=x',
    'https://user-images.githubusercontent.com/probe-old.png',
  ])
    await expect.poll(reqs).toContain(`request ${u}\n`);
  for (const alt of ['via proxy', 'attachment', 'old attachment', 'on github'])
    await expect.poll(() => frame.locator(`img[alt="${alt}"]`).evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  const seen = reqs();
  // look-alikes, raw files, the storage behind attachments: never even asked
  expect(seen).not.toContain('evil.example');
  expect(seen).not.toContain('raw.githubusercontent.com');
  expect(seen).not.toContain('amazonaws.com');
  expect(seen.split('\n').filter((l) => l && !/^request https:\/\/((api\.)?github\.com|(avatars|private-user-images|user-images|camo)\.githubusercontent\.com)\//.test(l))).toEqual([]);
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
  // the next complete round brings it
  await round();
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
    await expect(page.getByTestId('action-result')).toHaveAttribute('data-kind', ok ? 'ok' : 'error');
    await expect(frame.locator('body')).toContainText(`BODY_AFTER_CHANGE_${tag}`); // the read after the change, both ways
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
  await expect(page.getByTestId('action-result')).toHaveAttribute('data-kind', 'ok');
  await expect(frame.locator('body')).toContainText('BODY_DURING_WRITE');
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
  await expect.poll(() => savedQuery(page), { timeout: 15_000 }).toBe('-label:Done -status:Done');
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
  expect(heads['GigleAI/cavil-loop']).toBe(cavRows.length - 1);
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
  await expect(page.getByTestId('search')).toHaveValue('-label:Done -status:Done', { timeout: 15_000 });

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
  await expect(page.getByTestId('sync-status')).toContainText('上次同步 1 小时前'); // the window's clock really moved
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
  await expect(page.getByTestId('search')).toHaveValue('-label:Done -status:Done', { timeout: 15_000 });
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
  // a narrow window hides the "上次同步" text; the ⚠️ and its details stay on screen
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
  await page.getByTestId('match-count').click();
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
// history (no summary, no notification, not unread); closed / merged items never remind; the
// settings page no longer lists or counts what is pending.
test('pending/human: nothing about the history at start, one notification per new open label at the next beat, none for a merged PR, badge, label setting, a click opens the item', async () => {
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
  await expect(page.getByTestId('pending-settings')).toContainText('已关闭、已合并的不提醒');
  await expect(page.getByTestId('pending-label')).toHaveText('pending/human');
  for (const gone of ['pending-list', 'pending-item', 'pending-count', 'unread-count', 'pending-breakdown']) await expect(page.getByTestId(gone)).toHaveCount(0);
  await expect(page.getByTestId('launch-at-login')).not.toBeChecked();
  // the box follows what the system says, not the click: it turns on once the system answered
  await page.getByTestId('launch-at-login').click();
  await expect.poll(() => app.desktop.records.filter((a) => a.op === 'loginItem').map((a) => a.on)).toEqual([true]);
  await expect(page.getByTestId('launch-at-login')).toBeChecked();
  await shot(page, '20-pending-settings');

  // a merged PR and an open issue get the label on GitHub → exactly one notification, the open one's, at the next beat
  putPending(mergedPr);
  putPending(fresh);
  await page.getByTestId('back').click();
  app.desktop.push({ kind: 'tick' });
  await expect.poll(() => notes().filter((a) => a.kind === 'item').map((a) => a.key)).toEqual([`gigleai/cavil-loop#${fresh}`]);
  const itemNote = notes().find((a) => a.kind === 'item');
  expect(itemNote.title).toBe(`待处理：GigleAI/cavil-loop#${fresh}`);
  await expect.poll(badge).toBe(1);
  // "did happen": that round read the merged PR with its label
  await page.getByTestId('search').fill(`#${mergedPr}`);
  if (await page.getByTestId('ended-group').count()) await page.getByTestId('ended-group').click();
  await expect(card(page, mergedPr).locator('.label', { hasText: 'pending/human' })).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('search').fill('');
  app.desktop.push({ kind: 'tick' });
  await page.waitForTimeout(800);
  expect(notes()).toHaveLength(1);

  // a click on that notification opens the item in the app (also from the settings page)
  await page.getByTestId('open-settings').click();
  app.desktop.push({ kind: 'open', key: itemNote.key, url: itemNote.url });
  await expect(page.getByTestId('detail')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('detail')).toContainText(`#${fresh}`);
  await shot(page, '22-notification-click');
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
  expect(badge()).toBeLessThanOrEqual(1);
  expect(notes()).toHaveLength(1);

  // the user switches to the window (the shell reports the focus): the badge cleared, then the
  // delivered notifications taken back
  const before = app.desktop.records.length;
  app.desktop.push({ kind: 'active' });
  await expect.poll(() => app.desktop.records.slice(before).map((r) => (r.op === 'badge' ? `badge ${r.count}` : r.op))).toEqual(['badge 0', 'clearNotifications']);
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
  await expect(hide).toHaveAttribute('title', '收起（或点面板以外的地方、按 Esc；回复框里有没发出的文字时都不收起；点过讨论后，先点一下讨论以外的地方再按 Esc）');
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
  await page.locator('.hdr').click({ position: { x: 4, y: 4 } });
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
  // a table cell that is not a title is outside too
  await page.locator('[data-testid="row"][data-key="gigleai/cavil-loop#139"] [data-testid="row-state"]').first().click();
  await expect(detail).toHaveCount(0);

  expect(env.fake.writes()).toEqual([]);
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
  await expect(page.getByTestId('action-result')).toHaveText('已勾上，GitHub 上已更新');
  const ticked = QUESTION193.replace('- [ ] **A.', '- [x] **A.');
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
  await expect(page.getByTestId('action-result')).toHaveAttribute('data-kind', 'error');
  await expect(page.getByTestId('action-result')).toHaveText(TASK_CHANGED193);
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
  await expect(page.getByTestId('action-result')).toHaveText('已取消勾选，GitHub 上已更新');
  expect(env.fake.writes()).toHaveLength(2);
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

  // group heads: kept in view while their rows scroll, tinted, with a bar in front
  const head = page.getByTestId('group-head').first().locator('td');
  expect(await head.evaluate((td) => getComputedStyle(td).position)).toBe('sticky');
  expect(await head.evaluate((td) => getComputedStyle(td).boxShadow)).toContain('inset');
  await shot(page, '205-01-table-groups');

  // labels: a click on the cell opens the picker; one click = one add, sent at once
  const before = writes().length;
  await row.locator('[data-testid="cell"][data-col="labels"]').click();
  await row.locator('[data-testid="cell-label-picker"] [data-testid="picker-item"][data-name="Done"]').click();
  await expect(page.getByTestId('board-action-result')).toContainText('GigleAI/cavil-loop#138：已加上标签「Done」');
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
  await expect(page.getByTestId('board-action-result')).toContainText('状态已改');
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
  await page.locator('[data-testid="source-pick"] input[data-key^="repo:"]').uncheck();
  await page.getByTestId('write-entry').click();
  await expect(page.getByTestId('new-issue-project')).toBeChecked();
  await page.getByTestId('new-issue-title').fill('只进仓库的 issue');
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
  await page.locator('[data-testid="source-pick"] input[data-key^="repo:"]').check();
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
  await expect(page.getByTestId('action-result')).toContainText('已托管');
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
  await expect(page.getByTestId('action-result')).toContainText('评论已保存');
  expect(writes().slice(b2)).toEqual([['CavilUpdateComment', '/api/graphql', { id: 'C_MINE', body: '改过的文字' }]]);
  await expect(frame.locator('details.entry[data-entry="C_MINE"]')).toContainText('改过的文字');
  // somebody changed it on the web while it was being edited: refused, the typed text stays in the box, theirs on GitHub
  await frame.locator('details.entry[data-entry="C_MINE"] button[data-edit]').click();
  w.comments.get('gigleai/cavil-loop#138')!.find((c) => c.id === 'C_MINE')!.body = '别人刚改的';
  await page.getByTestId('edit-input').fill('我的新版本');
  const digest = env.fake.digest();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('edit-result')).toContainText('被别人改过');
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
    await expect(page.getByTestId('board-action-result')).toContainText(`GigleAI/cavil-loop#138：已加上标签「${label}」`);
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
  await expect(line(PROJECT_KEY)).toHaveAttribute('data-applies', 'yes');
  await expect(line(PROJECT_KEY)).toContainText('状态 = In progress');
  // what a status group sets is said right under the board boxes (GitHub#231)
  await expect(page.getByTestId('new-issue-projects').getByTestId('new-issue-preset')).toHaveAttribute('data-place', 'boards');
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
    await expect(line('milestone')).toHaveAttribute('data-applies', 'yes');
    // now the first read of A answers
    release();
    await page.waitForTimeout(500);
    await expect(line('milestone')).toHaveAttribute('data-applies', 'yes');
    await expect(page.getByTestId('new-issue-preset')).toHaveAttribute('data-blocked', 'no');
    await expect(page.getByTestId('confirm-ok')).toBeEnabled();
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
  const issue = detail.locator('[data-testid="edit-issue"][data-field="label"]');
  await expect(issue).toHaveAttribute('data-edit', 'failed');
  await expect(issue.getByTestId('edit-target')).toContainText('加上「pending/PR」');
  await expect(card(page, 139).getByTestId('card-edit-flag')).toBeVisible();
  await expect(page.getByTestId('edits-bar')).toHaveAttribute('data-count', '1');
  await shot(page, '229-04-label-not-saved');
  env.fake.state.w.failLabel = null;
  const posts = () => env.fake.writes().filter((w) => w.method === 'POST' && w.path.endsWith('/issues/139/labels')).length;
  const p0 = posts();
  await issue.getByTestId('edit-resend').click();
  await expect(detail.getByTestId('edit-issues')).toHaveCount(0);
  await expect(detail.locator('[data-testid="detail-label"][data-label="pending/PR"]')).toBeVisible();
  // shown at once ("saving"), then confirmed: the mark goes once GitHub answered and it was read back
  await expect.poll(() => posts()).toBe(p0 + 1);
  await expect(detail.locator('[data-testid="detail-label"][data-label="pending/PR"]')).toHaveAttribute('data-edit', '');
  await expect(page.getByTestId('edits-bar')).toHaveCount(0);

  // ⑤ no answer for a milestone, somebody sets another one meanwhile: the resend is held ("overwrite anyway")
  env.fake.state.w.dropWrites = true;
  await detail.getByTestId('milestone-select').selectOption('v9');
  const ms = detail.locator('[data-testid="edit-issue"][data-field="milestone"]');
  await expect(ms).toHaveAttribute('data-edit', 'unconfirmed');
  env.fake.state.w.dropWrites = false;
  milestoneOnGitHub(139, { number: 10, title: 'v10' });
  const patches = () => env.fake.writes().filter((w) => w.method === 'PATCH' && w.path.endsWith('/issues/139')).length;
  const m0 = patches();
  await ms.getByTestId('edit-resend').click();
  await expect(ms.getByTestId('edit-hold')).toContainText('你改之后有人改成了「v10」');
  await expect(ms.getByTestId('edit-github')).toContainText('v10');
  await expect(ms.getByTestId('edit-force')).toHaveText('仍然覆盖');
  expect(patches()).toBe(m0);
  await shot(page, '229-05-held-resend');
  await ms.getByTestId('edit-force').click();
  await expect(detail.getByTestId('edit-issues')).toHaveCount(0);
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
  await expect(quick.getByTestId('autopilot')).toHaveText('托管（自动合并）…');
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
  await expect(page.getByTestId('action-result')).toContainText('已托管');
  const autopilotWrites = (n: number) => [
    ['POST', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels`, { labels: ['autopilot'] }],
    ['POST', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels`, { labels: ['pending/agent'] }],
    ['DELETE', `/api/repos/GigleAI/cavil-loop/issues/${n}/labels/pending%2Fhuman`, undefined],
  ];
  expect(writes().slice(b1)).toEqual(autopilotWrites(138));
  await page.getByTestId('detail-close').click();
  // another item: the button has no "…", one click writes, no dialog
  await card(page, 139).click();
  await expect(quick.getByTestId('autopilot')).toHaveText('托管（自动合并）');
  const b2 = writes().length;
  await quick.getByTestId('autopilot').click();
  await expect(page.getByTestId('action-result')).toContainText('已托管');
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
  await page.locator('[data-testid="source-pick"] input[data-key^="project:"]').uncheck();
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
  await page.locator('[data-testid="source-pick"] input[data-key^="project:"]').check();
  await page.locator('[data-testid="row"][data-key="gigleai/cavil-loop#137"] [data-testid="row-title"]').first().click();
  await expect(page.getByTestId('detail').locator('.reply .row.end').getByTestId('autopilot')).toHaveText('托管（自动合并）…');
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
  await page.evaluate(() => (window as any).cavil.syncNow());
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

test('GitHub#245: new issue — hand to the agent / autopilot when creating; the choice is remembered; unknown labels are "cannot read", never "has none"', async () => {
  let { app, page } = await launch(env);
  await signInWithSources(page);
  const w = env.fake.state.w;
  const REPO_KEY = 'gigleai/cavil-loop';
  w.repoLabels.set(REPO_KEY, ['bug', 'autopilot', 'pending/agent', 'pending/human'].map((name) => ({ name, color: 'ededed' })));
  const choice = (h: string) => page.locator(`[data-testid="new-issue-handoff-choice"][data-choice="${h}"]`);
  const handoff = page.getByTestId('new-issue-handoff');
  const creates = () => writes().filter((x) => x[0] === 'POST' && x[1] === '/api/repos/GigleAI/cavil-loop/issues').map((x) => x[2]);
  const open = async () => {
    await page.getByTestId('write-entry').click();
    await expect(page.getByTestId('new-issue')).toBeVisible();
  };
  const createAndClose = async (title: string) => {
    await page.getByTestId('new-issue-title').fill(title);
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    await page.getByTestId('detail-close').click();
  };

  // ---- 1. first time: "只建 issue"; the plain request is exactly as before ----
  await open();
  await expect(choice('none')).toBeChecked();
  await expect(choice('agent')).toBeEnabled();
  await expect(choice('autopilot')).toBeEnabled();
  await expect(page.getByTestId('new-issue-handoff-summary')).toHaveCount(0);
  await createAndClose('普通');
  expect(creates()).toEqual([{ title: '普通', body: '', labels: [] }]);

  // ---- 2. autopilot: said what happens; one create request with both labels; remembered ----
  await open();
  await choice('autopilot').check();
  await expect(page.getByTestId('new-issue-handoff-summary')).toContainText('会加上标签「autopilot」和「pending/agent」');
  await expect(page.getByTestId('new-issue-handoff-summary')).toContainText('要叫停，在网页上去掉「autopilot」');
  await shot(page, '245-01-new-issue-autopilot');
  await createAndClose('托管的');
  expect(creates().at(-1)).toEqual({ title: '托管的', body: '', labels: ['autopilot', 'pending/agent'] });
  await open();
  await expect(choice('autopilot')).toBeChecked();
  // ---- 3. changed, then cancelled: not remembered ----
  await choice('agent').check();
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await open();
  await expect(choice('autopilot')).toBeChecked();
  await page.getByTestId('confirm-cancel').click();

  // ---- 4. the label list cannot be read: "读不到", never "没有标签"; a plain issue does not overwrite the choice ----
  w.failLabels.add(REPO_KEY);
  await open();
  await expect(handoff).toHaveAttribute('data-handoff', 'none');
  await expect(handoff).toHaveAttribute('data-wanted', 'autopilot');
  await expect(choice('none')).toBeChecked();
  await expect(choice('autopilot')).toBeDisabled();
  await expect(choice('agent')).toBeDisabled();
  await expect(page.getByTestId('new-issue-handoff-fallback')).toContainText('读不到仓库 GigleAI/cavil-loop 的标签');
  await expect(page.getByTestId('new-issue-handoff-fallback')).toContainText('记住的选项不变');
  await expect(handoff).not.toContainText('没有标签');
  await shot(page, '245-02-new-issue-labels-unreadable');
  await createAndClose('读不到标签时建的');
  expect(creates().at(-1)).toEqual({ title: '读不到标签时建的', body: '', labels: [] });
  w.failLabels.delete(REPO_KEY);
  await open();
  await expect(choice('autopilot')).toBeChecked();
  await page.getByTestId('confirm-cancel').click();

  // ---- 5. the repository really lacks the label: that choice cannot be picked; the fallback keeps the choice too ----
  w.repoLabels.set(REPO_KEY, ['bug', 'pending/agent'].map((name) => ({ name, color: 'ededed' })));
  await open();
  await expect(choice('autopilot')).toBeDisabled();
  await expect(choice('agent')).toBeEnabled();
  await expect(choice('none')).toBeChecked();
  await expect(page.getByTestId('new-issue-handoff-fallback')).toHaveAttribute('data-reason', 'missing');
  await expect(page.getByTestId('new-issue-handoff-fallback')).toContainText('仓库 GigleAI/cavil-loop 没有标签「autopilot」');
  await expect(page.getByTestId('new-issue-handoff-fallback')).toContainText('记住的「托管（自动合并）」不变');
  await createAndClose('缺标签时建的');
  expect(creates().at(-1)).toEqual({ title: '缺标签时建的', body: '', labels: [] });
  // picked by hand here: "交给 agent" is used and remembered
  await open();
  await choice('agent').check();
  await expect(page.getByTestId('new-issue-handoff-why')).toContainText('没有标签「autopilot」');
  await createAndClose('交给 agent 的');
  expect(creates().at(-1)).toEqual({ title: '交给 agent 的', body: '', labels: ['pending/agent'] });

  // ---- 6. still reading: the remembered choice stays, creating waits until the labels are in ----
  w.repoLabels.set(REPO_KEY, ['bug', 'autopilot', 'pending/agent'].map((name) => ({ name, color: 'ededed' })));
  const release = env.fake.hold('/labels');
  await open();
  await expect(choice('agent')).toBeChecked();
  await page.getByTestId('new-issue-title').fill('等标签');
  await expect(page.getByTestId('new-issue-handoff-wait')).toContainText('正在读取仓库 GigleAI/cavil-loop 的标签');
  await expect(page.getByTestId('confirm-ok')).toBeDisabled();
  // the web page waits the same way (PR #249 review round 1): no page opened without the hand-over labels
  await page.getByTestId('new-issue-body').fill('看图');
  await pasteImage(page, '[data-testid="new-issue-body"]');
  const openedBefore = existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '';
  await expect(page.getByTestId('paste-image-web')).toBeDisabled();
  await page.getByTestId('paste-image-web').click({ force: true });
  await page.waitForTimeout(300);
  expect(existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '').toBe(openedBefore);
  release();
  await expect(page.getByTestId('confirm-ok')).toBeEnabled();
  await expect(choice('agent')).toBeChecked();
  // read: the web page gets the same labels as the create request would
  await expect(page.getByTestId('paste-image-web')).toBeEnabled();
  await page.getByTestId('paste-image-web').click();
  await expect.poll(() => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '')).toContain('&labels=pending%2Fagent\n');
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

  // ---- 7. remembered across a restart; the table group's "+" uses the same choice ----
  await app.close();
  ({ app, page } = await launch(env));
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-testid="layout"] button[data-value="table"]').click();
  await page.getByTestId('open-view-panel').click();
  await page.getByTestId('group-by').selectOption('status');
  const add = page.locator('[data-testid="group"][data-title="In progress"]').getByTestId('group-add');
  await expect(add).toBeEnabled({ timeout: 15_000 });
  await add.click();
  await expect(choice('agent')).toBeChecked();
  await page.getByTestId('new-issue-title').fill('组里交给 agent');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  // the dialog closes before GitHub answers (GitHub#229): wait for the request
  await expect.poll(() => creates().at(-1)).toEqual({ title: '组里交给 agent', body: '', labels: ['pending/agent'] });

  // ---- 8. no autopilot label in Settings: no "托管" choice; a remembered autopilot falls back without being lost ----
  await page.getByTestId('detail-close').click();
  await page.getByTestId('open-settings').click();
  await page.getByTestId('hand-back-autopilot').fill('');
  await page.getByTestId('hand-back-autopilot').blur();
  await page.getByTestId('back').click();
  await open();
  await expect(choice('autopilot')).toHaveCount(0);
  await expect(choice('agent')).toBeChecked();
  await page.getByTestId('confirm-cancel').click();
  await app.close();
});
