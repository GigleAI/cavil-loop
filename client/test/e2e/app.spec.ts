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
  await detail.getByTestId('label-add').selectOption('Done');
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
  const pull = env.fake.state.w.pulls.get(`gigleai/cavil-loop#${prN}`)!;
  const seen = pull.headOid;
  pull.headOid = 'f'.repeat(40); // somebody pushed after the detail was read
  const digest = env.fake.digest();
  await page.getByTestId('merge').click();
  await expect(page.getByTestId('merge-commit')).toContainText(seen.slice(0, 7));
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('action-result')).toHaveAttribute('data-kind', 'error');
  await expect(page.getByTestId('action-result')).toContainText('新提交');
  expect(env.fake.digest()).toBe(digest);
  await shot(page, '24-merge-refused');
  await page.getByTestId('detail-refresh').click();
  await expect(page.getByTestId('pr-status')).toContainText('fffffff');
  await page.getByTestId('merge').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('action-result')).toContainText('已合并');
  await expect(card(page, prN).getByTestId('card-state')).toContainText('已合并');
  expect(env.fake.writes().filter((w) => w.path.endsWith('/merge')).map((w) => w.body)).toEqual([
    { merge_method: 'merge', sha: seen },
    { merge_method: 'merge', sha: 'f'.repeat(40) },
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
  await page.getByTestId('label-add').selectOption('Done');
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
  await expect(detail.getByTestId('label-add').locator('option', { hasText: 'NEW_LABEL' })).toHaveCount(1);
  releaseDetail();
  releaseLabels();
  await expect.poll(() => env.fake.log.filter((l) => l.operation === 'CavilItemDetail' && l.variables?.number === 138).every((l) => l.status === 200)).toBe(true);
  await page.waitForTimeout(300);
  await expect(frame.locator('body')).toContainText('BODY_NEW'); // [detail] old read did not land
  await expect(detail.getByTestId('label-add').locator('option', { hasText: 'NEW_LABEL' })).toHaveCount(1); // [options] old list did not land

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
  await detail.getByTestId('label-add').selectOption('pending/PR');
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
  await detail.getByTestId('label-add').selectOption('Done');
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
  await expect.poll(() => (existsSync(env.requests) ? readFileSync(env.requests, 'utf8') : '')).toMatch(/request https:\/\/avatars\.githubusercontent\.com\/[^?]+\?s=32\n/);

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
  await expect(detail).toHaveAttribute('data-width', '760');
  expect(await page.locator('.board').boundingBox()).toEqual(boardBefore);
  await shot(page, '41-detail-wider');
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await card(page, 137).click();
  await expect(detail).toHaveAttribute('data-width', '760');
  // a narrow window leaves a strip of the board uncovered; the kept width comes back when it is wide again
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(detail).toHaveAttribute('data-width', '680');
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(detail).toHaveAttribute('data-width', '760');
  // Esc while typing a reply does not close the panel (and so does not drop the draft)
  await detail.getByTestId('reply-input').fill('草稿');
  await detail.getByTestId('reply-input').press('Escape');
  await expect(detail).toHaveAttribute('data-key', 'gigleai/cavil-loop#137');
  await app.close();

  // a restart: the same width
  ({ app, page } = await launch(env));
  await expect(card(page, 138)).toBeVisible({ timeout: 15_000 });
  await card(page, 138).click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-width', '760');
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
  await expect(page.locator('.statusbar')).toContainText('上次同步 1 小时前'); // the window's clock really moved
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
  await page.getByTestId('label-add').selectOption('Done');
  await expect.poll(() => env.fake.log.some((l) => l.method === 'POST' && l.path.endsWith('/issues/138/labels'))).toBe(true);
  await expect(card(page, 138).locator('.label', { hasText: 'Done' })).toBeVisible();
  await expect(page.locator('[data-testid="sync-problem"]')).toHaveCount(0);
  expect(errors).toEqual([]);
  await shot(page, '40-old-engine');
  await app.close();
});
