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
// put both back, and a bare R key (GitHub#322: "go to the reply box" — the one
// key it passes on; every other key stays in the frame, PR #171), and the "wrap long lines" switch of the code
// blocks (GitHub#381: on or off — the window remembers it). The "copy" button of a code block is handled here
// and reports nothing: the block's text goes to the clipboard inside the click (select + copy, the way that
// works in a frame that is not same-origin; the clipboard API after it), and when neither way works the button
// says so and the block stays selected. It has no way to change anything on GitHub by
// itself: the window decides, and the frame cannot reach the window's objects
// (no allow-same-origin) nor the network (connect-src 'none').
//
// Change the text → change FRAME_SCRIPT_HASH and the hash in tauri.conf.json
// (test/unit/taskList.test.ts checks all three agree).

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
    copy(pre, t);
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
  function copy(pre, btn) {
    var text = pre.textContent.replace(/\\n$/, ''), s = window.getSelection(), g = document.createRange(), ok = false;
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
  document.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key !== 'r' && e.key !== 'R') return;
    e.preventDefault();
    send({ cavil: 'key', key: 'r' });
  });
  document.addEventListener('toggle', function () { send({ cavil: 'view' }); }, true);
  var timer = 0;
  window.addEventListener('scroll', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { send({ cavil: 'view' }); }, 150);
  });
  send({ cavil: 'ready' });
})();`;

/** CSP source for FRAME_SCRIPT: the same string sits in tauri.conf.json's script-src. */
export const FRAME_SCRIPT_HASH = "'sha256-Bhg6SWd/FH9K+sDw96EZaoN/ZT+GlTXkfsunTng+ZoM='";
