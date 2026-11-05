#!/usr/bin/env node
// The download-size gate (GitHub#151). Each released dmg is judged on its own,
// in bytes (1 MB = 1,000,000 bytes, the unit the issue measured 134 / 139.5 MB in):
//   ≤ 10 MB   target met
//   ≤ 20 MB   acceptable: the job passes and prints what takes the space
//   > 20 MB   fails the job — not merged; the measured breakdown goes to the maintainer
// A file that is missing or cannot be read fails too: "could not measure" is never "small enough".
//
//   node scripts/size-gate.mjs <dmg> [<dmg> ...]   [--expect arm64,x64]
import { statSync } from 'node:fs';
import { basename } from 'node:path';

export const TARGET = 10_000_000;
export const LIMIT = 20_000_000;

/** → { ok, lines } for the given files; `expect` = arch names that must each have exactly one file. */
export function judge(files, expect = []) {
  const lines = [];
  let ok = files.length > 0;
  if (!files.length) lines.push('❌ 没有要量的安装包');
  for (const a of expect) {
    const n = files.filter((f) => basename(f).includes(`-${a}.`)).length;
    if (n !== 1) {
      ok = false;
      lines.push(`❌ ${a}：应有 1 个安装包，实际 ${n} 个`);
    }
  }
  for (const f of files) {
    let size;
    try {
      size = statSync(f).size;
    } catch (e) {
      ok = false;
      lines.push(`❌ ${basename(f)}：量不到（${e.code ?? e.message}）`);
      continue;
    }
    const mb = (size / 1e6).toFixed(2);
    if (size > LIMIT) {
      ok = false;
      lines.push(`❌ ${basename(f)}：${size} 字节（${mb} MB），超过 20 MB 上限`);
    } else if (size > TARGET) lines.push(`⚠️ ${basename(f)}：${size} 字节（${mb} MB），在 20 MB 以内，但没到 10 MB 目标`);
    else lines.push(`✅ ${basename(f)}：${size} 字节（${mb} MB），在 10 MB 目标以内`);
  }
  return { ok, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--expect');
  const expect = i >= 0 ? args.splice(i, 2)[1].split(',').filter(Boolean) : [];
  const { ok, lines } = judge(args, expect);
  for (const l of lines) console.log(l);
  process.exit(ok ? 0 : 1);
}
