// The packaged macOS app (GitHub#169) keeps syncing and reminding with its
// window closed and when started hidden (launch at login), and comes back when
// the Dock icon is clicked. The real .app the dmg carries, its own WebKit window,
// against the fake GitHub on loopback in test mode; the profile is seeded as
// signed in (no window to type into while it is hidden).
//
// Pass / fail is the window's own work, never a sign of life: within 120 s of a
// label being put on GitHub the window must have run a new complete round and
// asked for that item's notification and the new badge, its window hidden the
// whole time. The shell keeps the beat at the app's real 60 s. The closed window
// stays hidden for 6 minutes before the label goes on: by default macOS's WebKit
// suspends a page that has been off screen for about 5 minutes. In test mode the
// notification is recorded instead of shown (CAVIL_CLIENT_TEST_ALERTS_FILE):
// whether macOS shows a real one is the separate, record-only --notify-check.
//
//   CAVIL_MAC_APP=/path/to/Cavil\ Loop.app npx playwright test -c playwright.mac.config.ts
//
// Off a Mac (only to try the check itself, under xvfb): CAVIL_BG_BIN=<the Linux build>; the
// window is then hidden on close by the test switch, and the Dock-icon step is skipped.
//
// The label goes on only once this start's first complete round has been taken (GitHub#186):
// what that round already finds is the reminders' baseline and goes into one summary, never one
// notification per item. One item carries the label before the app starts (SEEDED), so the first
// round always ends in that summary and the badge after it (../tauri/first-round.ts). A badge
// record alone is no proof — the app clears the badge before it syncs; taking it as one put the
// label into the baseline on every arm64 CI run (the item never got its own notification).
// The slow-first-read case stages that order on purpose: the first read is held on the fake
// GitHub while the start-up badge is already there.

import { test, expect } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { Cache } from '../support/cache';
import { parseSource } from '../../src/shared/sources';
import { firstRoundBadge, inFrontAtFirstRound } from '../tauri/first-round';

const APP = process.env.CAVIL_MAC_APP ?? '';
const BIN = process.env.CAVIL_BG_BIN ?? (APP ? join(APP, 'Contents', 'MacOS', 'Cavil Loop') : '');
const MAC = process.platform === 'darwin';
const REPO = 'gigleai/cavil-loop';
const GATE_MS = 120_000;
const HIDDEN_FOR_MS = Number(process.env.CAVIL_BG_HIDDEN_FOR_MS ?? 6 * 60_000);
const TOKEN = 'gho_faketoken000000000000000000000001';

let fake: FakeGitHub;
let dir: string;
let record: string;
let control: string;
let proc: ChildProcess | null = null;
/** carries the label from before the app starts: the first round ends in a summary of 1 */
let SEEDED: number;

/** the shell's record, whole lines only (the last one may still be being written) */
const records = (): any[] => {
  if (!existsSync(record)) return [];
  const text = readFileSync(record, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const lastBadge = (from = 0) => records().slice(from).filter((r) => r.op === 'badge').pop()?.count as number | undefined;
const notified = (key: string) => records().some((r) => r.op === 'notify' && r.alert?.kind === 'item' && r.alert.key === key);

/** Wait for this start's first complete round (from = its first record); the badge it set. */
async function firstRound(ms: number, from = 0): Promise<number> {
  await until(() => firstRoundBadge(records(), from) !== null, 'first complete round: the summary and the badge after it', ms);
  return firstRoundBadge(records(), from)!;
}

async function until(fn: () => boolean, what: string, ms: number) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function env() {
  return {
    ...process.env,
    CAVIL_CLIENT_TEST_MODE: '1',
    CAVIL_CLIENT_TEST_API: fake.api,
    CAVIL_CLIENT_TEST_WEB: fake.web,
    CAVIL_CLIENT_TEST_CREDENTIAL_FILE: join(dir, 'cred'),
    CAVIL_CLIENT_TEST_OPENED_FILE: join(dir, 'opened.txt'),
    CAVIL_CLIENT_USER_DATA: join(dir, 'profile'),
    CAVIL_CLIENT_TEST_ALERTS_FILE: record,
    CAVIL_CLIENT_TEST_CONTROL_FILE: control,
    ...(MAC ? {} : { CAVIL_CLIENT_TEST_HIDE_ON_CLOSE: '1' }),
  };
}

function launch(args: string[] = []) {
  proc = spawn(BIN, args, { env: env(), stdio: ['ignore', 'inherit', 'inherit'] });
}

function unlabelled(): number {
  return fake.state.repos.get(REPO)!.find((x: any) => x.state === 'open' && !x.pull_request && !x.labels.some((l: any) => (l.name ?? l) === 'pending/human')).number;
}

function label(number: number) {
  const i = fake.state.repos.get(REPO)!.find((x: any) => x.number === number);
  i.labels = [...i.labels, { name: 'pending/human', color: 'ededed' }];
  i.updated_at = new Date().toISOString();
}

test.beforeEach(async () => {
  test.skip(!BIN || (MAC && !APP), 'the packaged macOS app (CAVIL_MAC_APP), on a Mac');
  fake = await startFakeGitHub();
  // the recording has nothing on the label: this one is the whole baseline
  expect(fake.state.repos.get(REPO)!.filter((x: any) => x.labels.some((l: any) => (l.name ?? l) === 'pending/human'))).toHaveLength(0);
  SEEDED = unlabelled();
  label(SEEDED);
  dir = mkdtempSync(join(tmpdir(), 'cavil-mac-bg-'));
  record = join(dir, 'desktop.jsonl');
  control = join(dir, 'control.txt');
  // signed in with one source, as a completed sign-in leaves it
  mkdirSync(join(dir, 'profile'), { recursive: true });
  writeFileSync(join(dir, 'cred'), TOKEN);
  const cache = new Cache(join(dir, 'profile', 'cache.sqlite'));
  cache.setSetting('trustedCredentials', [createHash('sha256').update(TOKEN).digest('hex')]);
  cache.setSetting('sources', [parseSource('GigleAI/cavil-loop')]);
  cache.close();
});

test.afterEach(async () => {
  proc?.kill('SIGKILL');
  proc = null;
  await fake?.close();
  console.log(records().map((r) => JSON.stringify(r).slice(0, 160)).join('\n'));
});

test('window closed: hidden, still syncing and reminding within 120 s; the Dock icon brings it back', async () => {
  launch();
  const badgeBefore = await firstRound(60_000);
  // the badge is the unread count (GitHub#185): the seeded item is unread unless the window was in front
  expect(badgeBefore).toBe(inFrontAtFirstRound(records()) ? 0 : 1);
  appendFileSync(control, 'close\n');
  await until(() => records().some((r) => r.op === 'hidden'), 'window hidden, app still running', 15_000);
  // past the point where WebKit's default policy would suspend a hidden page
  await new Promise((r) => setTimeout(r, HIDDEN_FOR_MS));
  const from = records().length;
  const n = unlabelled();
  label(n);
  const t0 = Date.now();
  await until(() => notified(`${REPO}#${n}`) && lastBadge(from) === badgeBefore + 1, 'synced while hidden: the new item notified, badge +1', GATE_MS);
  console.log(`hidden-window round: notified ${Math.round((Date.now() - t0) / 1000)} s after the label`);
  const after = records().slice(from);
  expect(after.filter((r) => r.op === 'tick').length).toBeGreaterThan(0);
  expect(after.filter((r) => r.op === 'tick').every((r) => r.visible === false)).toBe(true);
  expect(after.some((r) => r.op === 'shown')).toBe(false);
  expect(proc!.exitCode).toBeNull();
  if (!MAC) return;
  // the Dock icon: LaunchServices reopens the running app
  execFileSync('/usr/bin/open', [APP]);
  await until(() => records().some((r) => r.op === 'shown' && r.why === 'reopen'), 'Dock icon brought the window back', 20_000);
});

test('started hidden (launch at login): no window, still syncing and reminding within 120 s', async () => {
  launch(['--hidden']);
  await until(() => records().some((r) => r.op === 'start' && r.hidden === true), 'started hidden', 30_000);
  const badgeBefore = await firstRound(60_000);
  // started hidden: never in front, so the seeded item is unread (GitHub#185)
  expect(inFrontAtFirstRound(records())).toBe(false);
  expect(badgeBefore).toBe(1);
  const from = records().length;
  const n = unlabelled();
  label(n);
  await until(() => notified(`${REPO}#${n}`) && lastBadge(from) === badgeBefore + 1, 'synced while started hidden: the new item notified, badge +1', GATE_MS);
  const all = records();
  expect(all.filter((r) => r.op === 'tick').length).toBeGreaterThan(0);
  expect(all.filter((r) => r.op === 'tick').every((r) => r.visible === false)).toBe(true);
  expect(all.some((r) => r.op === 'shown')).toBe(false);
});

test('started hidden, first read slow: the label goes on only after the first complete round', async () => {
  const READ = '/repos/GigleAI/cavil-loop/issues';
  const release = fake.hold(READ);
  try {
    launch(['--hidden']);
    await until(() => records().some((r) => r.op === 'start' && r.hidden === true), 'started hidden', 30_000);
    // the first read has reached the fake and is held there (no answer sent yet)
    await until(() => fake.log.some((e) => e.path.includes(READ) && e.status === 0), 'first read held', 60_000);
    await until(() => lastBadge() !== undefined, 'start-up badge', 30_000);
    // the old wait would go now; the first round is not complete
    expect(fake.log.filter((e) => e.path.includes(READ)).every((e) => e.status === 0)).toBe(true);
    expect(firstRoundBadge(records())).toBeNull();
  } finally {
    release();
  }
  const badgeBefore = await firstRound(60_000);
  // started hidden: never in front, so the seeded item is unread (GitHub#185)
  expect(inFrontAtFirstRound(records())).toBe(false);
  expect(badgeBefore).toBe(1);
  const from = records().length;
  const n = unlabelled();
  label(n);
  await until(() => notified(`${REPO}#${n}`) && lastBadge(from) === badgeBefore + 1, 'slow first read: the new item notified, badge +1', GATE_MS);
  const all = records();
  expect(all.filter((r) => r.op === 'tick').every((r) => r.visible === false)).toBe(true);
  expect(all.some((r) => r.op === 'shown')).toBe(false);
});
