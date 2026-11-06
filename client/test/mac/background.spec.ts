// The packaged macOS app (GitHub#169) keeps syncing and reminding with its
// window closed and when started hidden (launch at login), and comes back when
// the Dock icon is clicked. The real .app the dmg carries, its own WebKit window,
// against the fake GitHub on loopback in test mode; the profile is seeded as
// signed in (no window to type into while it is hidden).
//
// Pass / fail is the window's own work, never a sign of life: within 120 s of a
// label being put on GitHub the window must have run a new complete round and
// asked for that item's notification and the new badge, its window hidden the
// whole time. The shell keeps the beat at the app's real 60 s. In test mode the
// notification is recorded instead of shown (CAVIL_CLIENT_TEST_ALERTS_FILE):
// whether macOS shows a real one is the separate, record-only --notify-check.
//
//   CAVIL_MAC_APP=/path/to/Cavil\ Loop.app npx playwright test -c playwright.mac.config.ts
//
// Off a Mac (only to try the check itself, under xvfb): CAVIL_BG_BIN=<the Linux build>; the
// window is then hidden on close by the test switch, and the Dock-icon step is skipped.

import { test, expect } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeGitHub, type FakeGitHub } from '../fake-github/server';
import { Cache } from '../support/cache';
import { parseSource } from '../../src/shared/sources';

const APP = process.env.CAVIL_MAC_APP ?? '';
const BIN = process.env.CAVIL_BG_BIN ?? (APP ? join(APP, 'Contents', 'MacOS', 'Cavil Loop') : '');
const MAC = process.platform === 'darwin';
const REPO = 'gigleai/cavil-loop';
const GATE_MS = 120_000;
const TOKEN = 'gho_faketoken000000000000000000000001';

let fake: FakeGitHub;
let dir: string;
let record: string;
let control: string;
let proc: ChildProcess | null = null;

const records = (): any[] => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastBadge = (from = 0) => records().slice(from).filter((r) => r.op === 'badge').pop()?.count as number | undefined;
const notified = (key: string) => records().some((r) => r.op === 'notify' && r.alert?.kind === 'item' && r.alert.key === key);

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
  await until(() => lastBadge() !== undefined, 'first round counted', 60_000);
  const badgeBefore = lastBadge()!;
  appendFileSync(control, 'close\n');
  await until(() => records().some((r) => r.op === 'hidden'), 'window hidden, app still running', 15_000);
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
  await until(() => lastBadge() !== undefined, 'first round while started hidden', 60_000);
  const from = records().length;
  const badgeBefore = lastBadge()!;
  const n = unlabelled();
  label(n);
  await until(() => notified(`${REPO}#${n}`) && lastBadge(from) === badgeBefore + 1, 'synced while started hidden: the new item notified, badge +1', GATE_MS);
  const all = records();
  expect(all.filter((r) => r.op === 'tick').length).toBeGreaterThan(0);
  expect(all.filter((r) => r.op === 'tick').every((r) => r.visible === false)).toBe(true);
  expect(all.some((r) => r.op === 'shown')).toBe(false);
});
