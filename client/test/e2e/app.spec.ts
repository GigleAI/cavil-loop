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
  await expect(page.getByTestId('slice-count')).toHaveText(['144']);
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
  const order = await page.$$eval('[data-testid="column"][data-title="Done"] [data-testid="card"]', (cs) => cs.map((c) => c.getAttribute('data-key')!));
  expect(order.length).toBeGreaterThan(10);
  const ts = order.map((k) => updated.get(k)!);
  expect(ts).toEqual([...ts].sort().reverse());
  await shot(page, '13-board-imported-sort');
  await app.close();
});
