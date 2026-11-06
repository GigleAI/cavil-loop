#!/usr/bin/env node
// Negative controls for the client's unit tests (GitHub#103 convention).
// Entry point is test/mutation/run.sh, which goes through
// tests/lib/mutation.sh's `mutation_gate` once per entry. This file does the
// work for one step at a time:
//
//   node run.mjs --count        number of entries
//   node run.mjs --check        every entry's source text is still there (nothing is run)
//   node run.mjs --name I       one-line description of entry I
//   node run.mjs --changes      what changed against the base branch (JSON; non-zero = cannot tell)
//   node run.mjs --baseline     unmodified copy: the whole unit suite must pass
//   node run.mjs --select [--all]  entries to run, by index: related to --changes, or all
//   node run.mjs --baseline-e2e I…  unmodified copy: the window tests those entries name must pass
//   node run.mjs --one I        entry I: the listed tests must fail by assertion
//
// Steps share what they learn through the directory CLIENT_MUT_STATE (run.sh makes one):
// changes.json, unit-tests.json (which file every unit test lives in, from the baseline's
// report) and harness (the back end the baseline built). Which entries are "related" is
// decided in select.mjs (GitHub#178).
//
// Each entry runs only the test files holding the tests it names (from unit-tests.json;
// without it, the whole suite). Entries that break the Rust back end (src-tauri/…) build
// their own back end (cargo, shared target dir MUT_TARGET); the others drive the back end
// the baseline built.
//
// "Red" is only accepted when vitest itself ran and reported a failed result
// for every test named in `expect`. A runner that cannot start, a signal, a
// timeout, a missing report or "something else failed" all count as a failed
// negative control — never as "went red as expected".
//
// Entries with `runner: 'e2e'` break the code the same way but run the named
// Playwright tests against the real window (with the real back end behind the
// test bridge) instead (`expect` names test titles); --baseline-e2e first runs
// those tests on an unmodified copy.
//
// Env for the runner's own tests: CLIENT_MUT_VITEST (vitest entry to run),
// CLIENT_MUT_TIMEOUT_MS, CLIENT_MUT_LIST (JSON file replacing MUTATIONS), CLIENT_MUT_BASELINE_FILES
// (comma-separated test files the baseline runs instead of the whole suite).

import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { changedFiles, baseEntries, selectEntries, editedFiles, unmappedNames } from './select.mjs';
import { MUTATIONS } from './mutations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const list = process.env.CLIENT_MUT_LIST ? JSON.parse(readFileSync(process.env.CLIENT_MUT_LIST, 'utf8')) : MUTATIONS;
const VITEST = process.env.CLIENT_MUT_VITEST ?? join(root, 'node_modules', 'vitest', 'vitest.mjs');
// a copy may build the Rust back end, then runs its test files (the whole suite without a map): give it room
const TIMEOUT_MS = Number(process.env.CLIENT_MUT_TIMEOUT_MS ?? 600_000);
const STATE = process.env.CLIENT_MUT_STATE;
const statePath = (f) => (STATE ? join(STATE, f) : null);
const readState = (f) => (STATE && existsSync(join(STATE, f)) ? JSON.parse(readFileSync(join(STATE, f), 'utf8')) : null);

function sandbox() {
  const work = mkdtempSync(join(tmpdir(), 'cavil-client-mut-'));
  for (const d of ['src', 'test', 'build']) cpSync(join(root, d), join(work, d), { recursive: true });
  // the Rust back end's sources (not its build output: a mutated copy is built into MUT_TARGET)
  cpSync(join(root, 'src-tauri'), join(work, 'src-tauri'), { recursive: true, filter: (s) => !/[\\/]src-tauri[\\/](target|gen)([\\/]|$)/.test(s) });
  for (const f of ['package.json', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts', 'RELEASE_NOTES.md', 'README.md']) cpSync(join(root, f), join(work, f));
  cpSync(join(root, 'scripts'), join(work, 'scripts'), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'));
  return work;
}

/** One cargo target dir for every mutated copy: dependencies are compiled once, only the mutated crates again. */
const MUT_TARGET = process.env.CLIENT_MUT_CARGO_TARGET ?? join(root, 'src-tauri', 'target', 'mutation');

/**
 * The back end the copy's suites drive: the copy's own Rust sources, built.
 * Resolves to the harness binary, or { broken } when it does not compile.
 */
function buildBackend(work) {
  return new Promise((resolve) => {
    const child = spawn('cargo', ['build', '-q', '-p', 'cavil-harness'], {
      cwd: join(work, 'src-tauri'),
      env: { ...process.env, CARGO_TARGET_DIR: MUT_TARGET },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    // the time limit covers the build too: a slow or stuck build is a failed run, not a long wait
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ broken: `后台编译启动失败：${e.message}` });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ broken: `超时（${TIMEOUT_MS} ms）被终止（编译后台时）` });
      const bin = join(MUT_TARGET, 'debug', 'cavil-harness');
      if (status !== 0 || !existsSync(bin)) return resolve({ broken: `后台编译失败：${stderr.trim().split('\n').slice(-6).join(' / ')}` });
      resolve({ bin });
    });
  });
}

/** Stands for "the unmodified copy" in backendFor: it may use the baseline's back end. */
const UNMODIFIED = { file: '', expect: [] };

/**
 * The back end for a copy: the baseline's build when the entry leaves src-tauri/ alone and the
 * baseline left one in CLIENT_MUT_STATE, otherwise the copy's own sources, built.
 */
async function backendFor(work, m) {
  const saved = statePath('harness');
  if (m && saved && existsSync(saved) && !editedFiles(m).some((f) => f.startsWith('src-tauri/'))) return { bin: saved, reused: true };
  return buildBackend(work);
}

/** Run vitest in `work` (only `files`, when given); resolve to { kind: 'report', status, report } or { kind: 'broken', why }. */
async function runVitest(work, m = null, files = []) {
  // a runner that is not there fails at once, before minutes of building the back end
  if (!existsSync(VITEST)) return { kind: 'broken', why: `启动失败：找不到测试执行器 ${VITEST}` };
  const be = await backendFor(work, m);
  if (be.broken) return { kind: 'broken', why: be.broken };
  return { ...(await runVitestWith(work, be.bin, files)), reused: !!be.reused };
}

function runVitestWith(work, harness, files = [], extraEnv = {}) {
  const out = join(work, 'vitest-report.json');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [VITEST, 'run', '--reporter=json', `--outputFile=${out}`, ...files], {
        cwd: work,
        env: { ...process.env, CLIENT_MUT_CHILD: '1', CLIENT_MUT_REPO: process.env.CLIENT_MUT_REPO ?? root, CAVIL_HARNESS: harness, ...extraEnv },
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true, // own process group: a timeout kills vitest's workers too
      });
    } catch (e) {
      return resolve({ kind: 'broken', why: `启动失败：${e.message}` });
    }
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ kind: 'broken', why: `启动失败：${e.message}` });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ kind: 'broken', why: `超时（${TIMEOUT_MS} ms）被终止` });
      if (signal) return resolve({ kind: 'broken', why: `被信号 ${signal} 终止` });
      if (!existsSync(out)) return resolve({ kind: 'broken', why: `没有产出测试报告（退出码 ${status}）：${stderr.trim().split('\n').slice(-3).join(' / ')}` });
      let report;
      try {
        report = JSON.parse(readFileSync(out, 'utf8'));
      } catch (e) {
        return resolve({ kind: 'broken', why: `测试报告读不了：${e.message}` });
      }
      resolve({ kind: 'report', status, report });
    });
  });
}

/** Build the copy (window + back end) and run the Playwright tests whose title matches `grep`; resolve like runVitest. */
async function runE2e(work, grep, m = null) {
  const be = await backendFor(work, m);
  if (be.broken) return { kind: 'broken', why: be.broken };
  const out = join(work, 'e2e-report.json');
  return new Promise((resolve) => {
    let child;
    try {
      const cmd = `node scripts/build.mjs --test-bridge >/dev/null && node node_modules/@playwright/test/cli.js test --reporter=json -g ${JSON.stringify(grep)}`;
      child = spawn('bash', ['-c', cmd], {
        cwd: work,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out, CAVIL_HARNESS: be.bin },
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
      });
    } catch (e) {
      return resolve({ kind: 'broken', why: `启动失败：${e.message}` });
    }
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, TIMEOUT_MS);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ kind: 'broken', why: `超时（${TIMEOUT_MS} ms）被终止` });
      if (signal) return resolve({ kind: 'broken', why: `被信号 ${signal} 终止` });
      if (!existsSync(out)) return resolve({ kind: 'broken', why: `没有产出界面测试报告（退出码 ${status}）：${stderr.trim().split('\n').slice(-3).join(' / ')}` });
      let report;
      try {
        report = JSON.parse(readFileSync(out, 'utf8'));
      } catch (e) {
        return resolve({ kind: 'broken', why: `界面测试报告读不了：${e.message}` });
      }
      resolve({ kind: 'report', status, report });
    });
  });
}

/** Playwright JSON report -> [{ name, status }] with vitest-like statuses */
function e2eResults(report) {
  const out = [];
  const walk = (suite) => {
    for (const sp of suite.specs ?? []) out.push({ name: sp.title, status: sp.ok ? 'passed' : 'failed' });
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of report.suites ?? []) walk(s);
  return out;
}

const grepOf = (names) => names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/** vitest JSON report -> [{ name, status, file }]; `file` is relative to the copy that ran */
function results(report, work = null) {
  return report.testResults.flatMap((f) =>
    f.assertionResults.map((a) => ({ name: a.fullName, status: a.status, file: work && f.name.startsWith(`${work}/`) ? f.name.slice(work.length + 1) : f.name })),
  );
}

/** The test files holding the tests `m` names, from the baseline's map; [] = not known (run the whole suite). */
function testFilesOf(m) {
  const map = readState('unit-tests.json');
  if (!map) return [];
  const files = new Set();
  for (const name of m.expect) {
    const hit = map.filter((t) => t.name.includes(name)).map((t) => t.file);
    if (!hit.length) return [];
    hit.forEach((f) => files.add(f));
  }
  return [...files].sort();
}

async function baseline() {
  // a runner that is not there fails at once, before copying and building anything
  if (!existsSync(VITEST)) return fail(`基线没跑成：启动失败：找不到测试执行器 ${VITEST}`);
  const work = sandbox();
  try {
    const be = await buildBackend(work);
    if (be.broken) return fail(`基线没跑成：${be.broken}`);
    // CLIENT_MUT_BASELINE_FILES: the runner's own tests run a baseline on a few files only
    const only = (process.env.CLIENT_MUT_BASELINE_FILES ?? '').split(',').filter(Boolean);
    const r = await runVitestWith(work, be.bin, only, { CLIENT_MUT_BASELINE: '1' });
    if (r.kind === 'broken') return fail(`基线没跑成：${r.why}`);
    const all = results(r.report, work);
    // the runner's own self-tests skip themselves inside child runs; anything else must pass
    const bad = all.filter((t) => t.status !== 'passed' && !(t.status === 'skipped' || t.status === 'pending') );
    const passed = all.filter((t) => t.status === 'passed').length;
    if (r.status !== 0 || bad.length || passed === 0 || r.report.numFailedTestSuites) {
      return fail(`基线不是全绿（退出码 ${r.status}，${all.length} 条，未通过：${bad.map((t) => t.name).join('；') || '套件加载失败'}）`);
    }
    if (STATE) {
      // where every test lives, so each entry runs only its own files; and the back end, so
      // entries that leave src-tauri/ alone do not build it again
      writeFileSync(join(STATE, 'unit-tests.json'), JSON.stringify(all.map(({ name, file }) => ({ name, file }))));
      cpSync(be.bin, join(STATE, 'harness'));
    }
    // every test an entry names must still exist (GitHub#178 review round 1: a test renamed in #171
    // left its entry naming nothing; that entry could never go red "as expected")
    const map = all.map(({ name, file }) => ({ name, file }));
    const missing = unmappedNames(list, { unit: map, e2e: e2eTests() });
    if (missing.length) {
      return fail(`清单里有项点名的测试已经不存在（改名或删掉后没同步清单）：${missing.map((x) => `第 ${x.i} 项「${x.what}」点名「${x.name}」`).join('；')}`);
    }
    console.log(`✅ 基线：未改动的副本 ${passed} 条全过（另 ${all.length - passed} 条是负对照执行器的自检，子进程里不跑）`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Unmodified copy: the window tests named by the given entries must pass (no-op when none are window entries). */
async function baselineE2e(indices) {
  const names = [...new Set(indices.map((i) => list[i]).filter((m) => m?.runner === 'e2e').flatMap((m) => m.expect))];
  if (!names.length) return 0;
  const work = sandbox();
  try {
    const e = await runE2e(work, grepOf(names), UNMODIFIED);
    if (e.kind === 'broken') return fail(`界面基线没跑成：${e.why}`);
    const got = e2eResults(e.report);
    const missing = names.filter((n) => !got.some((t) => t.status === 'passed' && t.name.includes(n)));
    if (e.status !== 0 || missing.length) return fail(`界面基线不是全绿（退出码 ${e.status}，没通过：${missing.join('；') || '其他'}）`);
    console.log(`✅ 界面基线：未改动的副本 ${got.length} 条界面测试全过`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Where every window test lives (Playwright lists them without running anything). */
function e2eTests() {
  const out = execFileSync(process.execPath, [join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--list', '--reporter=json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: '' },
  });
  const report = JSON.parse(out);
  const dir = report.config?.rootDir ? report.config.rootDir.slice(root.length + 1) : 'test/e2e';
  const found = [];
  const walk = (suite) => {
    for (const sp of suite.specs ?? []) found.push({ name: sp.title, file: `${dir}/${sp.file}` });
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of report.suites ?? []) walk(s);
  return found;
}

/** stdout: the indices to run, space-separated (empty = nothing related). Non-zero = cannot tell. */
async function select(scope) {
  if (scope === '--all') {
    console.log(list.map((_, i) => i).join(' '));
    return 0;
  }
  const changes = readState('changes.json');
  if (!changes) return fail('判断不了：没有 --changes 的结果');
  let base, e2e;
  try {
    base = await baseEntries(root, changes);
  } catch (e) {
    return fail(`判断不了：读不了主干上的负对照清单（${String(e?.message ?? e).split('\n')[0]}）`);
  }
  const unit = readState('unit-tests.json');
  if (!unit) return fail('判断不了：没有基线记下的测试所在文件');
  try {
    e2e = list.some((m) => m.runner === 'e2e') ? e2eTests() : [];
  } catch (e) {
    return fail(`判断不了：列不出界面测试（${String(e?.stderr || e?.message || e).split('\n')[0]}）`);
  }
  const r = selectEntries({ entries: list, base, changes, tests: { unit, e2e } });
  if (!r.ok) return fail(`判断不了：${r.why}`);
  if (r.everything) console.error(`全部 ${list.length} 项都算相关：${r.everything}`);
  else if (!r.indices.length) console.error(`本次改动没有相关负对照。改了的文件：${[...changes.files, ...changes.outside].join('、') || '（无）'}`);
  else for (const i of r.indices) console.error(`  第 ${i} 项（${list[i].what}）：${r.reasons[i].join('；')}`);
  console.log(r.indices.join(' '));
  return 0;
}

function changes() {
  const c = changedFiles(root);
  if (!c.ok) return fail(`判断不了：${c.why}`);
  console.log(JSON.stringify(c));
  return 0;
}

async function one(i) {
  const m = list[i];
  if (!m) return fail(`没有第 ${i} 项`);
  const work = sandbox();
  try {
    if (m.fromGit) {
      let old;
      try {
        old = execFileSync('git', ['show', m.fromGit], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return fail(`准备失败（取不到 ${m.fromGit}）：${m.what}`);
      }
      writeFileSync(join(work, m.file), old);
    } else {
      // one edit (`file` / `from` / `to`) or several (`edits`), applied in order
      for (const ed of m.edits ?? [{ file: m.file, from: m.from, to: m.to }]) {
        const target = join(work, ed.file);
        const text = readFileSync(target, 'utf8');
        if (!text.includes(ed.from)) return fail(`准备失败（原文不在 ${ed.file}）：${m.what}`);
        writeFileSync(target, text.replace(ed.from, ed.to));
      }
    }
    const e2e = m.runner === 'e2e';
    const files = e2e ? [] : testFilesOf(m);
    const r = e2e ? await runE2e(work, grepOf(m.expect), m) : await runVitest(work, m, files);
    if (r.kind === 'broken') return fail(`执行异常（${r.why}）：${m.what}`);
    if (r.status === 0) return fail(`没变红：${m.what}`);
    const all = e2e ? e2eResults(r.report) : results(r.report, work);
    const missing = m.expect.filter((name) => !all.some((t) => t.status === 'failed' && t.name.includes(name)));
    if (missing.length) {
      const failed = all.filter((t) => t.status === 'failed').map((t) => t.name);
      return fail(`红了，但不是预期的断言（缺：${missing.join('；')}；实际失败：${failed.join('；') || '无，可能是套件加载失败'}）：${m.what}`);
    }
    const how = e2e ? '' : `；跑的测试文件：${files.length ? files.join('、') : '全部'}；后台：${r.reused ? '用基线编好的' : '本项重编'}`;
    console.log(`✅ 变红（${m.expect.length} 条预期断言失败${how}）：${m.what}`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function fail(msg) {
  console.log(`❌ ${msg}`);
  return 1;
}

/** Every entry's source text is still there (no copying, no running). */
function check() {
  let bad = 0;
  list.forEach((m, i) => {
    if (m.fromGit) return;
    for (const ed of m.edits ?? [{ file: m.file, from: m.from }]) {
      const text = existsSync(join(root, ed.file)) ? readFileSync(join(root, ed.file), 'utf8') : '';
      if (!text.includes(ed.from)) {
        bad++;
        console.log(`❌ ${i} 原文不在 ${ed.file}：${m.what}`);
      }
    }
  });
  if (!bad) console.log(`✅ ${list.length} 项的原文都在`);
  return bad ? 1 : 0;
}

const [cmd, ...args] = process.argv.slice(2);
const arg = args[0];
if (cmd === '--count') console.log(list.length);
else if (cmd === '--check') process.exitCode = check();
else if (cmd === '--name') console.log(list[Number(arg)]?.what ?? '');
else if (cmd === '--changes') process.exitCode = changes();
else if (cmd === '--baseline') process.exitCode = await baseline();
else if (cmd === '--select') process.exitCode = await select(arg);
else if (cmd === '--baseline-e2e') process.exitCode = await baselineE2e(args.map(Number));
else if (cmd === '--one') process.exitCode = await one(Number(arg));
else {
  console.error('用法：由 test/mutation/run.sh 调用（--count | --name I | --changes | --baseline | --select [--all] | --baseline-e2e I… | --one I）');
  process.exitCode = 2;
}
