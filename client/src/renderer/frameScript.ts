// The one script the discussion frame runs (GitHub#193). The frame holds
// GitHub's rendered HTML, which may never run anything: both the window's
// policy (src-tauri/tauri.conf.json) and the frame's own policy allow exactly
// this script, by the SHA-256 of its text. So it is a constant — what changes
// per rendering (which rendering this is, where to scroll back to) sits in the
// frame's <body data-…> attributes and is read from there.
//
// It only reports to the window: a ticked box (which entry, which box, ticked
// or not — GitHub#358: the box turns grey at once and every box of the frame
// stops taking clicks, until the window renders the frame again), a click on an entry's "edit" button (GitHub#205: which entry),
// which entries are unfolded / how far the frame is scrolled, so a re-read can
// put both back, a few keys (GitHub#322: a bare R, "go to the reply box"; GitHub#433: the ⌘⇧ keys of
// 关闭 issue / 交给 agent / 托管; GitHub#442: ⌘1 … ⌘9, pick a tab, and ⌘R, refresh (in a tab: this item; a digit goes by its key position, `code`) — the list is FRAME_FORWARD, built from the shortcut table into this text, replaced by the keys in effect on this machine when the window sends them (GitHub#487);
// every other key stays in the frame, PR #171), and the "wrap long lines" switch of the code
// blocks (GitHub#381: on or off — the window remembers it). The "copy" button of a code block is handled here
// and reports nothing: the block's text goes to the clipboard inside the click. Which text: everything the
// block shows, except that the last line break is left out when GitHub itself says so — its rendering of a
// discussion carries, on the element around a block, the text its own copy button copies, and when that is the
// shown text less one final line break, that is what is copied. Nothing is guessed from the block's shape (PR
// #386 review rounds 1 and 2: two different sources render to the same HTML), and GitHub's text is never taken
// when it differs from the shown text in any other way. Images (GitHub#395): an image that did not load is
// replaced by a box with its alt text, a line saying why, "reload" and a link to it; a release attachment image
// (it carries \`data-rel\`, no \`src\` — the frame never fetches those) is asked of the window, entry by entry as
// they are unfolded, and the window hands back the image as a data: address or the line to show; "reload" asks
// again, or — for any other image — asks the window to read the discussion again (a pasted attachment's address
// expires). The messages the frame listens to come from its parent, for this rendering: that answer, the keys
// (below) and find (GitHub#502: open or not, the query, which match is current — it only highlights, unfolds
// and scrolls, and reports the count back; while find is open a plain Esc is handed to the window); only a
// data: address of one of four bitmap kinds is ever put into an image. An image that failed before this script
// ran is loaded once more so its failure is seen. Copying goes by select + copy, the way that
// works in a frame that is not same-origin; the clipboard API after it), and when neither way works the button
// says so and the block stays selected. It has no way to change anything on GitHub by
// itself: the window decides, and the frame cannot reach the window's objects
// (no allow-same-origin) nor the network (connect-src 'none').
//
// Change the text → change FRAME_SCRIPT_HASH and the hash in tauri.conf.json
// (test/unit/taskList.test.ts checks all three agree). Changing the default keys of FRAME_IDS in the shortcut
// table changes the text too; keys changed on this machine (GitHub#487) do not — the window sends them in a
// `{ cavil: 'keys' }` message, for this rendering, from its parent, and only a list of plain entries is taken.

import { FRAME_FIND_JS } from './frameFind';
import { FRAME_FORWARD } from './shortcuts';

export const FRAME_SCRIPT = `(function () {
  var b = document.body, render = b.getAttribute('data-render');
  function view() {
    var open = [], d = document.querySelectorAll('details.entry[open]');
    for (var i = 0; i < d.length; i++) open.push(d[i].getAttribute('data-entry'));
    return { open: open, scroll: window.scrollY || 0 };
  }
  function send(m) {
    m.render = render;
    m.view = view();
    parent.postMessage(m, '*');
  }
  var y = Number(b.getAttribute('data-scroll')) || 0;
  if (y > 0) window.scrollTo(0, y);
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-task')) return;
    var entry = t.closest('details.entry');
    if (!entry) return;
    t.setAttribute('data-pending', '');
    var all = document.querySelectorAll('input[data-task]');
    for (var i = 0; i < all.length; i++) all[i].disabled = true;
    send({ cavil: 'task', entry: entry.getAttribute('data-entry'), index: Number(t.getAttribute('data-task')), checked: t.checked });
  });
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('button[data-edit]') : null;
    if (t) {
      var entry = t.closest('details.entry');
      if (entry) send({ cavil: 'edit', entry: entry.getAttribute('data-entry') });
      return;
    }
    t = e.target && e.target.closest ? e.target.closest('button[data-img-reload]') : null;
    if (t) {
      e.preventDefault();
      var img = imgs[t.getAttribute('data-img-reload')];
      if (!img || t.disabled) return;
      if (img.hasAttribute('data-rel')) ask(img);
      else {
        box(img, 'loading', '正在重新读取…');
        send({ cavil: 'reread' });
      }
      return;
    }
    t = e.target && e.target.closest ? e.target.closest('button[data-code-wrap],button[data-code-copy]') : null;
    var block = t ? t.closest('.cb') : null, pre = block ? block.querySelector('pre') : null;
    if (!pre) return;
    if (t.hasAttribute('data-code-wrap')) {
      var on = !b.hasAttribute('data-wrap');
      if (on) b.setAttribute('data-wrap', ''); else b.removeAttribute('data-wrap');
      var all = document.querySelectorAll('button[data-code-wrap]');
      for (var i = 0; i < all.length; i++) all[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      send({ cavil: 'wrap', on: on });
      return;
    }
    copy(pre, t, block);
  });
  var copying = null;
  document.addEventListener('copy', function (e) {
    if (copying === null || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', copying);
    e.preventDefault();
  });
  function copied(btn, ok) {
    btn.setAttribute('data-state', ok ? 'ok' : 'fail');
    btn.textContent = ok ? '已复制 ✓' : '复制失败';
    clearTimeout(btn.cavilTimer);
    btn.cavilTimer = setTimeout(function () {
      btn.removeAttribute('data-state');
      btn.textContent = '复制';
    }, 2000);
  }
  function copy(pre, btn, block) {
    var text = pre.textContent, own = block.parentElement ? block.parentElement.getAttribute('data-snippet-clipboard-copy-content') : null;
    if (own !== null && own + '\\n' === text) text = own;
    var s = window.getSelection(), g = document.createRange(), ok = false;
    g.selectNodeContents(pre);
    s.removeAllRanges();
    s.addRange(g);
    copying = text;
    try { ok = document.execCommand('copy'); } catch (x) { ok = false; }
    copying = null;
    if (ok) {
      s.removeAllRanges();
      return copied(btn, true);
    }
    var done = function (v) { return function () { if (v) s.removeAllRanges(); copied(btn, v); }; };
    try { navigator.clipboard.writeText(text).then(done(true), done(false)); } catch (x) { copied(btn, false); }
  }
  var imgs = {}, nimg = 0, offline = b.hasAttribute('data-offline');
  function add(p, tag, cls, text) {
    var x = document.createElement(tag);
    if (cls) x.className = cls;
    x.textContent = text;
    p.appendChild(x);
    return x;
  }
  function place(img) {
    var a = img.parentNode;
    return a && a.tagName === 'A' && a.children.length === 1 && !a.textContent.replace(/\\s/g, '') ? a : img;
  }
  function box(img, state, why, until) {
    var id = img.getAttribute('data-img'), x = img.cavilBox;
    if (!id) {
      id = String(++nimg);
      img.setAttribute('data-img', id);
      imgs[id] = img;
    }
    if (!x) {
      var at = place(img);
      x = document.createElement('span');
      x.className = 'imgbox';
      x.setAttribute('data-img-box', id);
      at.parentNode.insertBefore(x, at);
      at.setAttribute('data-img-hidden', '');
      img.cavilBox = x;
    }
    clearTimeout(x.cavilTimer);
    x.setAttribute('data-state', state);
    x.textContent = '';
    add(x, 'span', 'alt', img.getAttribute('alt') || '图片');
    add(x, 'span', 'why', why);
    if (state === 'loading') return;
    var acts = add(x, 'span', 'acts', ''), btn = add(acts, 'button', '', '重新加载');
    btn.type = 'button';
    btn.setAttribute('data-img-reload', id);
    var src = img.getAttribute('data-rel') || img.getAttribute('src') || '';
    if (/^https?:/.test(src)) {
      var a = add(acts, 'a', '', '在网页上看');
      a.href = src;
      a.target = '_blank';
    }
    if (offline) {
      btn.disabled = true;
      btn.title = '离线时不能重新加载';
    } else if (state === 'limited') {
      var wait = Number(until) - Date.now();
      if (wait > 0) {
        btn.disabled = true;
        x.cavilTimer = setTimeout(function () { btn.disabled = false; }, Math.min(wait, 2147483647));
      }
    }
  }
  function show(img, data) {
    var x = img.cavilBox;
    if (x) {
      clearTimeout(x.cavilTimer);
      x.parentNode.removeChild(x);
      img.cavilBox = null;
    }
    place(img).removeAttribute('data-img-hidden');
    img.setAttribute('data-shown', '');
    img.src = data;
  }
  function ask(img) {
    box(img, 'loading', '正在用登录信息取图…');
    send({ cavil: 'image', id: img.getAttribute('data-img'), src: img.getAttribute('data-rel') });
  }
  function want() {
    var l = document.querySelectorAll('details.entry[open] img[data-rel]:not([data-img])');
    for (var i = 0; i < l.length; i++) ask(l[i]);
  }
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'IMG' || !t.closest('.md')) return;
    if (t.hasAttribute('data-rel') ? t.hasAttribute('data-shown') : !!t.getAttribute('src')) box(t, 'failed', '图片没加载出来');
  }, true);
  var fwd = ${JSON.stringify(FRAME_FORWARD)};
  // GitHub#502: find on the page. The window says whether find is open, the query and which of this frame's
  // matches is the current one; the frame finds (the same rule as the window, frameFind.ts), highlights,
  // unfolds and scrolls to the current one, and answers how many it found
  ${FRAME_FIND_JS}
  var findOn = false;
  function findSet(m) {
    findOn = m.open === true;
    var hl = window.CSS && CSS.highlights && typeof Highlight === 'function' ? CSS.highlights : null;
    if (hl) { hl.delete('cavil-find'); hl.delete('cavil-find-cur'); }
    if (!findOn) return;
    var q = typeof m.q === 'string' && m.q.length <= 1000 ? m.q : '';
    var list = cavilFind(document.body, q), all = hl ? new Highlight() : null, cur = null;
    for (var i = 0; i < list.length; i++) {
      var r = document.createRange();
      r.setStart(list[i][0], list[i][1]);
      r.setEnd(list[i][2], list[i][3]);
      if (i === m.cur) cur = r;
      else if (all) all.add(r);
    }
    if (hl) hl.set('cavil-find', all);
    if (cur) {
      if (hl) { var one = new Highlight(); one.add(cur); hl.set('cavil-find-cur', one); }
      var el = cur.startContainer.parentElement;
      for (var d = el && el.closest('details:not([open])'); d; d = d.parentElement ? d.parentElement.closest('details:not([open])') : null) d.open = true;
      if (m.scroll === true) {
        if (!hl) { var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(cur); }
        if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    }
    send({ cavil: 'found', q: q, n: list.length });
  }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== parent || !m || m.render !== render) return;
    if (m.cavil === 'find') { findSet(m); return; }
    if (m.cavil === 'keys') {
      // the keys in effect on this machine (GitHub#487): only a list of plain entries replaces the defaults
      var list = m.fwd, ok = Array.isArray(list) && list.length <= 64;
      for (var n = 0; ok && n < list.length; n++) {
        var x = list[n];
        ok = !!x && typeof x.key === 'string' && x.key.length >= 1 && x.key.length <= 16 && typeof x.mod === 'boolean' && typeof x.shift === 'boolean' && typeof x.alt === 'boolean';
      }
      if (ok) fwd = list.map(function (x) { return { key: x.key.toLowerCase(), mod: x.mod, shift: x.shift, alt: x.alt }; });
      return;
    }
    if (m.cavil !== 'image') return;
    var img = imgs[m.id];
    if (!img || !img.hasAttribute('data-rel')) return;
    if (m.ok === true && typeof m.data === 'string' && /^data:image\\/(png|jpeg|gif|webp);base64,/.test(m.data)) show(img, m.data);
    else box(img, m.state === 'limited' ? 'limited' : 'failed', String(m.why || '没取到'), m.until);
  });
  document.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229 || typeof e.key !== 'string') return;
    // GitHub#502: while find is open a plain Esc closes it — handed to the window, which only closes find with it
    if (findOn && e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      send({ cavil: 'findEsc' });
      return;
    }
    // only a candidate is picked here (the same modifiers, and the key position — for a digit, or a letter with ⌥ — or
    // the character of a forwarded shortcut); the event goes on as it came, and the window decides it with its own rule
    var mod = e.metaKey || e.ctrlKey, sh = e.shiftKey, alt = e.altKey, k = e.key.toLowerCase();
    var code = typeof e.code === 'string' ? e.code : '';
    var dg = /^(Digit|Numpad)[0-9]$/.test(code) ? code.slice(-1) : '';
    var lt = /^Key[A-Z]$/.test(code) ? code.slice(-1).toLowerCase() : '';
    for (var i = 0; i < fwd.length; i++) {
      var f = fwd[i];
      if (f.mod !== mod || f.shift !== sh || f.alt !== alt) continue;
      // with Shift held a bracket reports its brace ("}" for "]"), as the window's own rule says
      var kk = sh && (k === '}' || k === '{') ? (k === '}' ? ']' : '[') : k;
      if (/^[0-9]$/.test(f.key) ? (code ? dg !== f.key : k !== f.key) : alt && lt && /^[a-z]$/.test(f.key) ? lt !== f.key : kk !== f.key) continue;
      e.preventDefault();
      // GitHub#492: ⌘ and ⌃ as they were held, so the window tells ⌃⌘1 from ⌘1 by its own rule; GitHub#487: ⌥ too
      send({ cavil: 'key', key: e.key, mod: mod, shift: sh, alt: alt, code: code, meta: !!e.metaKey, ctrl: !!e.ctrlKey });
      return;
    }
  });
  document.addEventListener('toggle', function () { send({ cavil: 'view' }); want(); }, true);
  var timer = 0;
  window.addEventListener('scroll', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { send({ cavil: 'view' }); }, 150);
  });
  send({ cavil: 'ready' });
  want();
  var late = document.querySelectorAll('.md img[src]');
  for (var k = 0; k < late.length; k++) if (late[k].complete && !late[k].naturalWidth) late[k].src = late[k].getAttribute('src');
})();`;

/** CSP source for FRAME_SCRIPT: the same string sits in tauri.conf.json's script-src. */
export const FRAME_SCRIPT_HASH = "'sha256-aDMsuCzovOit/wx11haYDomQfao0xA73FvhahmHaAzc='";
