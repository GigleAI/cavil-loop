// The run-time half of the language checks (GitHub#466 / #471), shared by the UI tests of every
// area: Chinese in the given parts of the window outside text shown as is (`data-verbatim`,
// `data-verbatim-parts`) and outside the few kept words (`data-keep-lang`, KEEP_LANG).

import type { Page } from '@playwright/test';
import { KEEP_LANG } from '../../src/shared/i18n';

/**
 * Chinese in `selectors` outside text shown as is and outside the kept words: text nodes, and the
 * title / aria-label / placeholder / alt of every element. `skip`: parts that belong to a later
 * sub-issue of #466 (named in the call, removed when that part is migrated).
 */
export async function chineseIn(page: Page, selectors: string[], skip: string[] = []): Promise<string[]> {
  return page.evaluate(
    ({ selectors, skip, keep }) => {
      const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
      const out: string[] = [];
      const exempt = (el: Element) => Boolean(el.closest('[data-verbatim]')) || skip.some((s) => el.closest(s));
      const kept = (el: Element) => {
        const k = el.closest('[data-keep-lang]');
        return Boolean(k && keep.some((x) => x.text === k.textContent && x.lang === k.getAttribute('lang')));
      };
      let seen = 0;
      for (const sel of selectors)
        for (const root of Array.from(document.querySelectorAll(sel))) {
          seen++;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const el = n.parentElement;
            if (!el || exempt(el) || kept(el)) continue;
            if (CJK.test(n.textContent ?? '')) out.push(`${sel}: ${(n.textContent ?? '').trim()}`);
          }
          for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
            if (exempt(el)) continue;
            // the outside parts an element names (verbatimParts) come out of its attributes, nothing else
            const parts: string[] = el.hasAttribute('data-verbatim-parts') ? JSON.parse(el.getAttribute('data-verbatim-parts')!) : [];
            for (const a of ['title', 'aria-label', 'placeholder', 'alt']) {
              let v = el.getAttribute(a);
              if (!v) continue;
              for (const p of parts) v = v.split(p).join('');
              if (CJK.test(v)) out.push(`${sel} [${a}]: ${el.getAttribute(a)}`);
            }
          }
        }
      // a selector that matched nothing checked nothing: report it rather than pass
      if (seen === 0) out.push(`nothing matched ${selectors.join(', ')}`);
      return out;
    },
    { selectors, skip, keep: KEEP_LANG.map((k) => ({ ...k })) },
  );
}

