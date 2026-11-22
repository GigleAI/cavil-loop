// GigleAI/cavil-loop#680: mermaid diagrams in the discussion. The real window (built with --test-bridge), the real
// back end behind the loopback bridge, the local fake GitHub, which hands out GitHub's real rendering of a mermaid
// block and a GeoJSON block (test/fixtures/github-enrichment.html: a placeholder with a "Loading" spinner that
// only GitHub's web page fills). The window draws the diagram with the mermaid it ships, in its hidden helper
// frame, and the discussion shows it as a picture: no "Loading" left, the source folded under it; a source
// mermaid cannot read says so and shows the source; a diagram asked again (same source, same theme) is not drawn
// again; the dark theme draws its own; the reply preview shows the picture too. The helper frame runs scripts
// only, reaches neither the window nor the network.

import { test, expect, type Frame, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const N = 139;
const KEY = `gigleai/cavil-loop#${N}`;
const GH = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github-enrichment.html'), 'utf8');
/** the same placeholder with a source mermaid cannot read */
const BAD = GH.replace(/(<pre lang="mermaid"[^>]*>)[\s\S]*?(<\/pre>)/, '$1flowchart LR\n  A[x] -- &gt; \n$2');
const url = (c: string) => `https://github.com/${REPO}/issues/${N}#issuecomment-${c}`;

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(closeEngine);

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
  await page.getByTestId('back').click();
  await page.keyboard.press('Control+Shift+2');
}

async function helperOf(page: Page): Promise<Frame> {
  return (await page.getByTestId('diagram-helper').elementHandle())!.contentFrame() as Promise<Frame>;
}

test('GitHub#680: a mermaid diagram is drawn on this machine and shown as a picture; a broken one shows its source; drawn once per theme; the preview too; the helper reaches nothing', async () => {
  env.fake.state.w.comments.set(KEY, [
    { id: 'C-bad', url: url('1'), createdAt: '2026-11-02T00:00:00Z', bodyHTML: BAD, author: { login: 'user-3' } },
    { id: 'C-old', url: url('2'), createdAt: '2026-11-02T01:00:00Z', bodyHTML: GH, author: { login: 'user-4' } },
    { id: 'C-new', url: url('3'), createdAt: '2026-11-02T02:00:00Z', bodyHTML: GH, author: { login: 'user-4' } },
  ]);
  const { page } = await launchApp(env);
  await page.emulateMedia({ colorScheme: 'light' });
  await signIn(page);
  const row = page.locator(`[data-testid="row"][data-key="${KEY}"] [data-testid="title-cell"]`).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  const detail = page.getByTestId('detail');
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  const frame = page.frameLocator('[data-testid="timeline-frame"]');
  const entry = (id: string) => frame.locator(`details.entry[data-entry="${id}"]`);

  // ---- 1. the newest entry (unfolded): the picture, the source folded under it, the map as a code block ----
  const pic = entry('C-new').locator('img.mmdimg');
  await expect(pic).toBeVisible({ timeout: 30_000 });
  expect(await pic.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0 && i.naturalHeight > 0)).toBe(true);
  expect(await pic.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
  await expect(entry('C-new').locator('.mmdbox')).toHaveCount(0);
  await expect(entry('C-new').locator('details.mmdsrc')).not.toHaveAttribute('open', /.*/);
  await expect(entry('C-new').locator('details.mmdsrc summary')).toHaveText('流程图原文');
  await expect(entry('C-new').locator('.enrich')).toContainText('这类图只在 GitHub 网页上显示');
  await expect(entry('C-new').locator('pre[lang="geojson"]')).toContainText('"Point"');
  await expect(frame.locator('body')).not.toContainText('Loading');

  // ---- 2. the helper: scripts only, one drawing so far, and it reaches neither the window nor the network ----
  await expect(page.getByTestId('diagram-helper')).toHaveAttribute('sandbox', 'allow-scripts');
  const helper = await helperOf(page);
  await expect.poll(() => helper.evaluate(() => document.body.getAttribute('data-drawn'))).toBe('1');
  const reach = await helper.evaluate(async () => {
    let win = 'blocked';
    try {
      void (parent as Window).document.title;
      win = 'reached';
    } catch {
      /* another origin */
    }
    let net = 'blocked';
    try {
      // the app's own file, the one address this frame loaded a script from
      await fetch((document.querySelector('script') as HTMLScriptElement).src);
      net = 'reached';
    } catch {
      /* refused by its policy */
    }
    return { win, net, origin: location.origin };
  });
  expect(reach).toEqual({ win: 'blocked', net: 'blocked', origin: 'null' });

  // ---- 3. all unfolded: the same source is not drawn again; the broken one says so, links out, shows its source ----
  await detail.getByTestId('unfold-toggle').click();
  await expect(entry('C-old').locator('img.mmdimg')).toBeVisible({ timeout: 30_000 });
  expect(await entry('C-old').locator('img.mmdimg').getAttribute('src')).toBe(await pic.getAttribute('src'));
  const failed = entry('C-bad').locator('.mmdbox[data-state="failed"]');
  await expect(failed).toContainText('这张流程图没画出来（写法有误），下面是原文', { timeout: 30_000 });
  await expect(failed.locator('a.mmdweb')).toHaveAttribute('href', url('1'));
  await expect(entry('C-bad').locator('details.mmdsrc')).toHaveAttribute('open', '');
  await expect(entry('C-bad').locator('details.mmdsrc pre')).toContainText('A[x] -- >');
  await expect(entry('C-bad').locator('img.mmdimg')).toHaveCount(0);
  await expect.poll(() => helper.evaluate(() => document.body.getAttribute('data-drawn'))).toBe('2');
  await page.waitForTimeout(500);
  expect(await helper.evaluate(() => document.body.getAttribute('data-drawn'))).toBe('2');

  // ---- 4. dark: drawn again for the dark theme (two sources), a different picture ----
  const light = await pic.getAttribute('src');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => helper.evaluate(() => document.body.getAttribute('data-drawn')), { timeout: 30_000 }).toBe('4');
  await expect(entry('C-new').locator('img.mmdimg')).toBeVisible({ timeout: 30_000 });
  const dark = await entry('C-new').locator('img.mmdimg').getAttribute('src');
  expect(dark).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(dark).not.toBe(light);

  // ---- 5. the reply preview: the picture (already drawn for this theme: nothing drawn again) ----
  env.fake.state.w.markdownHtml = GH;
  await detail.getByTestId('reply-input').fill('看图');
  await detail.getByTestId('reply-preview-toggle').click();
  const preview = page.frameLocator('[data-testid="reply-preview"]');
  await expect(preview.locator('img.mmdimg')).toBeVisible({ timeout: 30_000 });
  expect(await preview.locator('img.mmdimg').getAttribute('src')).toBe(dark);
  await expect(preview.locator('body')).not.toContainText('Loading');
  expect(await helper.evaluate(() => document.body.getAttribute('data-drawn'))).toBe('4');
});
