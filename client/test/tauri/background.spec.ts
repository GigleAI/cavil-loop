// The real Tauri app keeps syncing and reminding with its window closed, and
// when started hidden (launch at login) — GitHub#169. Same real app as
// real-window.spec.ts (debug build, its own system-WebKit window, Tauri's IPC),
// driven over WebDriver against the fake GitHub in test mode.
//
// Pass / fail is the window's own work, never a sign of life: within 120 s of a
// label being put on GitHub the window must have run a new complete round and
// asked the shell for that item's notification and the new badge — with its
// window hidden the whole time. The shell keeps the beat at the app's real 60 s.
// 120 s: #139 promises a notification within 2 minutes; the beat comes at most
// 60 s after the label, one round reads well within the rest.
//
// What the shell does is read from its test record (CAVIL_CLIENT_TEST_ALERTS_FILE,
// src-tauri/src/desktop.rs). Linux has no "hide on close" in the product (v1:
// macOS only), so the test asks for it (CAVIL_CLIENT_TEST_HIDE_ON_CLOSE) — the
// same handler macOS runs. The Dock-icon reopen is macOS-only: checked by
// scripts/mac-open-check.sh on the CI Macs.

import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { WebDriver, until } from './webdriver';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = process.env.CAVIL_TAURI_APP ?? join(root, 'src-tauri', 'target', 'debug', 'cavil-loop-client');
const DRIVER = process.env.CAVIL_TAURI_DRIVER ?? 'tauri-driver';
const REPO = 'gigleai/cavil-loop';
const GATE_MS = 120_000;

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
const notified = (key: string) => records().some((r) => r.op === 'notify' && r.alert?.kind === 'item' && r.alert.key === key);
const lastBadge = () => records().filter((r) => r.op === 'badge').pop()?.count as number | undefined;

async function startApp(args: string[] = []) {
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
      CAVIL_CLIENT_TEST_HIDE_ON_CLOSE: '1',
      CAVIL_CLIENT_TEST_CONTROL_FILE: control,
    },
  });
  wd = new WebDriver();
  await until(async () => (await fetch('http://127.0.0.1:4444/status')).ok, 'tauri-driver up');
  await wd.start(APP, args);
}

async function stopApp() {
  await wd?.stop();
  driver?.kill();
  driver = null;
}

/** An open issue of the repository that does not carry the label yet. */
function unlabelled(skip: number[] = []): number {
  const i = fake.state.repos.get(REPO)!.find((x: any) => x.state === 'open' && !x.pull_request && !skip.includes(x.number) && !x.labels.some((l: any) => (l.name ?? l) === 'pending/human'));
  return i.number;
}

/** Put the label on GitHub (the fake), the way a maintainer does. */
function label(number: number) {
  const i = fake.state.repos.get(REPO)!.find((x: any) => x.number === number);
  i.labels = [...i.labels, { name: 'pending/human', color: 'ededed' }];
  i.updated_at = new Date().toISOString();
}

async function signInWithRepo() {
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
  // the first complete read is on the board (the reminders' baseline is taken in the same round)
  await wd.find('[data-testid="card"]', 30_000);
  await until(() => lastBadge() !== undefined, 'first round counted', 10_000);
}

test.beforeEach(async () => {
  test.skip(process.platform !== 'linux', 'WebDriver for Tauri windows exists on Linux / Windows only');
  if (!existsSync(APP)) throw new Error(`no app binary at ${APP}: cargo build -p cavil-loop-client first`);
  fake = await startFakeGitHub();
  dir = mkdtempSync(join(tmpdir(), 'cavil-tauri-bg-'));
  record = join(dir, 'desktop.jsonl');
  control = join(dir, 'control.txt');
});

test.afterEach(async () => {
  await stopApp();
  await fake?.close();
});

test('window closed: hidden, still syncing and reminding within 120 s; a click on the notification brings it back on that item', async () => {
  test.setTimeout(GATE_MS + 120_000);
  await startApp();
  await signInWithRepo();
  const badgeBefore = lastBadge()!;
  expect(badgeBefore).toBeGreaterThanOrEqual(0);

  // the close button's request: hidden, not quit
  appendFileSync(control, 'close\n');
  await until(() => records().some((r) => r.op === 'hidden'), 'window hidden, app still running', 10_000);
  const hiddenAt = records().length;

  const n = unlabelled();
  label(n);
  const key = `${REPO}#${n}`;
  const t0 = Date.now();
  await until(() => notified(key) && lastBadge() === badgeBefore + 1, 'synced while hidden: the new item notified, badge +1', GATE_MS);
  const after = records().slice(hiddenAt);
  // the window really stayed hidden: every beat since says so, and nothing showed it
  expect(after.filter((r) => r.op === 'tick').length).toBeGreaterThan(0);
  expect(after.filter((r) => r.op === 'tick').every((r) => r.visible === false)).toBe(true);
  expect(after.some((r) => r.op === 'shown')).toBe(false);
  console.log(`hidden-window round: notified ${Math.round((Date.now() - t0) / 1000)} s after the label`);

  // a click on that notification: the window comes back with the item's detail open
  const note = after.find((r) => r.op === 'notify' && r.alert?.key === key);
  appendFileSync(control, `click ${note.id}\n`);
  await until(() => records().some((r) => r.op === 'shown' && r.why === 'click'), 'shown after the click', 10_000);
  await wd.find(`[data-testid="detail"][data-key="${key}"]`, 15_000);
  // "click opened the item"
});

test('started hidden (launch at login): no window, still syncing and reminding within 120 s', async () => {
  test.setTimeout(GATE_MS + 150_000);
  // a first run signs in and adds the source, then quits
  await startApp();
  await signInWithRepo();
  await stopApp();
  const before = records().length;

  // started the way launch at login starts it
  await startApp(['--hidden']);
  await until(() => records().slice(before).some((r) => r.op === 'start' && r.hidden === true), 'started hidden', 15_000);
  // its own first round (signed in from the stored credential): every round sets the badge
  await until(() => records().slice(before).some((r) => r.op === 'badge'), 'first round while started hidden', 30_000);
  const badgeBefore = lastBadge()!;
  const n = unlabelled();
  label(n);
  const key = `${REPO}#${n}`;
  await until(() => notified(key) && lastBadge() === badgeBefore + 1, 'synced while started hidden: the new item notified, badge +1', GATE_MS);
  const since = records().slice(before);
  expect(since.filter((r) => r.op === 'tick').length).toBeGreaterThan(0);
  expect(since.filter((r) => r.op === 'tick').every((r) => r.visible === false)).toBe(true);
  expect(since.some((r) => r.op === 'shown')).toBe(false);
});
