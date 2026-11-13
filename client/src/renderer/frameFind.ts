// GitHub#502: the matching rule of findCore.ts, as plain script text for the discussion frame.
//
// The frame runs one fixed script (frameScript.ts) allowed by its hash; it cannot import the window's code, and
// the window cannot run a script from text. So the rule exists twice: findMatches (findCore.ts) and the
// function below. test/e2e/find-parity.spec.ts runs both in one real browser on the same pages and requires
// the same matches — change one, change the other.
//
// It defines `cavilFind(root, q)`: the matches as [startNode, startOffset, endNode, endOffset] arrays.

import { INLINE, SKIP } from './findCore';

// the element lists are taken from findCore.ts as they are; the code is the copy
export const FRAME_FIND_JS = `function cavilFind(root, q) {
  var SKIP = ${JSON.stringify(SKIP)};
  var INLINE = ${JSON.stringify(INLINE)};
  function fold(c) { var l = c.toLowerCase(); return l.length === 1 ? l : c; }
  function shown(el) {
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
    if (el.getClientRects().length === 0) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  }
  function counts(el) {
    if (shown(el)) return true;
    var outer = null;
    for (var d = el.closest('details:not([open])'); d; d = d.parentElement ? d.parentElement.closest('details:not([open])') : null) outer = d;
    return outer !== null && shown(outer);
  }
  var want = '';
  for (var qi = 0; qi < q.length; qi++) {
    var qc = q.charAt(qi);
    if (/\\s/.test(qc)) { if (want.charAt(want.length - 1) !== ' ') want += ' '; }
    else want += fold(qc);
  }
  if (/^ *$/.test(want)) return [];
  var cache = [], cacheV = [];
  function ok(el) {
    var i = cache.indexOf(el);
    if (i >= 0) return cacheV[i];
    var v = counts(el);
    cache.push(el); cacheV.push(v);
    return v;
  }
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      if (n.nodeType === 1) {
        if (SKIP.indexOf(n.tagName) >= 0 || n.hasAttribute('data-find-skip')) return NodeFilter.FILTER_REJECT;
        return ok(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var out = [], text = '', nodes = [], offs = [], runBlock = null;
  function flush() {
    if (text) {
      for (var i = text.indexOf(want); i >= 0; i = text.indexOf(want, i + want.length)) {
        var e = i + want.length - 1;
        out.push([nodes[i], offs[i], nodes[e], offs[e] + 1]);
      }
    }
    text = ''; nodes = []; offs = []; runBlock = null;
  }
  function blockOf(el) {
    var b = el;
    while (b && INLINE.indexOf(b.tagName) >= 0) b = b.parentElement;
    return b;
  }
  for (var n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      if (n.tagName === 'BR' || INLINE.indexOf(n.tagName) < 0) flush();
      continue;
    }
    var block = blockOf(n.parentElement);
    if (block !== runBlock) { flush(); runBlock = block; }
    var s = n.data;
    for (var k = 0; k < s.length; k++) {
      var c = s.charAt(k);
      if (/\\s/.test(c)) {
        if (text.charAt(text.length - 1) === ' ') continue;
        text += ' ';
      } else text += fold(c);
      nodes.push(n); offs.push(k);
    }
  }
  flush();
  return out;
}`;
