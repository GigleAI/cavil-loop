// GigleAI/cavil-loop#475: the screenshots in docs/client-screens/ (the client's user guide,
// docs/client.md / docs/client.zh.md, and the client section of both READMEs).
//
// Not a test: it only runs with CAVIL_DOC_SHOTS=1 and writes the pictures; every other run skips it.
//   cd client && CAVIL_DOC_SHOTS=1 npm run test:e2e -- doc-screenshots
// The window is the real one (dist/renderer-test) on the real back end, fed by the fake GitHub with
// the board and relations recorded from the public cavil project (test/fixtures/), so the pictures
// show no private repository and need no sign-in of anybody's. 1280 × 800, one pixel per pixel.
// Re-run it after a change people can see, and commit the pictures it writes.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelationIssues, loadRelationPages, startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, '..', 'docs', 'client-screens');

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const BOARD = 'org/gigleai/11';
const REPO = 'GigleAI/cavil-loop';

test.skip(process.env.CAVIL_DOC_SHOTS !== '1', 'writes the user-guide screenshots; run with CAVIL_DOC_SHOTS=1');

const dirs: string[] = [];
async function newEnv(fake: Awaited<ReturnType<typeof startFakeGitHub>>): Promise<AppEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-docshots-'));
  dirs.push(dir);
  return { fake, userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
}
test.beforeAll(() => mkdirSync(out, { recursive: true }));
test.afterAll(async () => {
  await closeEngine();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function shot(page: Page, name: string) {
  // let avatars, fonts and the graph's layout settle
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, `${name}.png`) });
}

const layout = (page: Page, v: 'board' | 'table' | 'graph') => page.locator(`[data-testid="layout"] button[data-value="${v}"]`).click();

/** start the window as on a Mac (key caps say ⌘), sign in, add the recorded Project and the repository */
async function start(env: AppEnv, search: string, settingsShot?: string) {
  const app = await launchApp(env);
  const { page } = app;
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await page.reload();
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
  await expect(page.getByTestId('source-row')).toHaveCount(2);
  if (settingsShot) await shot(page, settingsShot);
  await page.getByTestId('back').click();
  // adding the Project imports its saved web view: wait for it, then set ours (its filter only hid finished
  // items, so since GitHub#464 the box stays empty and the import is seen on the view settings instead)
  await expect.poll(() => page.evaluate(async () => (await (window as any).cavil.get()).state.view.imported?.viewNumber ?? null), { timeout: 15_000 }).toBe(1);
  await page.getByTestId('search').fill(search);
  await expect
    .poll(() => page.evaluate(async () => ((await (window as any).cavil.get()).state.sync.sources as { ok: boolean }[]).map((s) => s.ok)), { timeout: 20_000 })
    .toEqual([true, true]);
  return app;
}

test('user-guide screenshots: board, table, detail, settings', async () => {
  const env = await newEnv(await startFakeGitHub());
  const { page, close } = await start(env, 'is:open', 'settings-sources');
  await layout(page, 'board');
  // the recorded iterations have all ended by now: columns by status show the board as people use it
  await page.getByTestId('mode').selectOption('status');
  await expect(page.locator('[data-testid="card"]').first()).toBeVisible();
  await shot(page, 'board');

  await layout(page, 'table');
  await shot(page, 'table');

  // the floating detail panel over the board
  await layout(page, 'board');
  await page.locator('[data-testid="card"]').first().click();
  await expect(page.getByTestId('detail')).toBeVisible();
  await shot(page, 'detail');
  await close();
  await env.fake.close();
});

test('user-guide screenshots: dependency graph', async () => {
  const env = await newEnv(await startFakeGitHub({ projects: new Map([[BOARD, loadRelationPages()]]), repos: new Map([['gigleai/cavil-loop', loadRelationIssues()]]) }));
  const { page, close } = await start(env, '');
  await layout(page, 'graph');
  await expect(page.getByTestId('graph')).toBeVisible();
  await shot(page, 'graph');
  await close();
  await env.fake.close();
});
