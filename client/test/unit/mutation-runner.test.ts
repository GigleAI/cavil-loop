// The negative-control runner must never report "went red as expected" unless
// vitest really ran and the named assertions really failed. These run the real
// runner as a child process (they are positive tests of the runner, so they
// stay in the default run). Skipped inside the runner's own child runs.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, chmodSync } from 'node:fs';
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
    const noop = run(['--one', '0'], { CLIENT_MUT_LIST: listFile([{ ...OFFLINE_ENTRY, to: OFFLINE_ENTRY.from }]) });
    expect(noop.status).toBe(1);
    expect(noop.out).toContain('没变红');
    const wrong = run(['--one', '0'], { CLIENT_MUT_LIST: listFile([{ ...OFFLINE_ENTRY, expect: ['reads both pages'] }]) });
    expect(wrong.status).toBe(1);
    expect(wrong.out).toContain('不是预期的断言');
    const gone = run(['--one', '0'], { CLIENT_MUT_LIST: listFile([{ ...OFFLINE_ENTRY, from: 'text that is not there' }]) });
    expect(gone.status).toBe(1);
    expect(gone.out).toContain('准备失败');
  }, 120_000);

  it('a real mutation caught by its named assertion is accepted (the runner can say yes)', () => {
    const r = run(['--one', '0'], { CLIENT_MUT_LIST: listFile([OFFLINE_ENTRY]) });
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
