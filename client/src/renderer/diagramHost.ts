// GitHub#680: where the window gets a mermaid diagram drawn. GitHub's HTML carries only the source
// of a diagram (its web page draws it with a script from another host, which the client never runs
// or reaches); the client draws it itself with the mermaid copy it ships (dist/…/diagram/, put
// there by scripts/build.mjs).
//
// The source is written by anyone who may comment, so it is never handed to mermaid in this window
// (which holds the sign-in and the back end). It goes to one hidden helper frame: a srcdoc frame
// like the discussion's — `sandbox="allow-scripts"`, no same-origin — whose own policy lets only the
// two scripts in diagram/ run and allows no connection. What comes back is taken only from that
// frame, only as an answer to a question this window asked, and only as SVG text; the window turns
// it into a `data:image/svg+xml` address, which the discussion shows as an <img> (an image runs no
// script and loads nothing).
//
// One answer per source and theme for the life of the window: a diagram unfolded again, a discussion
// read again or drawn again for the other theme asks the same question and gets the same answer.
// A helper that does not start, or a drawing that does not come back, is "failed" — not kept, so the
// next time it is asked again.

export type DrawResult = { ok: true; data: string } | { ok: false; why: 'syntax' | 'failed' | 'tooBig' };

/** the attributes of the helper frame: scripts, nothing else (no same-origin, no popups, no forms) */
export const DIAGRAM_SANDBOX = 'allow-scripts';
/** mermaid's own limit on a diagram's source, in characters (its default maxTextSize) */
export const MAX_SOURCE = 50_000;
/** the largest SVG taken back (characters): a picture larger than this is "failed" */
export const MAX_SVG = 4_000_000;
/** how long a start-up or one drawing may take before it counts as "failed" (ms) */
export const DRAW_WAIT_MS = 20_000;

/** The helper frame's own policy: the two scripts in `dir` and nothing else; no connection at all. */
export function diagramCsp(dir: string): string {
  return `default-src 'none'; script-src ${dir}; style-src 'unsafe-inline'; img-src data:; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'`;
}

/** The helper frame's document; `base` = the window's own address (the scripts sit next to it, in diagram/). */
export function helperDocument(base: string): string {
  const dir = new URL('diagram/', base).href;
  const q = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${q(diagramCsp(dir))}"><body><script src="${q(dir)}mermaid.min.js"></script><script src="${q(dir)}draw.js"></script></body>`;
}

/** SVG text → the image address the discussion takes (base64 of its UTF-8 bytes) */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

type Waiter = (r: DrawResult) => void;

let frame: HTMLIFrameElement | null = null;
let started: Promise<boolean> | null = null;
let startedOk: ((ok: boolean) => void) | null = null;
let asked = 0;
const waiting = new Map<string, Waiter>();
const done = new Map<string, Promise<DrawResult>>();
/** how many drawings were asked of the helper (tests read it: "drawn once" is a number that went up by one) */
let drawCount = 0;
export function diagramDrawCount(): number {
  return drawCount;
}

function onMessage(ev: MessageEvent) {
  if (!frame || ev.source !== frame.contentWindow) return;
  const m = ev.data as { cavil?: unknown; id?: unknown; ok?: unknown; svg?: unknown; why?: unknown } | null;
  if (!m || typeof m !== 'object') return;
  if (m.cavil === 'drawReady') {
    startedOk?.(m.ok === true);
    startedOk = null;
    return;
  }
  if (m.cavil !== 'drawn' || typeof m.id !== 'string') return;
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  if (m.ok === true && typeof m.svg === 'string' && m.svg.length <= MAX_SVG && /^<svg[\s>]/.test(m.svg)) w({ ok: true, data: svgDataUrl(m.svg) });
  else w({ ok: false, why: m.why === 'syntax' ? 'syntax' : 'failed' });
}

/** the helper frame, made on first use; resolves to whether its script started with mermaid loaded */
function start(): Promise<boolean> {
  if (started && frame?.isConnected) return started;
  frame?.remove();
  window.removeEventListener('message', onMessage);
  window.addEventListener('message', onMessage);
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', DIAGRAM_SANDBOX);
  f.setAttribute('aria-hidden', 'true');
  f.setAttribute('tabindex', '-1');
  f.setAttribute('title', 'diagram');
  f.dataset.testid = 'diagram-helper';
  // laid out (mermaid measures its text) but never seen
  f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:800px;border:0;visibility:hidden;pointer-events:none';
  f.srcdoc = helperDocument(document.baseURI);
  frame = f;
  started = new Promise<boolean>((resolve) => {
    startedOk = resolve;
    setTimeout(() => resolve(false), DRAW_WAIT_MS);
  });
  document.body.appendChild(f);
  const mine = started;
  void mine.then((ok) => {
    // a helper that did not start is thrown away: the next diagram starts a new one
    if (!ok && started === mine) {
      started = null;
      frame?.remove();
      frame = null;
    }
  });
  return mine;
}

async function ask(src: string, dark: boolean): Promise<DrawResult> {
  if (!(await start()) || !frame?.contentWindow) return { ok: false, why: 'failed' };
  const id = String(++asked);
  drawCount++;
  return new Promise<DrawResult>((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, why: 'failed' });
    }, DRAW_WAIT_MS);
    waiting.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    frame!.contentWindow!.postMessage({ cavil: 'draw', id, src, dark }, '*');
  });
}

/** One diagram, drawn for the light or the dark theme. Never rejects. */
export function drawDiagram(src: string, dark: boolean): Promise<DrawResult> {
  if (src.length > MAX_SOURCE) return Promise.resolve({ ok: false, why: 'tooBig' });
  const key = `${dark ? 'd' : 'l'}\n${src}`;
  const known = done.get(key);
  if (known) return known;
  const p = ask(src, dark).catch((): DrawResult => ({ ok: false, why: 'failed' }));
  done.set(key, p);
  // "failed" (the helper, not the source) is not kept: asked again, it is drawn again
  void p.then((r) => {
    if (!r.ok && r.why === 'failed' && done.get(key) === p) done.delete(key);
  });
  return p;
}
