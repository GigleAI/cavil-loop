// The download-size gate (GitHub#151): ≤ 20,000,000 bytes per dmg passes, one byte
// more fails; a missing file or a missing architecture fails too ("could not
// measure" is never "small enough"). Real files of exactly those sizes, real script.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, ftruncateSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'size-gate.mjs');

function file(dir: string, name: string, size: number) {
  const p = join(dir, name);
  const fd = openSync(p, 'w');
  ftruncateSync(fd, size);
  closeSync(fd);
  return p;
}

function gate(...args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe('size gate', () => {
  it('both dmgs at or under 20,000,000 bytes pass; one byte more fails the job', () => {
    const d = tempDir();
    const small = file(d, 'Cavil-Loop-0.3.0-arm64.dmg', 8_400_000);
    const edge = file(d, 'Cavil-Loop-0.3.0-x64.dmg', 20_000_000);
    const ok = gate(small, edge, '--expect', 'arm64,x64');
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('8400000 字节');
    expect(ok.out).toContain('没到 10 MB 目标');
    const over = file(tempDir(), 'Cavil-Loop-0.3.0-x64.dmg', 20_000_001);
    const bad = gate(small, over, '--expect', 'arm64,x64');
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('超过 20 MB 上限');
  });

  it('a missing file, a missing architecture or nothing at all is a failure, never a pass', () => {
    const d = tempDir();
    const arm = file(d, 'Cavil-Loop-0.3.0-arm64.dmg', 1_000);
    expect(gate(arm, join(d, 'gone-x64.dmg')).status).toBe(1);
    expect(gate(arm, '--expect', 'arm64,x64').status).toBe(1);
    expect(gate().status).toBe(1);
    expect(gate(arm, '--expect', 'arm64').status).toBe(0);
  });
});
