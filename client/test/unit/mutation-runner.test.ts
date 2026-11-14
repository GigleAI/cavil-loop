// The negative-control runner must never report "went red as expected" unless
// vitest really ran and the named assertions really failed. These run the real
// runner as a child process (they are positive tests of the runner, so they
// stay in the default run). Skipped inside the runner's own child runs.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, chmodSync, readFileSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runner = join(root, 'test/mutation/run.mjs');
const OFFLINE_ENTRY = {
  what: '离线时修改入口不变灰',
  file: 'src/data/board.ts',
  from: 'return !sync.offline;',
  to: 'return true;',
  expect: ['offline → disabled; online → enabled'],
};

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const STORE_ENTRY = {
  what: '缓存不覆盖旧快照',
  file: 'src-tauri/crates/core/src/store.rs',
  from: 'ON CONFLICT(source_key) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data',
  to: 'ON CONFLICT(source_key) DO NOTHING',
  expect: ['each successful round replaces the cached snapshot as a whole'],
};

/** What the baseline leaves for later steps: where the named tests live, and a back end (here a dud). */
function baselineState() {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'unit-tests.json'),
    JSON.stringify([
      { name: 'board writes enabled offline → disabled; online → enabled', file: 'test/unit/board.test.ts' },
      { name: 'board fetch reads both pages', file: 'test/unit/board.test.ts' },
      { name: 'cache each successful round replaces the cached snapshot as a whole', file: 'test/unit/controller.test.ts' },
    ]),
  );
  writeFileSync(join(dir, 'harness'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'harness'), 0o755);
  return dir;
}

function listFile(entries: unknown[]) {
  const f = join(tempDir(), 'list.json');
  writeFileSync(f, JSON.stringify(entries));
  return f;
}

describe.skipIf(process.env.CLIENT_MUT_CHILD === '1')('negative-control runner', () => {
  it('a test runner that cannot start is a failure, for the baseline and for an entry', () => {
    const env = { CLIENT_MUT_VITEST: '/nonexistent/vitest.mjs' };
    const one = run(['--one', '0'], env);
    expect(one.status).toBe(1);
    expect(one.out).toContain('执行异常');
    expect(one.out).not.toContain('✅');
    const base = run(['--baseline'], env);
    expect(base.status).toBe(1);
    expect(base.out).toContain('基线没跑成');
  });

  it('a run killed by the timeout is a failure', () => {
    const r = run(['--one', '0'], { CLIENT_MUT_TIMEOUT_MS: '1' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('超时');
  });

  it('the entry script without node on PATH fails instead of reporting success', () => {
    const r = spawnSync('/bin/bash', [join(root, 'test/mutation/run.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/nonexistent', MUTATION: '1' },
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toContain('按预期变红');
  });

  it('a mutation that changes nothing is "did not go red"; red on the wrong assertion is a failure too', () => {
    // with the baseline's map each run is one small test file, not a second whole suite (a whole
    // nested suite under load made unrelated timing tests flake and this case read them as red)
    const state = baselineState();
    const noop = run(['--one', '0'], { CLIENT_MUT_LIST: listFile([{ ...OFFLINE_ENTRY, to: OFFLINE_ENTRY.from }]), CLIENT_MUT_STATE: state });
    expect(noop.status).toBe(1);
    expect(noop.out).toContain('没变红');
    const wrong = run(['--one', '0'], { CLIENT_MUT_LIST: listFile([{ ...OFFLINE_ENTRY, expect: ['reads both pages'] }]), CLIENT_MUT_STATE: state });
    expect(wrong.status).toBe(1);
    expect(wrong.out).toContain('不是预期的断言');
    const gone = run(['--one', '0'], { CLIENT_MUT_LIST: listFile([{ ...OFFLINE_ENTRY, from: 'text that is not there' }]), CLIENT_MUT_STATE: state });
    expect(gone.status).toBe(1);
    expect(gone.out).toContain('准备失败');
  }, 120_000);

  it('a real mutation caught by its named assertion is accepted (the runner can say yes)', () => {
    const r = run(['--one', '0'], { CLIENT_MUT_LIST: listFile([OFFLINE_ENTRY]), CLIENT_MUT_STATE: baselineState() });
    expect(r.out).toContain('✅ 变红');
    expect(r.status).toBe(0);
  }, 120_000);

  // GitHub#178: an entry runs only the test files holding the tests it names, on the back end the
  // baseline built — unless it breaks the back end itself, then it builds its own
  it('with the baseline\'s map: only the named tests\' files; the baseline\'s back end unless the entry breaks it', () => {
    const state = baselineState();
    const ts = run(['--one', '0'], { CLIENT_MUT_LIST: listFile([OFFLINE_ENTRY]), CLIENT_MUT_STATE: state });
    expect(ts.out).toContain('✅ 变红');
    expect(ts.out).toContain('跑的测试文件：test/unit/board.test.ts；');
    expect(ts.out).toContain('后台：用基线编好的');
    expect(ts.status).toBe(0);
    const rust = run(['--one', '0'], { CLIENT_MUT_LIST: listFile([STORE_ENTRY]), CLIENT_MUT_STATE: state });
    expect(rust.out).toContain('✅ 变红');
    expect(rust.out).toContain('跑的测试文件：test/unit/controller.test.ts；');
    expect(rust.out).toContain('后台：本项重编');
    expect(rust.status).toBe(0);
  }, 240_000);

  it('a weakened assertion is reported, not passed: the test no longer catches the break', () => {
    const weakened = {
      what: '断言被删弱：离线时修改入口不变灰也没人发现',
      edits: [
        { file: OFFLINE_ENTRY.file, from: OFFLINE_ENTRY.from, to: OFFLINE_ENTRY.to },
        { file: 'test/unit/board.test.ts', from: '    expect(writesEnabled({ offline: true })).toBe(false);\n', to: '' },
      ],
      expect: OFFLINE_ENTRY.expect,
    };
    const r = run(['--one', '0'], { CLIENT_MUT_LIST: listFile([weakened]), CLIENT_MUT_STATE: baselineState() });
    expect(r.status).toBe(1);
    expect(r.out).toContain('没变红');
  }, 120_000);
});

// Runs in the default run and inside a negative-control copy (its entry breaks the baseline's
// check), but not inside the baseline's own run: there it would start a second baseline.
describe.skipIf(process.env.CLIENT_MUT_BASELINE === '1')('negative-control runner: the baseline', () => {
  // GitHub#178 review round 1: #171 renamed a test and its entry kept naming the old title. The
  // baseline stops on that (for the real list it does so at the start of every real run). Here the
  // baseline runs one small file only, so the default run does not carry a second whole suite.
  it('the baseline names every entry whose named test no longer exists', () => {
    const env = { CLIENT_MUT_STATE: tempDir(), CLIENT_MUT_BASELINE_FILES: 'test/unit/board.test.ts' };
    const ok = run(['--baseline'], { ...env, CLIENT_MUT_LIST: listFile([OFFLINE_ENTRY]) });
    expect(ok.out).toContain('✅ 基线');
    expect(ok.status).toBe(0);
    const stale = { ...OFFLINE_ENTRY, what: '点名的测试已改名', expect: ['a test title nobody has any more'] };
    const base = run(['--baseline'], { ...env, CLIENT_MUT_LIST: listFile([OFFLINE_ENTRY, stale]) });
    expect(base.out).toContain('a test title nobody has any more');
    expect(base.out).not.toContain('✅ 基线');
    expect(base.status).toBe(1);
  }, 240_000);
});

// GitHub#527: PR #481 renamed a test an entry named, and the next nightly baseline stopped the whole
// set. The PR checks (run.sh without the switch) now collect the real test names — vitest imports
// every test file, registers its tests and runs none — and apply the baseline's own rule to them.
// Each case is a small folder of its own test files (CLIENT_MUT_COLLECT_ROOT), never the real suite.
describe.skipIf(process.env.CLIENT_MUT_CHILD === '1')('negative-control runner: named tests exist (PR checks)', () => {
  const NAMED = 'the badge goes back to 0';
  const entry = { ...OFFLINE_ENTRY, what: '点名一条测试的项', expect: [NAMED] };

  /** A folder vitest can run: its own config, the client's packages, the given test files. */
  function suite(files: Record<string, string>) {
    const dir = tempDir();
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['*.test.mjs'] } };\n");
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), `import { describe, it, expect } from 'vitest';\n${text}\n`);
    return dir;
  }
  const names = (dir: string, entries: unknown[] = [entry]) => run(['--names'], { CLIENT_MUT_COLLECT_ROOT: dir, CLIENT_MUT_LIST: listFile(entries) });

  it('a named test that is there passes; renamed, deleted, or left only in a comment and a string, it is named with its entry', () => {
    const ok = names(suite({ 'a.test.mjs': `describe('pending', () => { it('${NAMED} once the label is off', () => expect(1).toBe(1)); });` }));
    expect(ok.out).toContain('✅ 清单 1 项点名的测试都在');
    expect(ok.status).toBe(0);
    const cases = {
      renamed: `describe('pending', () => { it('the count drops when the label is off', () => expect(1).toBe(1)); });`,
      deleted: `describe('pending', () => { it('another test', () => expect(1).toBe(1)); });`,
      // the source text still has the name; no test registered under it
      leftInText: `// ${NAMED}\nconst why = '${NAMED}';\ndescribe('pending', () => { it('another test', () => expect(why).toBeTruthy()); });`,
    };
    for (const [kind, text] of Object.entries(cases)) {
      const r = names(suite({ 'a.test.mjs': text }));
      expect(r.out, kind).toContain(`第 0 项「点名一条测试的项」点名「${NAMED}」`);
      expect(r.out, kind).not.toContain('✅');
      expect(r.status, kind).toBe(1);
    }
  }, 120_000);

  it('a test file that cannot be loaded is "cannot tell", never "every named test is there"', () => {
    const dir = suite({ 'a.test.mjs': `it('${NAMED}', () => {});`, 'b.test.mjs': "import './not-there.mjs';" });
    const r = names(dir);
    expect(r.out).toContain('核对不了清单点名');
    expect(r.out).toContain('b.test.mjs');
    expect(r.out).not.toContain('✅');
    expect(r.status).toBe(1);
  }, 120_000);

  // the names collected must be the names the baseline gets from vitest's report after a real run
  it('the collected names equal the names of a real run, test for test', () => {
    const dir = suite({
      'a.test.mjs': [
        `describe('labels: only "add this one" \\\\ is sent', () => {`,
        `  describe('inner', () => { it('keeps \`$x\` and %s as typed', () => expect(1).toBe(1)); });`,
        `  it.each([1, 2])('case %i of $0', (n) => expect(n).toBeGreaterThan(0));`,
        `  it.each([{ a: 'x' }])('object $a', () => {});`,
        `});`,
        `it('top level', () => {});`,
        `it.skip('skipped one', () => {});`,
        `describe.skipIf(true)('skipped suite', () => { it('inside it', () => {}); });`,
        `describe.skipIf(process.env.CLIENT_MUT_CHILD === '1')('only outside the runner', () => { it('runner self-test', () => {}); });`,
        `if (process.env.CLIENT_MUT_BASELINE === '1') it('registered in the baseline only', () => {});`,
      ].join('\n'),
      'b.test.mjs': `describe('', () => { it('under an empty suite name', () => {}); });\ndescribe('only a suite', () => { it('', () => {}); });`,
    });
    const collected = run(['--unit-names'], { CLIENT_MUT_COLLECT_ROOT: dir });
    expect(collected.status).toBe(0);
    const got = (JSON.parse(collected.out.trim().split('\n').pop()!) as { name: string; file: string }[]).map((t) => `${t.file} ${t.name}`).sort();
    // the baseline's run: same environment as run.mjs gives it, JSON report
    const out = join(tempDir(), 'report.json');
    const real = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=json', `--outputFile=${out}`], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CLIENT_MUT_CHILD: '1', CLIENT_MUT_BASELINE: '1' },
      timeout: 120_000,
    });
    expect(real.status, real.stderr).toBe(0);
    const report = JSON.parse(readFileSync(out, 'utf8')) as { testResults: { name: string; assertionResults: { fullName: string }[] }[] };
    const want = report.testResults.flatMap((f) => f.assertionResults.map((a) => `${f.name.slice(dir.length + 1)} ${a.fullName}`)).sort();
    // "did happen": the expanded, skipped and conditional tests are all there
    expect(want).toHaveLength(11);
    expect(want).toContain('a.test.mjs labels: only "add this one" \\ is sent case 2 of 2');
    expect(want).toContain('a.test.mjs registered in the baseline only');
    expect(got).toEqual(want);
  }, 120_000);
});
