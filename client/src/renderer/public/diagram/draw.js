// GitHub#680: the diagram helper's own script. It runs in a hidden frame the window builds
// (src/renderer/diagramHost.ts): `sandbox="allow-scripts"` without same-origin, its own policy
// lets only this folder's two scripts run and allows no connection, so the frame reaches neither
// the network nor the window's objects. It takes one kind of message, from its parent only — the
// mermaid source of one diagram and the theme — and answers with the drawn SVG as text, or why it
// could not be drawn ("syntax": the source is not valid mermaid; "failed": anything else). Drawing
// runs one at a time: mermaid's settings (the theme) are global.
//
// Drawn with mermaid's strict security level (no links or click handlers in the picture) and with
// plain SVG text labels: the window shows the picture as an <img>, which does not render the
// HTML labels mermaid uses by default.
(function () {
  'use strict';
  var queue = Promise.resolve(), n = 0;
  function reply(m) { parent.postMessage(m, '*'); }
  function sized(svg) {
    var doc = new DOMParser().parseFromString(svg, 'text/html');
    var el = doc.querySelector('svg');
    if (!el) return null;
    // the picture's own size (mermaid writes width="100%" and a max-width): an <img> then shows it
    // at that size and the window only shrinks it to the column
    var vb = (el.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      el.setAttribute('width', String(Math.ceil(vb[2])));
      el.setAttribute('height', String(Math.ceil(vb[3])));
      el.style.removeProperty('max-width');
    }
    if (!el.getAttribute('xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return new XMLSerializer().serializeToString(el);
  }
  function draw(m) {
    var id = 'cavil-diagram-' + ++n;
    // how many diagrams this helper has drawn (the UI tests read it: a diagram asked again is not drawn again)
    document.body.setAttribute('data-drawn', String(n));
    var m2 = window.mermaid;
    if (!m2) return Promise.resolve(reply({ cavil: 'drawn', id: m.id, ok: false, why: 'failed' }));
    m2.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: m.dark ? 'dark' : 'default',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true,
    });
    return Promise.resolve()
      .then(function () { return m2.parse(m.src); })
      .then(
        function () {
          return m2.render(id, m.src).then(
            function (r) {
              var svg = r && typeof r.svg === 'string' ? sized(r.svg) : null;
              reply(svg ? { cavil: 'drawn', id: m.id, ok: true, svg: svg } : { cavil: 'drawn', id: m.id, ok: false, why: 'failed' });
            },
            function () { reply({ cavil: 'drawn', id: m.id, ok: false, why: 'failed' }); },
          );
        },
        function () { reply({ cavil: 'drawn', id: m.id, ok: false, why: 'syntax' }); },
      )
      .then(function () {
        // what mermaid leaves behind after a failed render
        var left = document.getElementById(id) || document.getElementById('d' + id);
        if (left && left.parentNode) left.parentNode.removeChild(left);
      });
  }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== parent || !m || m.cavil !== 'draw' || typeof m.id !== 'string' || typeof m.src !== 'string') return;
    queue = queue.then(function () { return draw({ id: m.id, src: m.src, dark: m.dark === true }); }, function () {});
  });
  reply({ cavil: 'drawReady', ok: !!window.mermaid });
})();
