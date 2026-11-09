// GitHub#275 (PR #278 review round 2): the parser's idea of "prose" checked against a browser's.
// Each description of the shared list (test/fixtures/pr-ref-bodies.ts) is rendered the way GitHub
// renders Markdown (CommonMark + GFM, raw HTML kept, GFM's tag filter on) and put in a real page;
// what a reader sees as prose is its text with code-like elements (code, pre, kbd, samp) taken out —
// the browser, not the parser, decides what a comment, a tag or an element's content is. The issues
// named there must be exactly the list's answer, and exactly what the parser finds.
import { test, expect, chromium, webkit, type Browser } from '@playwright/test';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { bodyIssueRefs, namedIn } from '../../src/data/prNest';
import { REF_CASES } from '../fixtures/pr-ref-bodies';

let browser: Browser;
test.beforeAll(async () => {
  browser = await (process.env.CAVIL_E2E_ENGINE === 'chromium' ? chromium : webkit).launch();
});
test.afterAll(async () => {
  await browser.close();
});

test('GitHub#275: the issues a description names in its prose are the ones a browser shows as prose', async () => {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><div id="out"></div>');
  const seen: string[] = [];
  for (const c of REF_CASES) {
    const html = micromark(c.body, { allowDangerousHtml: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] });
    const prose = await page.evaluate((h) => {
      const out = document.getElementById('out')!;
      out.innerHTML = h;
      for (const el of out.querySelectorAll('code, pre, kbd, samp')) el.remove();
      return out.textContent ?? '';
    }, html);
    const want = c.refs.map((n) => `o/r#${n}`);
    expect(namedIn(prose, 'o/r', 99), `browser: ${c.why}\n${html}`).toEqual(want);
    expect(bodyIssueRefs(c.body, 'o/r', 99), `parser: ${c.why}`).toEqual(want);
    seen.push(c.why);
  }
  expect(seen.length).toBe(REF_CASES.length);
  await page.close();
});
