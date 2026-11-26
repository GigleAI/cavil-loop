// GigleAI/cavil-loop#733: the recovery the stuck-sync hover and the client guide give — "quit the client
// completely and open it again" — done literally on the real Tauri app (debug build, its own system-WebKit
// window, Tauri's IPC, driven over WebDriver in test mode against the fake GitHub). Linux only: WebDriver
// for Tauri windows does not exist on macOS (the platform the steps were written for, not checked here).
//
// The quit is the control file's "quit" — the way the app's Quit menu item quits (desktop.rs) — not closing
// the window, which keeps the app running in the background (checked first: closing leaves it running).
// After the reopen: still signed in (no sign-in page), the board's data is there from the start, the first
// round checks GitHub and the header shows "上次检查" with no stall.

import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { WebDriver, until } from './webdriver';
import { firstReadDone } from './first-round';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = process.env.CAVIL_TAURI_APP ?? join(root, 'src-tauri', 'target', 'debug', 'cavil-loop-client');
const DRIVER = process.env.CAVIL_TAURI_DRIVER ?? 'tauri-driver';
const REPO = 'gigleai/cavil-loop';

let fake: FakeGitHub;
let driver: ChildProcess | null = null;
let wd: WebDriver;
let dir: string;
let record: string;
let control: string;
let starts = 0;

const records = (): any[] => {
  if (!existsSync(record)) return [];
  const text = readFileSync(record, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

async function startApp() {
  // a control file of its own for every start: no start acts on what an earlier one was told
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
      // closing the window hides it, as on macOS / Windows
      CAVIL_CLIENT_TEST_HIDE_ON_CLOSE: '1',
      CAVIL_CLIENT_TEST_CONTROL_FILE: control,
    },
  });
  wd = new WebDriver();
  await until(async () => (await fetch('http://127.0.0.1:4444/status')).ok, 'tauri-driver up');
  await wd.start(APP, []);
}

/** this test's app process (its environment names this test's record file), not the drivers */
function appRunning(): number[] {
  const mark = `CAVIL_CLIENT_TEST_ALERTS_FILE=${record}`;
  const out: number[] = [];
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try {
      if (!readFileSync(`/proc/${p}/environ`, 'latin1').split('\0').includes(mark)) continue;
      if (readFileSync(`/proc/${p}/comm`, 'utf8').trim().startsWith('cavil-loop')) out.push(Number(p));
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

async function endDriver() {
  await wd?.stop().catch(() => {});
  driver?.kill();
  driver = null;
}

test.beforeEach(async () => {
  test.skip(process.platform !== 'linux', 'WebDriver for Tauri windows exists on Linux / Windows only');
  if (!existsSync(APP)) throw new Error(`no app binary at ${APP}: cargo build -p cavil-loop-client first`);
  fake = await startFakeGitHub();
  dir = mkdtempSync(join(tmpdir(), 'cavil-tauri-quit-'));
  record = join(dir, 'desktop.jsonl');
});

test.afterEach(async () => {
  await endDriver();
  for (const pid of appRunning()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await fake?.close();
  console.log(records().map((r) => JSON.stringify(r).slice(0, 160)).join('\n'));
});

test('real app (GitHub#733): "quit completely and open again" — closing the window is not quitting; Quit ends the app; the reopened app is signed in, has its data and checks GitHub', async () => {
  test.setTimeout(240_000);
  await startApp();
  // sign in and add the repository
  await wd.click('[data-testid="oauth-settings-toggle"]');
  await wd.type('[data-testid="client-id"]', fake.state.oauthClientId);
  await wd.click('[data-testid="save-client-id"]');
  await wd.click('[data-testid="start-login"]');
  await wd.find('[data-testid="user-code"]');
  fake.resolveGrant('approved');
  await wd.find('[data-testid="board"]');
  await wd.click('[data-testid="open-settings"]');
  await wd.type('[data-testid="source-input"]', 'GigleAI/cavil-loop');
  await wd.click('[data-testid="source-add"]');
  await wd.click('[data-testid="back"]');
  await wd.find('[data-testid="card"]', 30_000);
  await until(() => firstReadDone(fake.log, 0, REPO), 'first complete read', 30_000);
  const cards = await wd.exec<number>('return document.querySelectorAll(\'[data-testid="card"]\').length');
  expect(cards).toBeGreaterThan(0);

  // closing the window is not quitting: the app keeps running (hidden)
  appendFileSync(control, 'close\n');
  await until(() => records().some((r) => r.op === 'hidden'), 'window hidden', 10_000);
  await new Promise((r) => setTimeout(r, 1000));
  expect(appRunning().length).toBeGreaterThan(0);

  // Quit (the Quit menu item's way): the app process ends by itself
  appendFileSync(control, 'quit\n');
  await until(() => appRunning().length === 0, 'the app quit by itself', 15_000);
  await endDriver();

  // open it again
  const from = fake.log.length;
  await startApp();
  // still signed in: the board comes, never the sign-in page; the data is there
  await wd.find('[data-testid="board"]', 30_000);
  expect(await wd.exec<number>('return document.querySelectorAll(\'[data-testid="start-login"]\').length')).toBe(0);
  await wd.find('[data-testid="card"]', 30_000);
  // the first round of the new start checks GitHub
  await until(() => firstReadDone(fake.log, from, REPO), 'the reopened app read the repository again', 60_000);
  await until(
    async () => (await wd.exec<string>('const e = document.querySelector(\'[data-testid="sync-status"]\'); return e ? e.textContent : ""')).includes('上次检查'),
    'the header shows the check',
    30_000,
  );
  expect(await wd.exec<number>('return document.querySelectorAll(\'[data-testid="sync-stall"]\').length')).toBe(0);
  expect(await wd.exec<number>('return document.querySelectorAll(\'[data-testid="card"]\').length')).toBe(cards);
});
