#!/usr/bin/env node
// Run a test command inside its own temporary folder (GitHub#469; the rules are in
// test/support/tmp-root.mjs):
//
//   node scripts/with-tmp.mjs <command> [args...]
//
// Before: reap the folders earlier runs left unused. Then: start the command with TMPDIR = a fresh
// folder whose lock it (and everything under it) holds. After it ends — passed, failed or stopped
// by a signal — reap again, which removes this run's folder unless something started by it is still
// alive (then it stays, and a later run removes it). Exit code = the command's.
//
// Signals: the first Ctrl-C / SIGTERM / SIGHUP is passed on and the launcher waits for the command
// to end, then cleans up; a second one exits at once without cleaning (a later run does it).
// With CI set, anything named `cavil-…` left in the system temp dir afterwards fails the run.
// Inside a run already (a test command that starts another one): just runs the command.

import { spawn } from 'node:child_process';
import { insideRun, leftovers, lockToolProblem, reap, spawnInRun, systemTmp } from '../test/support/tmp-root.mjs';

const cmd = process.argv.slice(2);
if (!cmd.length) {
  console.error('用法：node scripts/with-tmp.mjs <命令> [参数…]');
  process.exit(2);
}

const say = (m) => console.error(`cavil 临时目录：${m}`);
const codeOf = (code, signal) => (code ?? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[signal] ?? 0));

function relay(child) {
  let seen = 0;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      if (++seen > 1) {
        say('第二次中断：不等了，临时目录留给下次跑测试时清');
        process.exit(codeOf(null, sig));
      }
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    });
  }
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve(codeOf(code, signal))));
}

if (insideRun()) {
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  child.on('error', (e) => {
    say(`启动不了 ${cmd[0]}：${e.message}`);
    process.exit(127);
  });
  process.exit(await relay(child));
}

const why = lockToolProblem();
if (why) {
  say(why);
  process.exit(70);
}
const sys = systemTmp();
const before = reap(sys);
if (before.error) {
  say(`判断不了旧的临时目录（${before.error}），没有开始跑测试`);
  process.exit(70);
}

const { root, child } = spawnInRun(sys, cmd);
child.on('error', (e) => {
  say(`启动不了 perl：${e.message}`);
  process.exit(70);
});
const code = await relay(child);

const after = reap(sys);
const name = root.slice(sys.length).replace(/^\/+/, '');
if (after.error) say(`这次没能清理（${after.error}），${root} 留给下次跑测试时清`);
else if (after.busy.includes(name)) say(`${root} 里还有这次启动的进程在用，先保留；它们退出后，下次跑测试时会删掉`);
for (const u of after.unknown) say(`判断不了，先保留：${u}`);

if (process.env.CI) {
  const left = leftovers(sys);
  if (left.length) {
    say(`CI 检查：系统临时目录 ${sys} 里还有 ${left.length} 个 cavil- 开头的条目，测试留下了临时文件：\n  ${left.join('\n  ')}`);
    process.exit(code || 1);
  }
}
process.exit(code);
