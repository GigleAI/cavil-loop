// GitHub#502: find text on the page (⌘F), the matching rule.
//
// One rule, two implementations: this one runs in the window; the discussion frame runs FRAME_FIND_JS
// (frameFind.ts), a plain-script copy written into the frame's fixed script (the frame may run nothing
// else, and the window cannot run a script from text). test/e2e/find-parity.spec.ts runs both in one real
// browser on the same pages and requires the same matches.
//
// The rule:
// - The text looked at is every text node under `root` except those inside SKIP elements, inside an
//   element marked data-find-skip (the find bar itself), or inside an element that is not shown. Text that is
//   hidden only because a <details> around it is closed counts (when that <details> itself is shown): the
//   window unfolds it when the match becomes the current one.
// - Text nodes are joined into runs: a run is the text of consecutive nodes that sit in the same block (the
//   nearest ancestor that is not an INLINE element). A <br> or a block element in between ends a run, so a
//   match never spans two paragraphs, but it does span <b>, <a>, <code> … inside one.
// - Inside a run every whitespace sequence counts as one space, and letters are compared without case, one
//   UTF-16 unit at a time (a unit whose lower case is not one unit is compared as it is), so every unit of
//   the folded text maps back to one unit of the page. The query is folded
//   the same way; a query of only whitespace matches nothing.
// - Matches are found left to right and do not overlap.

/** where one match starts and ends, as DOM positions */
export type FindMatch = { sn: Text; so: number; en: Text; eo: number };

export const SKIP = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'TEMPLATE', 'IFRAME', 'SVG', 'svg'];
export const INLINE = [
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'INS', 'KBD', 'LABEL',
  'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U', 'VAR', 'G-EMOJI',
];

/** whether the element is shown: laid out and not visibility:hidden */
export function shown(el: Element): boolean {
  const e = el as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean };
  if (typeof e.checkVisibility === 'function') return e.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
  if (el.getClientRects().length === 0) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

/** whether text inside `el` counts: shown, or hidden only by closed <details> that is itself shown */
export function counts(el: Element): boolean {
  if (shown(el)) return true;
  let outer: Element | null = null;
  for (let d = el.closest('details:not([open])'); d; d = d.parentElement ? d.parentElement.closest('details:not([open])') : null) outer = d;
  return outer !== null && shown(outer);
}

function fold(c: string): string {
  const l = c.toLowerCase();
  return l.length === 1 ? l : c;
}

/** the query as the runs are compared: folded, whitespace as one space ('' = matches nothing) */
export function foldQuery(q: string): string {
  let out = '';
  // UTF-16 units one by one, exactly as the page text is read below
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (/\s/.test(c)) {
      if (!out.endsWith(' ')) out += ' ';
    } else out += fold(c);
  }
  return out.trim() === '' ? '' : out;
}

type Run = { text: string; node: Text[]; off: number[] };

/** every match of `q` under `root`, in document order */
export function findMatches(root: Node, q: string): FindMatch[] {
  const want = foldQuery(q);
  if (!want) return [];
  const doc = root.ownerDocument ?? (root as Document);
  const cache = new Map<Element, boolean>();
  const ok = (el: Element) => {
    let v = cache.get(el);
    if (v === undefined) {
      v = counts(el);
      cache.set(el, v);
    }
    return v;
  };
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === 1) {
        const el = n as Element;
        if (SKIP.includes(el.tagName) || el.hasAttribute('data-find-skip')) return NodeFilter.FILTER_REJECT;
        return ok(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out: FindMatch[] = [];
  let run: Run = { text: '', node: [], off: [] };
  let runBlock: Element | null = null;
  const flush = () => {
    if (run.text) {
      for (let i = run.text.indexOf(want); i >= 0; i = run.text.indexOf(want, i + want.length)) {
        const e = i + want.length - 1;
        out.push({ sn: run.node[i], so: run.off[i], en: run.node[e], eo: run.off[e] + 1 });
      }
    }
    run = { text: '', node: [], off: [] };
    runBlock = null;
  };
  const blockOf = (el: Element | null): Element | null => {
    let b = el;
    while (b && INLINE.includes(b.tagName)) b = b.parentElement;
    return b;
  };
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      const el = n as Element;
      if (el.tagName === 'BR' || !INLINE.includes(el.tagName)) flush();
      continue;
    }
    const t = n as Text;
    const block = blockOf(t.parentElement);
    if (block !== runBlock) {
      flush();
      runBlock = block;
    }
    const s = t.data;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (/\s/.test(c)) {
        if (run.text.endsWith(' ')) continue;
        run.text += ' ';
      } else {
        run.text += fold(c);
      }
      run.node.push(t);
      run.off.push(i);
    }
  }
  flush();
  return out;
}
