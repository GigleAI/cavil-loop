// GigleAI/cavil-loop#590: a web link clicked in the detail goes to the system browser because the page itself hands
// it to the window — never through the webview's "open a new window" request, which on macOS never reached the
// shell. The real window (built with --test-bridge), the real back end behind the loopback bridge, the local fake
// GitHub. The back end's opener records each address, and a link handed on by a frame also gets a line saying
// which frame (`frame-link <url>` / `preview-link <url>`): only the window's check of the message's source, then
// the back end's `openLink`, can write it.

import { test, expect, type Frame, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeGitHub } from '../fake-github/server';
import { launchApp, closeEngine, type AppEnv } from './bridge';

const PROJECT_URL = 'https://github.com/orgs/GigleAI/projects/11';
const REPO = 'GigleAI/cavil-loop';
const N = 139;
const KEY = `gigleai/cavil-loop#${N}`;

const GH = 'https://github.com/GigleAI/cavil-loop/pull/7';
const SITE = 'https://example.com/docs?a=1';
const META = 'https://example.com/meta';
const CTRL = 'https://example.com/ctrl';
const MIDDLE = 'https://example.com/middle';
const PREVIEW = 'https://example.com/preview';

const BODY =
  `<p>links: <a id="gh" href="${GH}">pr</a> <a id="site" href="${SITE.replace('&', '&amp;')}">docs</a> ` +
  `<a id="meta" href="${META}">meta</a> <a id="ctrl" href="${CTRL}">ctrl</a> <a id="middle" href="${MIDDLE}">middle</a></p>` +
  '<p>not web: <a id="mail" href="mailto:someone@example.com">mail</a> <a id="js" href="javascript:void(0)">js</a> ' +
  '<a id="fn" href="#fn-1">1</a></p><div style="height:3000px"></div><p id="fn-1">footnote</p>';

let env: AppEnv;
test.beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cavil-e2e-'));
  env = { fake: await startFakeGitHub(), userData: join(dir, 'userData'), cred: join(dir, 'cred'), opened: join(dir, 'opened.txt'), requests: join(dir, 'requests.txt') };
});
test.afterEach(async () => {
  await env.fake.close();
});
test.afterAll(closeEngine);

const lines = () => (existsSync(env.opened) ? readFileSync(env.opened, 'utf8').split('\n').filter(Boolean) : []);
const times = (line: string) => lines().filter((l) => l === line).length;

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

async function frameOf(page: Page, testid: string): Promise<Frame> {
  return (await page.getByTestId(testid).elementHandle())!.contentFrame() as Promise<Frame>;
}

/** clicked once in the given frame: recorded with its source, opened exactly once, never through the shell */
async function handedOn(url: string, via: 'frame' | 'preview') {
  await expect.poll(() => times(`${via}-link ${url}`), { timeout: 10_000 }).toBe(1);
  expect(times(url)).toBe(1);
  expect(lines().filter((l) => l.startsWith('shell-') && l.endsWith(` ${url}`))).toEqual([]);
}

test('GitHub#590: web links in the discussion and the reply preview are handed to the browser by the page itself; other links and other senders are not', async () => {
  env.fake.state.w.comments.set(KEY, [
    { id: 'C-links', url: `https://github.com/${REPO}/issues/${N}#c1`, createdAt: '2026-11-02T01:00:00Z', bodyHTML: BODY, author: { login: 'user-3' } },
  ]);
  const { page } = await launchApp(env);
  await signIn(page);
  const row = page.locator(`[data-testid="row"][data-key="${KEY}"] [data-testid="title-cell"]`).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  const detail = page.getByTestId('detail');
  await expect(detail).toBeVisible();
  await expect(page.getByTestId('timeline-frame')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  const frame = await frameOf(page, 'timeline-frame');
  const appUrl = page.url();

  // a GitHub link and a link to another site: plain click
  await frame.locator('#gh').click();
  await handedOn(GH, 'frame');
  await frame.locator('#site').click();
  await handedOn(SITE, 'frame');
  // ⌘ + click (macOS), Ctrl + click (Windows / Linux), the middle button
  await frame.locator('#meta').click({ modifiers: ['Meta'] });
  await handedOn(META, 'frame');
  await frame.locator('#ctrl').click({ modifiers: ['Control'] });
  await handedOn(CTRL, 'frame');
  await frame.locator('#middle').click({ button: 'middle' });
  await handedOn(MIDDLE, 'frame');

  // not web addresses: nothing reaches the browser; a place on the page (a footnote) is scrolled to
  const before = lines().length;
  await frame.locator('#mail').click();
  await frame.locator('#js').click();
  expect(await frame.evaluate(() => window.scrollY)).toBe(0);
  await frame.locator('#fn').click();
  await expect.poll(() => frame.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
  // the window itself (not the frame) saying "link": dropped
  await page.evaluate(() => window.postMessage({ cavil: 'link', url: 'https://example.com/forged-window' }, '*'));
  // the frame saying "link" with something that is not a web address: dropped
  await frame.evaluate(() => parent.postMessage({ cavil: 'link', url: 'file:///etc/passwd', render: document.body.getAttribute('data-render') }, '*'));
  // reachability: a web link clicked after them is still handed on, and nothing else came before it
  await frame.locator('#gh').click();
  await expect.poll(() => lines().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(before + 2);
  await page.waitForTimeout(500); // anything late from the earlier clicks would land by now
  expect(lines().slice(before)).toEqual([`frame-link ${GH}`, GH]);
  expect(page.url()).toBe(appUrl);

  // the reply preview
  // GitHub's rendering of the typed text (the fake answers the markdown request with it)
  env.fake.state.w.markdownHtml = `<p>see <a href="${PREVIEW}">the preview link</a></p>`;
  await detail.getByTestId('reply-input').fill(`see [the preview link](${PREVIEW})`);
  await detail.getByTestId('reply-preview-toggle').click();
  const previewEl = page.getByTestId('reply-preview');
  await expect(page.frameLocator('[data-testid="reply-preview"]').locator('body')).toContainText('the preview link', { timeout: 15_000 });
  await expect(page.frameLocator('[data-testid="reply-preview"]').locator('a')).toHaveAttribute('href', PREVIEW);
  const preview = await frameOf(page, 'reply-preview');
  // it may say "link" only: anything else it posts is dropped — here "edit the description", which the
  // discussion frame may say (checked last, so it proves the message would have been acted on)
  const bodyEntry = await frame.evaluate(() => document.querySelector('details.entry.body')?.getAttribute('data-entry') ?? '');
  expect(bodyEntry).not.toBe('');
  const render = await frame.evaluate(() => document.body.getAttribute('data-render'));
  await preview.evaluate(([e, r]) => parent.postMessage({ cavil: 'edit', entry: e, render: r }, '*'), [bodyEntry, render]);
  await preview.locator('a').click();
  await handedOn(PREVIEW, 'preview');
  await expect(previewEl).toBeVisible();
  await expect(detail.getByTestId('edit-input')).toHaveCount(0);
  expect(page.url()).toBe(appUrl);
  // the same message from the discussion frame does open the editor
  await frame.evaluate(([e, r]) => parent.postMessage({ cavil: 'edit', entry: e, render: r }, '*'), [bodyEntry, render]);
  await expect(detail.getByTestId('edit-input')).toHaveCount(1);
});
