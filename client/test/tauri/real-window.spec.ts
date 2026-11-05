// The real Tauri app (GitHub#151 review round 1): the debug build of src-tauri,
// its own system-WebKit window, Tauri's IPC, the shell's navigation and
// new-window handlers — driven over WebDriver (tauri-driver + WebKitWebDriver,
// Linux only), against the fake GitHub on loopback in test mode. Nothing here
// re-implements the shell: a link opens in "the browser" only if the app's own
// handler sends it to the back end, which records it (test mode) in a file.
//
//   npm run test:tauri          (CI: xvfb-run; needs tauri-driver and WebKitWebDriver)

import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { WebDriver, until } from './webdriver';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = process.env.CAVIL_TAURI_APP ?? join(root, 'src-tauri', 'target', 'debug', 'cavil-loop-client');
const DRIVER = process.env.CAVIL_TAURI_DRIVER ?? 'tauri-driver';
const screens = join(root, 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

let fake: FakeGitHub;
let driver: ChildProcess;
let wd: WebDriver;
let opened: string;
let dir: string;

const openedUrls = () => (existsSync(opened) ? readFileSync(opened, 'utf8').split('\n').filter(Boolean) : []);
const card = (n: number) => `[data-testid="card"][data-key="gigleai/cavil-loop#${n}"]`;

test.beforeEach(async () => {
  test.skip(process.platform !== 'linux', 'WebDriver for Tauri windows exists on Linux / Windows only');
  if (!existsSync(APP)) throw new Error(`no app binary at ${APP}: cargo build -p cavil-loop-client first`);
  fake = await startFakeGitHub();
  dir = mkdtempSync(join(tmpdir(), 'cavil-tauri-'));
  opened = join(dir, 'opened.txt');
  // the app inherits the driver's environment: test mode, loopback GitHub, throw-away profile
  driver = spawn(DRIVER, [], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      CAVIL_CLIENT_TEST_MODE: '1',
      CAVIL_CLIENT_TEST_API: fake.api,
      CAVIL_CLIENT_TEST_WEB: fake.web,
      CAVIL_CLIENT_TEST_CREDENTIAL_FILE: join(dir, 'cred'),
      CAVIL_CLIENT_TEST_OPENED_FILE: opened,
      CAVIL_CLIENT_USER_DATA: join(dir, 'profile'),
    },
  });
  wd = new WebDriver();
  await until(async () => (await fetch('http://127.0.0.1:4444/status')).ok, 'tauri-driver up');
  await wd.start(APP);
});

test.afterEach(async ({}, info) => {
  if (wd && info.status !== 'skipped') {
    try {
      writeFileSync(join(screens, `tauri-${info.title.slice(0, 40).replace(/\W+/g, '-')}.png`), await wd.screenshot());
    } catch {
      /* window already gone */
    }
    await wd.stop();
  }
  driver?.kill();
  await fake?.close();
});

test('real app: sign in, sync, change a label, detail links and navigation go to the browser through the shell', async () => {
  fake.state.w.comments.set('gigleai/cavil-loop#138', [
    { id: 'C-new', url: 'https://github.com/GigleAI/cavil-loop/issues/138#c2', createdAt: '2026-11-02T01:00:00Z', bodyHTML: '<p>newer comment <a href="https://github.com/GigleAI/cavil-loop">link</a></p>', author: { login: 'user-3' } },
  ]);

  // the window really is the app's: Tauri's IPC is there, the page is the app's own
  await wd.find('[data-testid="app-root"]');
  expect(await wd.exec<boolean>('return typeof window.__TAURI_INTERNALS__ === "object"')).toBe(true);
  const appUrl = await wd.url();
  expect(appUrl).toMatch(/^(tauri:\/\/localhost|http:\/\/tauri\.localhost)\//);

  // sign in (device flow through the back end); "open the GitHub page" goes through IPC → back end → browser
  await wd.click('[data-testid="oauth-settings-toggle"]');
  await wd.type('[data-testid="client-id"]', fake.state.oauthClientId);
  await wd.click('[data-testid="save-client-id"]');
  await wd.click('[data-testid="start-login"]');
  await wd.find('[data-testid="user-code"]');
  await wd.click('[data-testid="open-browser"]');
  await until(() => openedUrls().includes(`${fake.web}/login/device`), 'verification page opened');
  fake.resolveGrant('approved');
  await wd.find('[data-testid="board"]');
  expect(readFileSync(join(dir, 'cred'), 'utf8')).toMatch(/^gho_/);

  // a source, a sync round signed by the back end
  await wd.click('[data-testid="open-settings"]');
  await wd.type('[data-testid="source-input"]', 'GigleAI/cavil-loop');
  await wd.click('[data-testid="source-add"]');
  await wd.click('[data-testid="back"]');
  await wd.find(card(138), 30_000);
  expect(fake.log.some((l) => l.path.startsWith('/api/') && l.auth?.startsWith('Bearer gho_'))).toBe(true);

  // a change: one label added on GitHub, the card re-read
  await wd.click(card(138));
  await wd.find('[data-testid="detail"][data-key="gigleai/cavil-loop#138"]');
  await wd.find('[data-testid="label-add"] option[value="Done"]');
  await wd.exec(
    `const s = document.querySelector('[data-testid="label-add"]');
     const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
     set.call(s, 'Done'); s.dispatchEvent(new Event('change', { bubbles: true }));`,
  );
  await until(() => fake.log.some((l) => l.method === 'POST' && l.path.endsWith('/issues/138/labels')), 'label POST reached GitHub');
  await until(async () => (await wd.count(`${card(138)} .label`)) > 0 && (await wd.text(card(138))).includes('Done'), 'card shows the new label');

  // GitHub's HTML in the sandboxed frame: a link there asks for a new window — the shell's
  // handler sends it to the browser, the window itself stays where it is
  await wd.frame('[data-testid="timeline-frame"]');
  await wd.click('a[href="https://github.com/GigleAI/cavil-loop"]');
  await wd.frame(null);
  await until(() => openedUrls().includes('https://github.com/GigleAI/cavil-loop'), 'frame link opened in the browser');
  expect(await wd.url()).toBe(appUrl);

  // the window is asked to navigate away: the shell refuses, a GitHub address goes to the browser
  await wd.exec(`window.location.href = 'https://github.com/GigleAI/cavil-loop/issues/1'`);
  await until(() => openedUrls().includes('https://github.com/GigleAI/cavil-loop/issues/1'), 'navigation handed to the browser');
  await new Promise((r) => setTimeout(r, 500));
  expect(await wd.url()).toBe(appUrl);
  await wd.find('[data-testid="board"]');

  // "open on the web" goes through IPC → back end → browser; a non-GitHub address is refused
  await wd.click('[data-testid="detail-open-web"]');
  await until(() => openedUrls().some((u) => u.startsWith('https://github.com/GigleAI/cavil-loop/issues/138')), 'detail opened on the web');
  await wd.exec(`window.location.href = 'https://example.com/'`);
  await new Promise((r) => setTimeout(r, 500));
  expect(openedUrls()).not.toContain('https://example.com/');
  expect(await wd.url()).toBe(appUrl);
});
