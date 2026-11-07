// The one script the discussion frame runs (GitHub#193). The frame holds
// GitHub's rendered HTML, which may never run anything: both the window's
// policy (src-tauri/tauri.conf.json) and the frame's own policy allow exactly
// this script, by the SHA-256 of its text. So it is a constant — what changes
// per rendering (which rendering this is, where to scroll back to) sits in the
// frame's <body data-…> attributes and is read from there.
//
// It only reports to the window: a ticked box (which entry, which box, ticked
// or not), a click on an entry's "edit" button (GitHub#205: which entry), and
// which entries are unfolded / how far the frame is scrolled, so a re-read can
// put both back. It has no way to change anything on GitHub by
// itself: the window decides, and the frame cannot reach the window's objects
// (no allow-same-origin) nor the network (connect-src 'none').
//
// Change the text → change FRAME_SCRIPT_HASH and the hash in tauri.conf.json
// (test/unit/frameScript.test.ts checks all three agree).

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
    var all = entry.querySelectorAll('input[data-task]');
    for (var i = 0; i < all.length; i++) all[i].disabled = true;
    send({ cavil: 'task', entry: entry.getAttribute('data-entry'), index: Number(t.getAttribute('data-task')), checked: t.checked });
  });
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('button[data-edit]') : null;
    if (!t) return;
    var entry = t.closest('details.entry');
    if (entry) send({ cavil: 'edit', entry: entry.getAttribute('data-entry') });
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
export const FRAME_SCRIPT_HASH = "'sha256-BNpQXqhF68GpMl4gzToZYbHFqOlFxrj+gIBE9bW2KpU='";
