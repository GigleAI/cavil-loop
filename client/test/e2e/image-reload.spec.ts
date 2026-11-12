// GitHub#395: images of the discussion that did not load, and release attachment images, in the
// real frame document (timelineDocument, the app's sandbox) under the real window policy
// (tauri.conf.json) — in a real browser, without the app around it. The page plays the window's
// part: it records what the frame reports and answers "image" the way a test says.
//
// Nothing here leaves the machine: a release attachment image has no `src` at all (that is the
// point), and the ordinary image that fails is a broken data: address.
import { test, expect, chromium, webkit, type Browser, type Page, type Frame } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { appCsp } from './bridge';
import { escapeHtml, timelineDocument, TIMELINE_SANDBOX } from '../../src/renderer/detailHtml';
import type { ItemDetail } from '../../src/shared/actions';

const WEB = 'https://github.com';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const rel = (file: string) => `${WEB}/acme/app/releases/download/v1/${file}`;
const linked = (file: string, alt: string) => `<p><a target="_blank" rel="noopener noreferrer" href="${rel(file)}"><img src="${rel(file)}" alt="${alt}" style="max-width: 100%;"></a></p>`;

const detail: ItemDetail = {
  key: 'o/r#1',
  repo: 'o/r',
  number: 1,
  kind: 'pr',
  title: 't',
  url: 'https://github.com/o/r/pull/1',
  state: 'open',
  pr: null,
  fetchedAt: 0,
  labels: [],
  timeline: [
    {
      kind: 'comment',
      id: 'C_NEW',
      url: '',
      author: 'a',
      at: '2026-11-02T00:00:00Z',
      bodyHtml:
        linked('home.png', '首页截图') +
        linked('denied.png', '错题本截图') +
        linked('limited.png', '知识图谱截图') +
        `<p><img src="${PNG}" alt="好图"></p>` +
        '<p><img src="data:image/png;base64,xx" alt="坏图"></p>',
    },
    { kind: 'comment', id: 'C_OLD', url: '', author: 'b', at: '2026-11-01T00:00:00Z', bodyHtml: linked('old.png', '旧评论里的图') },
  ],
};

let browser: Browser;
let server: http.Server;
let frameDoc = '';
test.beforeAll(async () => {
  browser = await (process.env.CAVIL_E2E_ENGINE === 'chromium' ? chromium : webkit).launch();
  server = http.createServer((req, res) => {
    if (req.url === '/window.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      // the window's part: record every report; answer "image" from `plan[src]` (one answer per ask, in order)
      return res.end(`
        window.got = []; window.plan = {};
        window.addEventListener('message', function (e) {
          var m = e.data; if (!m || !m.cavil) return;
          window.got.push(m);
          if (m.cavil !== 'image') return;
          var a = (window.plan[m.src] || []).shift(); if (!a) return;
          var out = { cavil: 'image', render: m.render, id: m.id }; for (var k in a) out[k] = a[k];
          document.querySelector('iframe').contentWindow.postMessage(out, '*');
        });`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': appCsp("'self'") });
    res.end(`<!doctype html><script src="/window.js"></script><iframe sandbox="${TIMELINE_SANDBOX}" style="width:640px;height:700px" srcdoc="${escapeHtml(frameDoc)}"></iframe>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});
test.afterAll(async () => {
  server.close();
  await browser.close();
});

async function open(doc: string): Promise<{ p: Page; f: Frame }> {
  frameDoc = doc;
  const p = await browser.newPage();
  await p.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  const f = p.frames().find((x) => x !== p.mainFrame())!;
  await f.waitForLoadState();
  await expect.poll(() => p.evaluate(() => (window as any).got.some((m: any) => m.cavil === 'ready'))).toBe(true);
  return { p, f };
}
const asked = (p: Page) => p.evaluate(() => (window as any).got.filter((m: any) => m.cavil === 'image').map((m: any) => m.src as string));
const plan = (p: Page, src: string, ...answers: object[]) => p.evaluate(([s, a]) => (((window as any).plan[s as string] ??= []) as object[]).push(...(a as object[])), [src, answers] as const);
const box = (f: Frame, alt: string) => f.locator('.imgbox', { has: f.locator('.alt', { hasText: alt }) });

test('GitHub#395: a release attachment image is never fetched by the frame; the window is asked, entry by entry as they are unfolded', async () => {
  const doc = timelineDocument(detail, false, 'latest', { render: 'r1', web: WEB });
  // nothing in the document points an image at a release address
  expect(doc).not.toMatch(/<img[^>]*\ssrc="https:\/\/github\.com\/acme\/app\/releases\/download/);
  const { p, f } = await open(doc);
  // the unfolded entry's three, in order; the folded entry's not yet
  await expect.poll(() => asked(p)).toEqual([rel('home.png'), rel('denied.png'), rel('limited.png')]);
  await expect(box(f, '首页截图')).toHaveAttribute('data-state', 'loading');
  await expect(box(f, '首页截图').locator('.why')).toHaveText('正在用登录信息取图…');
  await expect(box(f, '首页截图').locator('button')).toHaveCount(0);
  await f.locator('details.entry[data-entry="C_OLD"] > summary').click({ position: { x: 40, y: 10 } });
  await expect.poll(() => asked(p)).toEqual([rel('home.png'), rel('denied.png'), rel('limited.png'), rel('old.png')]);
  // unfolding it again asks nothing new
  await f.locator('details.entry[data-entry="C_OLD"] > summary').click({ position: { x: 40, y: 10 } });
  await f.locator('details.entry[data-entry="C_OLD"] > summary').click({ position: { x: 40, y: 10 } });
  await p.waitForTimeout(300);
  expect(await asked(p)).toHaveLength(4);
  await p.close();
});

test('GitHub#395: the answer is shown — the image, or a box saying why with "reload" and a link; "reload" asks again', async () => {
  const { p, f } = await open(timelineDocument(detail, false, 'latest', { render: 'r1', web: WEB }));
  await expect.poll(() => asked(p)).toHaveLength(3);
  // an answer for another rendering, and one that is no bitmap: neither puts anything into the image
  await p.evaluate((png) => document.querySelector('iframe')!.contentWindow!.postMessage({ cavil: 'image', render: 'r0', id: '1', ok: true, data: png }, '*'), PNG);
  await p.waitForTimeout(200);
  await expect(box(f, '首页截图')).toHaveAttribute('data-state', 'loading');
  await p.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ cavil: 'image', render: 'r1', id: '1', ok: true, data: 'data:text/html,<script>parent.postMessage({cavil:"pwned"},"*")</script>' }, '*'));
  await expect(box(f, '首页截图')).toHaveAttribute('data-state', 'failed');
  expect(await f.locator('img[alt="首页截图"]').getAttribute('src')).toBeNull();

  // the real answers
  const send = (id: string, a: object) => p.evaluate(([i, x]) => document.querySelector('iframe')!.contentWindow!.postMessage({ cavil: 'image', render: 'r1', id: i, ...(x as object) }, '*'), [id, a] as const);
  await send('1', { ok: true, data: PNG });
  await expect(box(f, '首页截图')).toHaveCount(0);
  const home = f.locator('img[alt="首页截图"]');
  await expect(home).toBeVisible();
  expect(await home.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  // its link is back with it
  await expect(f.locator(`a[href="${rel('home.png')}"]`).first()).toBeVisible();

  await send('2', { ok: false, state: 'failed', why: '没取到：当前登录读不到这个仓库的发布附件' });
  const denied = box(f, '错题本截图');
  await expect(denied).toHaveAttribute('data-state', 'failed');
  await expect(denied.locator('.why')).toHaveText('没取到：当前登录读不到这个仓库的发布附件');
  await expect(denied.locator('button')).toHaveText('重新加载');
  await expect(denied.locator('button')).toBeEnabled();
  await expect(denied.locator('a')).toHaveAttribute('href', rel('denied.png'));
  await expect(f.locator('img[alt="错题本截图"]')).toBeHidden();

  // "reload": the window is asked again, the box waits, and this time the image comes
  await plan(p, rel('denied.png'), { ok: true, data: PNG });
  await denied.locator('button').click();
  await expect.poll(() => asked(p)).toHaveLength(4);
  expect((await asked(p))[3]).toBe(rel('denied.png'));
  await expect(f.locator('img[alt="错题本截图"]')).toBeVisible();
  await expect(box(f, '错题本截图')).toHaveCount(0);
  expect(await p.evaluate(() => (window as any).got.some((m: any) => m.cavil === 'pwned'))).toBe(false);
  await p.close();
});

test('GitHub#395: rate limited — "reload" cannot be pressed before the time GitHub gave, and can after', async () => {
  const { p, f } = await open(timelineDocument(detail, false, 'latest', { render: 'r1', web: WEB }));
  await expect.poll(() => asked(p)).toHaveLength(3);
  const until = await p.evaluate(() => Date.now() + 1500);
  await p.evaluate((u) => document.querySelector('iframe')!.contentWindow!.postMessage({ cavil: 'image', render: 'r1', id: '3', ok: false, state: 'limited', why: 'GitHub 限流，10:52 之后可以再试', until: u }, '*'), until);
  const limited = box(f, '知识图谱截图');
  await expect(limited).toHaveAttribute('data-state', 'limited');
  await expect(limited.locator('.why')).toHaveText('GitHub 限流，10:52 之后可以再试');
  await expect(limited.locator('button')).toBeDisabled();
  // pressing it meanwhile asks nothing
  await limited.locator('button').click({ force: true });
  await p.waitForTimeout(200);
  expect(await asked(p)).toHaveLength(3);
  await expect(limited.locator('button')).toBeEnabled({ timeout: 5_000 });
  await plan(p, rel('limited.png'), { ok: true, data: PNG });
  await limited.locator('button').click();
  await expect(f.locator('img[alt="知识图谱截图"]')).toBeVisible();
  await p.close();
});

test('GitHub#395: an ordinary image that did not load gets the same box; "reload" asks the window to read the discussion again; a good image is left alone', async () => {
  const { p, f } = await open(timelineDocument(detail, false, 'latest', { render: 'r1', web: WEB }));
  const bad = box(f, '坏图');
  await expect(bad).toHaveAttribute('data-state', 'failed');
  await expect(bad.locator('.why')).toHaveText('图片没加载出来');
  await expect(box(f, '好图')).toHaveCount(0);
  await expect(f.locator('img[alt="好图"]')).toBeVisible();
  expect(await p.evaluate(() => (window as any).got.filter((m: any) => m.cavil === 'reread').length)).toBe(0);
  await bad.locator('button').click();
  await expect.poll(() => p.evaluate(() => (window as any).got.filter((m: any) => m.cavil === 'reread').length)).toBe(1);
  await expect(bad).toHaveAttribute('data-state', 'loading');
  await p.close();
});

test('GitHub#395: offline — the boxes are there, "reload" cannot be pressed and says why', async () => {
  const { p, f } = await open(timelineDocument(detail, false, 'latest', { render: 'r1', web: WEB, offline: true }));
  const bad = box(f, '坏图');
  await expect(bad.locator('button')).toBeDisabled();
  await expect(bad.locator('button')).toHaveAttribute('title', '离线时不能重新加载');
  await p.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ cavil: 'image', render: 'r1', id: '1', ok: false, state: 'failed', why: '没取到：连不上 GitHub' }, '*'));
  await expect(box(f, '首页截图').locator('button')).toBeDisabled();
  await p.close();
});
