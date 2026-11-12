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
// 关闭 issue / 交给 agent / 托管; GitHub#442: ⌘1 … ⌘9, pick a tab, and ⌘R, refresh (in a tab: this item; a digit goes by its key position, `code`) — the list is FRAME_FORWARD, built from the shortcut table into this text;
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
// expires). The only message the frame listens to is that answer, from its parent, for this rendering; only a
// data: address of one of four bitmap kinds is ever put into an image. An image that failed before this script
// ran is loaded once more so its failure is seen. Copying goes by select + copy, the way that
// works in a frame that is not same-origin; the clipboard API after it), and when neither way works the button
// says so and the block stays selected. It has no way to change anything on GitHub by
// itself: the window decides, and the frame cannot reach the window's objects
// (no allow-same-origin) nor the network (connect-src 'none').
//
// Change the text → change FRAME_SCRIPT_HASH and the hash in tauri.conf.json
// (test/unit/taskList.test.ts checks all three agree). Changing the keys of FRAME_IDS in the shortcut
// table changes the text too.

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
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== parent || !m || m.cavil !== 'image' || m.render !== render) return;
    var img = imgs[m.id];
    if (!img || !img.hasAttribute('data-rel')) return;
    if (m.ok === true && typeof m.data === 'string' && /^data:image\\/(png|jpeg|gif|webp);base64,/.test(m.data)) show(img, m.data);
    else box(img, m.state === 'limited' ? 'limited' : 'failed', String(m.why || '没取到'), m.until);
  });
  var fwd = ${JSON.stringify(FRAME_FORWARD)};
  document.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229 || e.altKey || typeof e.key !== 'string') return;
    var mod = e.metaKey || e.ctrlKey, sh = e.shiftKey, k = e.key.toLowerCase();
    var code = typeof e.code === 'string' ? e.code : '';
    var dg = /^(Digit|Numpad)[0-9]$/.test(code) ? code.slice(-1) : '';
    for (var i = 0; i < fwd.length; i++) {
      var f = fwd[i];
      if (f.mod !== mod || f.shift !== sh) continue;
      if (/^[0-9]$/.test(f.key) ? (code ? dg !== f.key : k !== f.key) : k !== f.key) continue;
      e.preventDefault();
      send({ cavil: 'key', key: k, mod: mod, shift: sh, code: code });
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
export const FRAME_SCRIPT_HASH = "'sha256-1w5AK2CrJvT9phTGokE2TGUqDeF/RxTAdN0jIvReTtg='";
