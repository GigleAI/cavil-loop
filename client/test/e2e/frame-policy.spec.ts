// GitHub#193: the two policies between GitHub's HTML and running anything in the
// discussion frame, tested one layer at a time. A srcdoc frame is bound by its
// own policy AND the window's, so a test of both together cannot tell whether
// either one alone holds: each case below loosens the *other* layer (in this
// test page only — the app's policies are never loosened) and checks the layer
// under test still lets the frame's own script run and nothing else.
//
// The frame document is the real one (timelineDocument), the window policy the
// real one (tauri.conf.json, read the way the UI tests' bridge sends it).
// Every injection reports itself to the window, so "it did not run" is a
// message that never arrived next to the frame script's "ready" that did.
import { test, expect, chromium, webkit, type Browser } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { appCsp } from './bridge';
import { escapeHtml, timelineDocument, TIMELINE_CSP, TIMELINE_SANDBOX } from '../../src/renderer/detailHtml';
import { taskEntry } from '../../src/data/detail';
import type { ItemDetail } from '../../src/shared/actions';

const QUESTION = '- [ ] **A.** one\n- [ ] **B.** two\n';
const BOXES =
  '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox" aria-label="Incomplete task"> <strong>A.</strong> one</li>' +
  '<li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox" aria-label="Incomplete task"> <strong>B.</strong> two</li></ul>';
/** what GitHub's HTML must never get to run: each reports itself */
const INJECTED =
  '<p>INJECTED</p><script>parent.postMessage({cavil:"pwned-script"},"*")</script>' +
  '<img alt="i" src="data:image/png;base64,xx" onerror="parent.postMessage({cavil:\'pwned-onerror\'},\'*\')">' +
  '<button id="inj" onclick="parent.postMessage({cavil:\'pwned-onclick\'},\'*\')">inj</button>';
const PWNED = ['pwned-onclick', 'pwned-onerror', 'pwned-script'];

const detail: ItemDetail = {
  key: 'o/r#1',
  repo: 'o/r',
  number: 1,
  kind: 'issue',
  title: 't',
  url: 'https://github.com/o/r/issues/1',
  state: 'open',
  pr: null,
  fetchedAt: 0,
  labels: [],
  timeline: [
    { kind: 'comment', id: 'C_Q', url: '', author: 'a', at: '2026-11-02T00:00:00Z', bodyHtml: BOXES, tasks: taskEntry(BOXES, QUESTION, true) },
    { kind: 'comment', id: 'C_INJ', url: '', author: 'b', at: '2026-11-01T00:00:00Z', bodyHtml: INJECTED },
  ],
};
const realFrame = timelineDocument(detail, false, 'all', { render: 'r1', canTick: true });
/** the frame document with its own policy loosened (test page only): any inline script or handler may run */
const looseFrame = realFrame.replace(`content="${TIMELINE_CSP}"`, `content="${TIMELINE_CSP.replace(/script-src [^;]*/, "script-src 'unsafe-inline'")}"`);
const LOOSE_WINDOW = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const APP_WINDOW = appCsp("'self'");

let browser: Browser;
let server: http.Server;
let page: { window: string; frame: string } = { window: '', frame: '' };
test.beforeAll(async () => {
  browser = await (process.env.CAVIL_E2E_ENGINE === 'chromium' ? chromium : webkit).launch();
  server = http.createServer((req, res) => {
    if (req.url === '/record.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end("window.got = []; window.addEventListener('message', function (e) { window.got.push(e.data && e.data.cavil); });");
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': page.window });
    res.end(`<!doctype html><script src="/record.js"></script><iframe sandbox="${TIMELINE_SANDBOX}" style="width:600px;height:400px" srcdoc="${escapeHtml(page.frame)}"></iframe>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});
test.afterAll(async () => {
  server.close();
  await browser.close();
});

/** load the window (policy `window`) holding the frame document `frame`; open + click everything; what reported in */
async function run(window: string, frame: string) {
  page = { window, frame };
  const p = await browser.newPage();
  await p.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  const f = p.frames().find((x) => x !== p.mainFrame())!;
  await f.waitForLoadState();
  await p.waitForTimeout(300);
  await f.locator('#inj').click();
  await f.locator('input[data-task="1"]').click({ timeout: 2_000 }).catch(() => undefined);
  await p.waitForTimeout(400);
  const got = ((await p.evaluate(() => (window as any).got)) as string[]).filter(Boolean);
  // never same-origin: the frame cannot reach the window's objects, whatever runs in it
  const reach = await f.evaluate(() => {
    try {
      return parent.document ? 'reached' : 'blocked';
    } catch {
      return 'blocked';
    }
  });
  await p.close();
  return { ran: [...new Set(got)].sort(), reach };
}

test('GitHub#193: the frame\'s own policy alone (window loosened in this test page): the frame script runs, nothing injected does', async () => {
  const r = await run(LOOSE_WINDOW, realFrame);
  expect(r.ran).toEqual(expect.arrayContaining(['ready', 'task']));
  expect(r.ran.filter((m) => PWNED.includes(m))).toEqual([]);
  expect(r.reach).toBe('blocked');
});

test('GitHub#193: the window\'s policy alone (tauri.conf.json; frame policy loosened in this test page): the frame script runs, nothing injected does', async () => {
  expect(APP_WINDOW).toMatch(/script-src 'self' 'sha256-[^']+'(;|$)/);
  const r = await run(APP_WINDOW, looseFrame);
  expect(r.ran).toEqual(expect.arrayContaining(['ready', 'task']));
  expect(r.ran.filter((m) => PWNED.includes(m))).toEqual([]);
  expect(r.reach).toBe('blocked');
});

test('GitHub#193: both policies as shipped: the frame script runs and reports a ticked box, nothing injected does', async () => {
  const r = await run(APP_WINDOW, realFrame);
  expect(r.ran).toEqual(expect.arrayContaining(['ready', 'task']));
  expect(r.ran.filter((m) => PWNED.includes(m))).toEqual([]);
  expect(r.reach).toBe('blocked');
});

test('GitHub#193: this page can see an injection run (both layers loosened in the test page only) — so "did not run" above means something', async () => {
  const r = await run(LOOSE_WINDOW, looseFrame);
  expect(r.ran).toEqual(expect.arrayContaining([...PWNED, 'ready', 'task']));
});
