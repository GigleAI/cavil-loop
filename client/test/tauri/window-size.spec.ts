// The real Tauri app comes back at the window size it was left at (GitHub#333). Same real
// app as real-window.spec.ts (debug build, its own system-WebKit window), driven over
// WebDriver in test mode.
//
// The size is read from the window itself (the page's innerWidth / innerHeight: the real
// window's content area at 100 % zoom), never only from what the shell says it asked for.
// The resize goes through the shell's test control file ("resize <w> <h>", desktop.rs): the
// same size change the system makes when a user drags the window's edge, followed by the same
// events. What the shell kept and what a start was built with are read from its test record
// (CAVIL_CLIENT_TEST_ALERTS_FILE): "windowKept" / "window".
//
// The app is quit by ending the WebDriver session, which gives it no chance to save on the
// way out — so what comes back is what was kept while the window was changing.
//
// The other three moments the size is kept — the window is closed, the app quits, the app
// restarts itself for an update — each have a test of their own below. There the "window has
// been still" wait is set far longer than the test (CAVIL_CLIENT_TEST_WINDOW_STILL_MS), so
// nothing is kept by the resize itself: what the next start comes back at was kept by that
// moment alone, and each test first checks nothing had been kept before it.
//
// Not covered here: where the window is (a headless display has no window manager to place
// it), maximized, several screens. Their rules are tested in crates/core/src/window_state.rs.

import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { WebDriver, until } from './webdriver';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = process.env.CAVIL_TAURI_APP ?? join(root, 'src-tauri', 'target', 'debug', 'cavil-loop-client');
const DRIVER = process.env.CAVIL_TAURI_DRIVER ?? 'tauri-driver';

let fake: FakeGitHub;
let driver: ChildProcess | null = null;
let wd: WebDriver;
let dir: string;
let record: string;
let control: string;

/** the shell's record, whole lines only (the last one may still be being written) */
const records = (): any[] => {
  if (!existsSync(record)) return [];
  const text = readFileSync(record, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

let starts = 0;

async function startApp(args: string[] = [], env: Record<string, string> = {}) {
  // a control file of its own for every start, so no start can act on what an earlier one was told
  control = join(dir, `control-${++starts}.txt`);
  driver = spawn(DRIVER, [], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      CAVIL_CLIENT_TEST_MODE: '1',
      CAVIL_CLIENT_TEST_API: fake.api,
      CAVIL_CLIENT_TEST_WEB: fake.web,
      CAVIL_CLIENT_TEST_CREDENTIAL_FILE: join(dir, 'cred'),
      CAVIL_CLIENT_TEST_OPENED_FILE: join(dir, 'opened.txt'),
      CAVIL_CLIENT_USER_DATA: join(dir, 'profile'),
      CAVIL_CLIENT_TEST_ALERTS_FILE: record,
      CAVIL_CLIENT_TEST_CONTROL_FILE: control,
      ...env,
    },
  });
  wd = new WebDriver();
  await until(async () => (await fetch('http://127.0.0.1:4444/status')).ok, 'tauri-driver up');
  await wd.start(APP, args);
}

/** every process of this test's app (its environment names this test's record file) */
function running(): number[] {
  const mark = `CAVIL_CLIENT_TEST_ALERTS_FILE=${record}`;
  const out: number[] = [];
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try {
      if (readFileSync(`/proc/${p}/environ`, 'latin1').split('\0').includes(mark)) out.push(Number(p));
    } catch {
      /* gone meanwhile, or not ours to read */
    }
  }
  return out;
}

/** Quit the app and wait until it is really gone: the next start must be the only writer of the record. */
async function stopApp() {
  await wd?.stop();
  driver?.kill();
  driver = null;
  if (!record) return;
  try {
    await until(() => running().length === 0, 'the app quit', 10_000);
  } catch {
    for (const pid of running()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    await until(() => running().length === 0, 'the app quit after SIGKILL', 10_000);
  }
}

/** the real window's content size */
const size = async (): Promise<[number, number]> => wd.exec('return [window.innerWidth, window.innerHeight]');
const sizeIs = (w: number, h: number) => async () => {
  const s = await size();
  return s[0] === w && s[1] === h;
};

test.beforeEach(async () => {
  test.skip(process.platform !== 'linux', 'WebDriver for Tauri windows exists on Linux / Windows only');
  if (!existsSync(APP)) throw new Error(`no app binary at ${APP}: cargo build -p cavil-loop-client first`);
  fake = await startFakeGitHub();
  dir = mkdtempSync(join(tmpdir(), 'cavil-tauri-win-'));
  record = join(dir, 'desktop.jsonl');
});

test.afterEach(async () => {
  await stopApp();
  await fake?.close();
  console.log(records().map((r) => JSON.stringify(r).slice(0, 160)).join('\n'));
});

test('real app (GitHub#333): a restart comes back at the window size it was left at, shown or started hidden', async () => {
  // first start, nothing kept: the default size
  await startApp();
  await wd.find('[data-testid="start-login"], [data-testid="oauth-settings-toggle"]');
  expect(records().find((r) => r.op === 'window')).toMatchObject({ kept: false, w: 1280, h: 820, maximized: false });
  await until(sizeIs(1280, 820), 'default size on screen');

  // the window is resized: the real window follows, and the shell keeps that size
  appendFileSync(control, 'resize 1011 677\n');
  await until(sizeIs(1011, 677), 'resized on screen');
  await until(() => records().some((r) => r.op === 'windowKept' && r.ok === true && r.w === 1011 && r.h === 677 && r.maximized === false), 'the new size kept', 10_000);

  // a second resize right after: the last one is what is kept (not the first, not something in between)
  appendFileSync(control, 'resize 900 600\n');
  appendFileSync(control, 'resize 1111 707\n');
  await until(sizeIs(1111, 707), 'resized again on screen');
  await until(() => records().filter((r) => r.op === 'windowKept').pop()?.w === 1111, 'the last size kept', 10_000);
  expect(records().filter((r) => r.op === 'windowKept').pop()).toMatchObject({ ok: true, w: 1111, h: 707 });

  // restart: built with the kept size, and the real window has it
  await stopApp();
  let from = records().length;
  await startApp();
  await wd.find('[data-testid="start-login"], [data-testid="oauth-settings-toggle"]');
  expect(records().slice(from).find((r) => r.op === 'window')).toMatchObject({ kept: true, w: 1111, h: 707, maximized: false });
  await until(sizeIs(1111, 707), 'kept size on screen after the restart');
  expect(await size()).toEqual([1111, 707]);

  // started hidden (launch at login): nothing is kept from a window that is not on screen,
  // and once it is shown it has the kept size
  await stopApp();
  from = records().length;
  await startApp(['--hidden']);
  await until(() => records().slice(from).some((r) => r.op === 'start' && r.hidden === true), 'started hidden', 15_000);
  expect(records().slice(from).find((r) => r.op === 'window')).toMatchObject({ kept: true, w: 1111, h: 707 });
  // what a click on a notification does: the window is shown
  appendFileSync(control, 'click {}\n');
  await until(() => records().slice(from).some((r) => r.op === 'shown'), 'shown', 10_000);
  await until(sizeIs(1111, 707), 'kept size on screen once shown');
  // long enough for a look at the shown window to have happened
  await new Promise((r) => setTimeout(r, 1500));
  expect(await size()).toEqual([1111, 707]);
  expect(records().slice(from).filter((r) => r.op === 'windowKept' && (r.w !== 1111 || r.h !== 707))).toEqual([]);
});

/** the resize itself keeps nothing for the length of a test: only the moment under test does */
const NEVER_STILL = { CAVIL_CLIENT_TEST_WINDOW_STILL_MS: '600000' };
const kept = (from = 0) => records().slice(from).filter((r) => r.op === 'windowKept');

/** Start, resize to 1011×677, and check the real window has that size while nothing was kept. */
async function resizedButNotKept(env: Record<string, string> = {}) {
  await startApp([], { ...NEVER_STILL, ...env });
  await wd.find('[data-testid="start-login"], [data-testid="oauth-settings-toggle"]');
  await until(sizeIs(1280, 820), 'default size on screen');
  appendFileSync(control, 'resize 1011 677\n');
  await until(sizeIs(1011, 677), 'resized on screen');
  // well past the product's own wait (0.4 s): with the wait set long, the resize kept nothing
  await new Promise((r) => setTimeout(r, 1500));
  expect(kept()).toEqual([]);
}

/** A plain start afterwards (the product's own timing): built with 1011×677, and the real window has it. */
async function comesBackResized() {
  const from = records().length;
  await startApp();
  await wd.find('[data-testid="start-login"], [data-testid="oauth-settings-toggle"]');
  expect(records().slice(from).find((r) => r.op === 'window')).toMatchObject({ kept: true, w: 1011, h: 677, maximized: false });
  await until(sizeIs(1011, 677), 'kept size on screen after the restart');
}

test('real app (GitHub#333): closing the window keeps its size, before it is hidden', async () => {
  // closing hides the window, as on macOS
  await resizedButNotKept({ CAVIL_CLIENT_TEST_HIDE_ON_CLOSE: '1' });
  appendFileSync(control, 'close\n');
  await until(() => records().some((r) => r.op === 'hidden'), 'window hidden', 10_000);
  const ops = records().map((r) => r.op);
  expect(kept()).toMatchObject([{ ok: true, w: 1011, h: 677, maximized: false }]);
  // kept while it was still on screen: a hidden window is never looked at
  expect(ops.indexOf('windowKept')).toBeLessThan(ops.indexOf('hidden'));
  await stopApp();
  await comesBackResized();
});

test('real app (GitHub#333): quitting the app keeps the window size', async () => {
  await resizedButNotKept();
  appendFileSync(control, 'quit\n');
  await until(() => kept().length > 0, 'kept on the way out', 10_000);
  expect(kept()).toMatchObject([{ ok: true, w: 1011, h: 677, maximized: false }]);
  // it really quit by itself: nothing of it is left once the driver is gone too
  await wd.stop();
  driver?.kill();
  driver = null;
  await until(() => running().length === 0, 'the app quit by itself', 10_000);
  await comesBackResized();
});

test('real app (GitHub#333): the restart an installed update asks for keeps the window size, and the new start has it', async () => {
  await resizedButNotKept();
  const from = records().length;
  appendFileSync(control, 'restart\n');
  // kept before the old process went away …
  await until(() => kept().length > 0, 'kept before the restart', 10_000);
  expect(kept()).toMatchObject([{ ok: true, w: 1011, h: 677, maximized: false }]);
  const ops = records().slice(from).map((r) => r.op);
  expect(ops.indexOf('restart')).toBeGreaterThanOrEqual(0);
  // … and the app's own new start (not one this test made) is built with it
  await until(() => records().slice(from).some((r) => r.op === 'window'), 'the app started again by itself', 60_000);
  expect(records().slice(from).find((r) => r.op === 'window')).toMatchObject({ kept: true, w: 1011, h: 677, maximized: false });
  // a start made by the test afterwards: the real window has the size
  await stopApp();
  await comesBackResized();
});
