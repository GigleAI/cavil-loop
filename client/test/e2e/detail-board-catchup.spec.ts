// GigleAI/cavil-loop#726: the detail shows an item GitHub changed after the board read it → the list row
// follows at once (one re-read of the item), not at the next sync round; the panel's own label strip,
// taken from the board's copy, follows with it.
// The real window (built with --test-bridge), the real back end behind the loopback bridge, the local fake GitHub.

import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeGitHub } from '../fake-github/server';
import { findCopies } from '../fake-github/writes';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const REPO = 'GigleAI/cavil-loop';
const K = (n: number) => `gigleai/cavil-loop#${n}`;
/** a recorded issue, made sure open */
const A = 139;

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
  change({ title: 'old title', state: 'open', labels: [] });
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(closeEngine);

/** change A on GitHub (every copy the fake holds), moving its update time like GitHub does */
function change(p: { title: string; state: 'open' | 'closed'; labels: string[] }) {
  const c = findCopies(env.fake.state, REPO, A)!;
  const when = new Date().toISOString();
  for (const r of c.rest) Object.assign(r, { title: p.title, state: p.state, state_reason: p.state === 'closed' ? 'completed' : null, labels: p.labels.map((name) => ({ name, color: 'ededed' })), updated_at: when });
  for (const g of c.gql)
    Object.assign(g, { title: p.title, state: p.state === 'open' ? 'OPEN' : 'CLOSED', stateReason: p.state === 'closed' ? 'COMPLETED' : null, labels: { nodes: p.labels.map((name) => ({ name, color: 'ededed' })) }, updatedAt: when });
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
  await page.getByTestId('source-input').fill(REPO);
  await page.getByTestId('source-add').click();
  await page.getByTestId('back').click();
  await page.keyboard.press('Control+Shift+2');
  await expect(row(page)).toBeVisible({ timeout: 20_000 });
}

const row = (page: Page) => page.locator(`[data-testid="row"][data-key="${K(A)}"] [data-testid="title-cell"]`).first();
const detail = (page: Page) => page.getByTestId('detail');
const rounds = () => env.fake.log.filter((l) => l.method === 'GET' && l.path.startsWith(`/api/repos/${REPO}/issues?`) && l.path.includes('state=open')).length;
const itemReads = () => env.fake.log.filter((l) => l.operation === 'CavilItemRefresh' && (l.variables as any)?.number === A).length;

test('GitHub#726: opening an item GitHub changed since the board read it brings its row up to date at once — title, closed, labels', async () => {
  const app = await launchApp(env);
  const page = app.page;
  await signIn(page);
  await expect(row(page)).toContainText('old title');
  change({ title: 'new title', state: 'closed', labels: ['pending/human'] });
  const r0 = rounds();
  await row(page).click();
  await expect(detail(page)).toHaveAttribute('data-key', K(A));
  // the row follows the detail, well before the 60 s round
  await expect(row(page)).toContainText('new title', { timeout: 10_000 });
  await expect(detail(page).getByText('pending/human').first()).toBeVisible();
  expect(itemReads()).toBe(1);
  expect(rounds()).toBe(r0);
  await app.close();
});
