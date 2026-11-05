// UI tests: the real Electron app (built dist/), driven by Playwright,
// talking to the local fake GitHub over loopback. Screenshots of each step
// land in test-results/screens/ (uploaded by CI).

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub, loadCavilProjectPages, type FakeGitHub } from '../fake-github/server';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';

interface Env {
  fake: FakeGitHub;
  userData: string;
  cred: string;
  opened: string;
}

async function launch(env: Env): Promise<{ app: ElectronApplication; page: Page }> {
  const args = [root];
  if (process.platform === 'linux') {
    args.unshift('--no-sandbox');
    if (!process.env.DISPLAY) args.unshift('--ozone-platform=headless');
  }
  const app = await electron.launch({
    args,
    env: {
      ...process.env,
      CAVIL_CLIENT_TEST_MODE: '1',
      CAVIL_CLIENT_TEST_API: env.fake.api,
      CAVIL_CLIENT_TEST_WEB: env.fake.web,
      CAVIL_CLIENT_TEST_CREDENTIAL_FILE: env.cred,
      CAVIL_CLIENT_TEST_OPENED_FILE: env.opened,
      CAVIL_CLIENT_USER_DATA: env.userData,
    },
  });
  current = app;
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForSelector('[data-testid="app-root"]');
  return { app, page };
}

let current: ElectronApplication | null = null;
async function shot(page: Page, name: string) {
  await page.waitForTimeout(150);
  try {
    await page.screenshot({ path: join(screens, `${name}.png`) });
  } catch {
    // headless Linux without a display: capture from the main process instead
    const png = await current!.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'),
    );
    writeFileSync(join(screens, `${name}.png`), Buffer.from(png, 'base64'));
  }
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
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
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
  await expect.poll(() => countOf(page, 'Iteration 25'), { timeout: 15_000 }).toBe('12');
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
  await expect(frame.locator('article')).toHaveCount(3);
  expect(await frame.locator('article').evaluateAll((els) => els.map((e) => e.getAttribute('data-entry')))).toEqual(['C-new', 'C-old', expect.stringMatching(/^I_/)]);
  await shot(page, '20-detail-newest-first');
  // a link in GitHub's HTML opens the system browser; the frame itself never navigates
  await frame.locator('a', { hasText: 'link' }).click();
  await expect.poll(() => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8') : '')).toContain('https://github.com/GigleAI/cavil-loop\n');
  await expect(frame.locator('article')).toHaveCount(3);

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
  await expect(frame.locator('article').first()).toContainText('看过了');
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
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('detail')).toHaveAttribute('data-key', 'gigleai/cavil-loop#140');
  expect(writes().filter((w) => w[0] === 'POST' && w[1] === '/api/repos/GigleAI/cavil-loop/issues')).toEqual([
    ['POST', '/api/repos/GigleAI/cavil-loop/issues', { title: '客户端里建的 issue', body: '正文', labels: ['pending/human'] }],
  ]);
  await expect(card(page, 140)).toBeVisible();

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
