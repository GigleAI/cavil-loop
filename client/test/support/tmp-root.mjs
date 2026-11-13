// One private temporary folder per test run (GitHub#469).
//
// Every client test run (npm test / test:e2e / test:mutation / test:rust / test:tauri, and a bare
// `npx vitest` / `npx playwright test`) gets its own folder in the system temp dir and runs with
// TMPDIR pointing at it, so whatever a test creates with mkdtemp(tmpdir(), …) lands there and goes
// with the folder. A folder is removed only once nobody uses it any more, and "nobody uses it" is
// decided by a lock, never by looking at processes from outside:
//
//   - the folder holds a lock file; the run's command is started with that file open and locked
//     shared on a high descriptor (20) that children inherit, so the command and every process
//     under it — vitest's workers, the negative-control runner's own sessions, the Rust back end,
//     bash scripts — hold the lock for as long as they live;
//   - "is it in use" = open the file anew and try an exclusive lock without waiting: got it → no
//     one holds it → remove; "would block" → in use, keep; any other answer → cannot tell, keep.
//
// Creating a folder and reaping leftovers both happen under one machine-wide lock
// (<system temp>/.cavil-client-runs.lock, an empty file that is never removed: removing it would let
// two runs lock two different files of the same name). A creator holds it from mkdir until its own
// shared lock is on and the folder renamed from cavil-client-new-… to cavil-client-run-…, so a
// reaper holding it never sees a half-made folder of a live creator: any cavil-client-new-… it sees
// is a dead creator's. The judgement and the rename to cavil-client-del-… happen under that lock;
// the (slow) removal happens after it is released, and anyone may finish a cavil-client-del-….
//
// Node has no file locks, so the locking is done by perl (on every Linux distribution and macOS).
// Without perl nothing is created or reaped and the run stops with the reason — it never falls back
// to running in the system temp dir.
//
// "Is anything left over" is one rule everywhere (the CI check, the tests, the README's command):
// an entry of the system temp dir whose name starts with `cavil-`. The machine-wide lock starts with
// a dot on purpose and is not one.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MASTER = '.cavil-client-runs.lock';
export const LEFTOVER_PREFIX = 'cavil-';
export const LOCK_FD = 20;
const RUN = 'cavil-client-run-';

// Create a folder under the machine-wide lock, lock it shared, publish it, then either exec the
// command with the lock on descriptor 20 ("exec") or keep holding it until stdin closes ("hold").
// CAVIL_TMP_TEST_PAUSE (tests only): stop between "lock file created" and "locked", announce it by
// creating <pause>.reached and go on once <pause>.go exists.
const CREATE = String.raw`
use strict; use warnings;
use Fcntl qw(:flock O_RDWR O_CREAT F_GETFD F_SETFD FD_CLOEXEC);
use POSIX ();
my ($tmp, $id, $mode, @cmd) = @ARGV;
sub fail { print STDERR "cavil 临时目录：$_[0]\n"; exit 70 }
my $master = "$tmp/.cavil-client-runs.lock";
sysopen(my $m, $master, O_RDWR | O_CREAT, 0666) or fail("打不开总锁 $master：$!");
flock($m, LOCK_EX) or fail("锁不上总锁 $master：$!");
my $new = "$tmp/cavil-client-new-$id";
my $run = "$tmp/cavil-client-run-$id";
mkdir($new, 0700) or fail("建不了 $new：$!");
sysopen(my $l, "$new/.lock", O_RDWR | O_CREAT, 0600) or fail("建不了 $new/.lock：$!");
if (my $p = $ENV{CAVIL_TMP_TEST_PAUSE}) {
  open(my $r, '>', "$p.reached") or fail("pause: $!"); close($r);
  select(undef, undef, undef, 0.02) until -e "$p.go";
}
flock($l, LOCK_SH) or fail("锁不上 $new/.lock：$!");
rename($new, $run) or fail("改不了名 $new → $run：$!");
close($m);
defined(POSIX::dup2(fileno($l), ${LOCK_FD})) or fail("放不到描述符 ${LOCK_FD} 上：$!");
close($l);
open(my $h, '+<&=', ${LOCK_FD}) or fail("描述符 ${LOCK_FD}：$!");
my $fl = fcntl($h, F_GETFD, 0) or fail("描述符 ${LOCK_FD}：$!");
fcntl($h, F_SETFD, $fl & ~FD_CLOEXEC) or fail("描述符 ${LOCK_FD}：$!");
if ($mode eq 'exec') {
  delete $ENV{CAVIL_TMP_TEST_PAUSE};
  exec { $cmd[0] } @cmd or fail("启动不了 $cmd[0]：$!");
}
$| = 1;
print "ready\n";
1 while sysread(STDIN, my $buf, 4096);
exit 0;
`;

// Under the machine-wide lock: a cavil-client-new-… is a dead creator's; a cavil-client-run-… whose
// lock can be taken exclusively is unused. Both are renamed to cavil-client-del-…. One line per
// folder: "del NAME" / "busy NAME" / "unknown NAME REASON".
const REAP = String.raw`
use strict; use warnings;
use Fcntl qw(:flock O_RDWR O_RDONLY O_CREAT);
use POSIX qw(EWOULDBLOCK EAGAIN);
my ($tmp) = @ARGV;
my $master = "$tmp/.cavil-client-runs.lock";
sysopen(my $m, $master, O_RDWR | O_CREAT, 0666) or do { print STDERR "打不开总锁 $master：$!\n"; exit 70 };
flock($m, LOCK_EX) or do { print STDERR "锁不上总锁 $master：$!\n"; exit 70 };
opendir(my $d, $tmp) or do { print STDERR "读不了 $tmp：$!\n"; exit 70 };
my @names = sort grep { /^cavil-client-(new|run)-/ } readdir($d);
closedir($d);
$| = 1;
for my $e (@names) {
  (my $del = $e) =~ s/^cavil-client-(new|run)-/cavil-client-del-/;
  if ($e =~ /^cavil-client-new-/) {
    if (rename("$tmp/$e", "$tmp/$del")) { print "del $del\n" } else { print "unknown $e rename: $!\n" }
    next;
  }
  my $l;
  unless (sysopen($l, "$tmp/$e/.lock", O_RDONLY)) { print "unknown $e open: $!\n"; next }
  if (flock($l, LOCK_EX | LOCK_NB)) {
    if (rename("$tmp/$e", "$tmp/$del")) { print "del $del\n" } else { print "unknown $e rename: $!\n" }
  } elsif ($! == EWOULDBLOCK || $! == EAGAIN) {
    print "busy $e\n";
  } else {
    print "unknown $e flock: $!\n";
  }
  close($l);
}
exit 0;
`;

/** The system temp dir: the one a run was started from, even inside a run (TMPDIR = the run's folder). */
export function systemTmp(env = process.env) {
  return env.CAVIL_TMP_ROOT && env.CAVIL_TMP_SYSTEM ? env.CAVIL_TMP_SYSTEM : tmpdir();
}

/** Already inside a run's folder (started by the launcher or a framework hook)? */
export function insideRun(env = process.env) {
  return !!(env.CAVIL_TMP_ROOT && env.CAVIL_TMP_SYSTEM && existsSync(env.CAVIL_TMP_ROOT));
}

/** The one leftover rule: entries of `dir` whose name starts with `cavil-`. */
export function leftovers(dir) {
  return readdirSync(dir).filter((n) => n.startsWith(LEFTOVER_PREFIX)).sort();
}

/** null when perl can lock files here; otherwise the reason. */
export function lockToolProblem(env = process.env) {
  const r = spawnSync('perl', ['-MFcntl=:flock', '-MPOSIX', '-e', '1'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.error) return `找不到 perl（${r.error.code ?? r.error.message}）：客户端测试靠它给临时目录加锁，请先装上 perl`;
  if (r.status !== 0) return `perl 用不了文件锁：${String(r.stderr).trim()}`;
  return null;
}

/**
 * Reap every unused folder in `sys` and remove every cavil-client-del-… (finishing another run's
 * removal too). Returns what was judged: { removed: [...], busy: [...], unknown: [...] }, or
 * { error } when the judgement could not run at all (then nothing was renamed or removed).
 */
export function reap(sys, env = process.env) {
  const r = spawnSync('perl', ['-e', REAP, sys], { env, encoding: 'utf8' });
  if (r.error || r.status !== 0) return { error: r.error ? String(r.error.message) : String(r.stderr).trim() || `perl 退出码 ${r.status}`, removed: [], busy: [], unknown: [] };
  const out = { removed: [], busy: [], unknown: [] };
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [k, name, ...why] = line.split(' ');
    if (k === 'busy') out.busy.push(name);
    else if (k === 'unknown') out.unknown.push(`${name}（${why.join(' ')}）`);
  }
  let names = [];
  try {
    names = readdirSync(sys).filter((n) => n.startsWith('cavil-client-del-'));
  } catch {
    /* the folder cannot be listed: nothing to remove this time */
  }
  for (const n of names) {
    try {
      rmSync(join(sys, n), { recursive: true, force: true, maxRetries: 3 });
      out.removed.push(n);
    } catch (e) {
      out.unknown.push(`${n}（删除没完成：${e.code ?? e.message}，下次再删）`);
    }
  }
  return out;
}

const newId = () => randomBytes(6).toString('hex');

/** The environment a run's command gets. */
export function runEnv(sys, root, env = process.env) {
  return { ...env, TMPDIR: root, CAVIL_TMP_ROOT: root, CAVIL_TMP_SYSTEM: sys };
}

/**
 * Start `cmd` inside a fresh run folder of `sys`: returns { root, child }. The command (exec'd by
 * the locker, so it is the child itself) and everything under it hold the folder's lock.
 */
export function spawnInRun(sys, cmd, o = {}) {
  const id = newId();
  const root = join(sys, RUN + id);
  const env = runEnv(sys, root, o.env ?? process.env);
  const child = spawn('perl', ['-e', CREATE, sys, id, 'exec', ...cmd], { stdio: o.stdio ?? 'inherit', env });
  return { root, child };
}

/**
 * For a framework started without the launcher: a run folder held by a small perl process that lives
 * as long as this process (it ends when the pipe to it closes). Sets TMPDIR etc. in process.env and
 * returns the teardown (stop holding, then reap). Inside a run already: does nothing.
 */
export async function directRun() {
  if (insideRun()) return async () => {};
  const why = lockToolProblem();
  if (why) throw new Error(why);
  const sys = tmpdir();
  reap(sys);
  const id = newId();
  const root = join(sys, RUN + id);
  const holder = spawn('perl', ['-e', CREATE, sys, id, 'hold'], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    let got = '';
    holder.stdout.on('data', (d) => {
      got += String(d);
      if (got.includes('ready\n')) resolve(undefined);
    });
    holder.on('exit', (code) => reject(new Error(`临时目录建不起来（perl 退出码 ${code}）`)));
    holder.on('error', reject);
  });
  holder.stdout.destroy();
  Object.assign(process.env, { TMPDIR: root, CAVIL_TMP_ROOT: root, CAVIL_TMP_SYSTEM: sys });
  return async () => {
    const ended = new Promise((r) => holder.once('exit', r));
    holder.stdin.end();
    await ended;
    reap(sys);
  };
}
