// GigleAI/cavil-loop#502: the find rule exists twice — findMatches (findCore.ts, the window) and the plain-script
// copy the discussion frame runs (FRAME_FIND_JS, frameFind.ts). Both run here in one real browser, on the same
// pages and queries, and must give the same matches; each page also has the answer written out by hand, so the
// two agreeing on a wrong answer is caught too.

import { test, expect, chromium, webkit, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_FIND_JS } from '../../src/renderer/frameFind';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let browser: Browser;
let windowJs = '';
test.beforeAll(async () => {
  const out = await build({ entryPoints: [join(root, 'src/renderer/findCore.ts')], bundle: true, format: 'iife', globalName: 'W', write: false, target: 'es2019' });
  windowJs = out.outputFiles[0].text;
  browser = await (process.env.CAVIL_E2E_ENGINE === 'chromium' ? chromium : webkit).launch();
});
test.afterAll(async () => browser?.close());

/** page HTML, query, the matched texts by hand */
const CASES: [string, string, string, string[]][] = [
  ['plain, case and repeats', '<p>Foo foo FOO fo</p>', 'foo', ['Foo', 'foo', 'FOO']],
  ['no overlap', '<p>aaaa</p>', 'aa', ['aa', 'aa']],
  ['across inline elements', '<p>the <b>wom</b>bat and <a href="#">co<code>de</code></a></p>', 'wombat', ['wombat']],
  ['inline code too', '<p>x <a href="#">co<code>de</code></a> y</p>', 'code', ['code']],
  ['not across paragraphs', '<p>abc</p><p>def</p>', 'cd', []],
  ['not across a line break', '<p>abc<br>def</p>', 'cd', []],
  ['not across a nested block', '<div>ab<div>x</div>cd</div>', 'bc', []],
  ['whitespace counts as one space', '<p>one\n   two\tthree</p>', 'one two  three', ['one\n   two\tthree']],
  ['whitespace across nodes', '<p>one <span> two</span></p>', 'one two', ['one <span> two</span>']],
  ['only whitespace finds nothing', '<p>a b</p>', '   ', []],
  ['empty finds nothing', '<p>a</p>', '', []],
  ['hidden text does not count', '<p style="display:none">zzz</p><p>zzz</p><p style="visibility:hidden">zzz</p>', 'zzz', ['zzz']],
  ['closed details counts', '<details><summary>head</summary><p>inside zzz</p></details>', 'zzz', ['zzz']],
  ['closed details that is hidden does not', '<div style="display:none"><details><summary>h</summary><p>zzz</p></details></div>', 'zzz', []],
  ['nested closed details', '<details><summary>a</summary><details><summary>b</summary><p>zzz</p></details></details>', 'zzz', ['zzz']],
  ['skipped elements', '<p>zzz</p><textarea>zzz</textarea><input value="zzz"><script>/*zzz*/</script><style>/*zzz*/</style><span data-find-skip>zzz</span>', 'zzz', ['zzz']],
  ['Chinese and mixed', '<p>托管模式下查找<b>托管</b>两个字</p>', '托管', ['托管', '托管']],
  ['a character whose lower case is longer is compared as it is', '<p>İstanbul istanbul</p>', 'istanbul', ['istanbul']],
  ['emoji (two units)', '<p>a 😀b 😀B</p>', '😀b', ['😀b', '😀B']],
  ['list items are blocks', '<ul><li>ab</li><li>cd</li></ul>', 'bc', []],
  ['table cells are blocks', '<table><tr><td>ab</td><td>cd</td></tr></table>', 'bc', []],
];

test('the window and the discussion frame find the same matches, and the right ones', async () => {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><meta charset="utf-8"><body><div id="root"></div></body>');
  await page.addScriptTag({ content: windowJs });
  await page.addScriptTag({ content: `window.cavilFind = (function () { ${FRAME_FIND_JS}; return cavilFind; })();` });
  for (const [name, html, q, want] of CASES) {
    const got = await page.evaluate(
      ({ html, q }) => {
        const r = document.getElementById('root')!;
        r.innerHTML = html;
        const texts: Text[] = [];
        const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) texts.push(n as Text);
        const at = (n: Node, o: number) => `${texts.indexOf(n as Text)}:${o}`;
        const asText = (sn: Node, so: number, en: Node, eo: number) => {
          const g = document.createRange();
          g.setStart(sn, so);
          g.setEnd(en, eo);
          const d = document.createElement('div');
          d.appendChild(g.cloneContents());
          return d.innerHTML;
        };
        const win = (window as unknown as { W: { findMatches: (r: Node, q: string) => { sn: Node; so: number; en: Node; eo: number }[] } }).W.findMatches(r, q);
        const fr = (window as unknown as { cavilFind: (r: Node, q: string) => [Node, number, Node, number][] }).cavilFind(r, q);
        return {
          win: win.map((m) => [at(m.sn, m.so), at(m.en, m.eo)].join('-')),
          frame: fr.map((m) => [at(m[0], m[1]), at(m[2], m[3])].join('-')),
          text: win.map((m) => asText(m.sn, m.so, m.en, m.eo)),
        };
      },
      { html, q },
    );
    expect(got.frame, name).toEqual(got.win);
    expect(got.text.map((t) => t.replace(/<\/?(b|a|code|span)[^>]*>/g, (m) => (m.startsWith('<span') ? '<span>' : m.startsWith('</span') ? '</span>' : ''))), name).toEqual(want);
  }
  await page.close();
});
