// The "复制放行命令" page that ships in the dmg (GitHub#153), opened from disk
// in a plain browser window (WebKit in CI, like Safari opening it from Finder). Each case replaces the browser's clipboard
// paths before the click, so the three outcomes are told apart:
//   1. the clipboard API copies it
//   2. the clipboard API fails → the older "select + copy" way copies it
//   3. both fail → the command is left selected and the page says "按 ⌘C"
import { test, expect, chromium, webkit, type Browser, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_COMMAND } from '../../scripts/release-command.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = join(root, 'build', '复制放行命令.html');

let browser: Browser;
let page: Page;
test.beforeAll(async () => {
  browser = await (process.env.CAVIL_E2E_ENGINE === 'chromium' ? chromium : webkit).launch();
});
test.afterAll(async () => {
  await browser.close();
});
test.beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(pathToFileURL(PAGE).href);
  await expect(page.locator('#cmd')).toHaveText(RELEASE_COMMAND);
  expect(page.url()).toMatch(/^file:/);
});
test.afterEach(async () => {
  await page.close();
});

/** replace the two copy paths; each records what it was asked to copy */
async function rig(page: Page, api: 'ok' | 'reject' | 'throw' | 'missing', exec: 'ok' | 'false' | 'throw' | 'unused') {
  await page.evaluate(
    ({ api, exec }) => {
      const w = window as any;
      w.__api = [];
      w.__exec = [];
      if (api === 'missing') Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      else
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: (t: string) => {
              w.__api.push(t);
              if (api === 'throw') throw new Error('not allowed');
              return api === 'ok' ? Promise.resolve() : Promise.reject(new DOMException('denied', 'NotAllowedError'));
            },
          },
        });
      document.execCommand = ((cmd: string) => {
        w.__exec.push([cmd, String(window.getSelection())]);
        if (exec === 'throw') throw new Error('no');
        return exec === 'ok';
      }) as any;
    },
    { api, exec },
  );
}
const calls = () => page.evaluate(() => ({ api: (window as any).__api as string[], exec: (window as any).__exec as [string, string][] }));
const selection = () => page.evaluate(() => String(window.getSelection()));

test('clipboard API works: the command is copied with it, the older way is not touched', async () => {
  await rig(page, 'ok', 'unused');
  await page.getByRole('button', { name: '复制' }).click();
  await expect(page.locator('#status')).toHaveText(/已复制/);
  await expect(page.locator('#status')).toHaveClass('ok');
  expect(await calls()).toEqual({ api: [RELEASE_COMMAND], exec: [] });
});

for (const api of ['reject', 'throw', 'missing'] as const) {
  test(`clipboard API ${api === 'missing' ? 'absent' : `fails (${api})`}: falls back to select + copy, with the command selected`, async () => {
    await rig(page, api, 'ok');
    await page.getByRole('button', { name: '复制' }).click();
    await expect(page.locator('#status')).toHaveText(/已复制/);
    const c = await calls();
    expect(c.api).toEqual(api === 'missing' ? [] : [RELEASE_COMMAND]);
    expect(c.exec).toEqual([['copy', RELEASE_COMMAND]]);
  });
}

for (const exec of ['false', 'throw'] as const) {
  test(`both ways fail (older way ${exec === 'false' ? 'refuses' : 'throws'}): command left selected, page says to press ⌘C`, async () => {
    await rig(page, 'reject', exec);
    await page.getByRole('button', { name: '复制' }).click();
    await expect(page.locator('#status')).toHaveText('没能自动复制。命令已选中，请按 ⌘C 复制。');
    await expect(page.locator('#status')).toHaveClass('warn');
    expect((await calls()).exec).toEqual([['copy', RELEASE_COMMAND]]);
    expect(await selection()).toBe(RELEASE_COMMAND);
  });
}

test('the page loads nothing from anywhere else', async () => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.reload();
  await expect(page.locator('#cmd')).toHaveText(RELEASE_COMMAND);
  expect(requests.filter((u) => !u.startsWith('file:'))).toEqual([]);
});
