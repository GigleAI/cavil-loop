#!/usr/bin/env node
// Negative controls for the real-window test (GitHub#151 review round 1): each
// breaks one production handler of the app shell (src-tauri/src/main.rs), rebuilds
// the real app into its own target dir, runs test/tauri against it, and requires
// the test to fail at the step that handler is responsible for. Off by default
// (GitHub#103); MUTATION=1 runs them. CI: Linux, under xvfb, after `npm run test:tauri`.
//
//   MUTATION=1 node test/tauri/mutations.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN = 'src-tauri/src/main.rs';

const MUTATIONS = [
  {
    what: '详情里 GitHub 正文的链接（要开新窗口的那种）不交给浏览器',
    from: '                    let e = engine.clone();\n                    let u = url.to_string();\n',
    to: '                    let _ = (&engine, &url);\n                    return NewWindowResponse::Deny;\n                    #[allow(unreachable_code)]\n                    let e = engine.clone();\n                    let u = url.to_string();\n',
    expect: 'frame link opened in the browser',
  },
  {
    what: '窗口被要求跳到别处时照跳（不拦、不交给浏览器）',
    from: '                    if is_app_url(url) {\n                        return true;\n                    }',
    to: '                    if true {\n                        return true;\n                    }',
    expect: 'navigation handed to the browser',
  },
  {
    what: '窗口到后台的命令没接上（界面拿不到任何数据）',
    from: 'tauri::generate_handler![backend, mounted]',
    to: 'tauri::generate_handler![mounted]',
    expect: 'app-root',
  },
];

if (process.env.MUTATION !== '1') {
  console.log(`真实窗口负对照：跳过 ${MUTATIONS.length} 项（MUTATION=1 打开）`);
  process.exit(0);
}

const target = process.env.CAVIL_TAURI_MUT_TARGET ?? join(root, 'src-tauri', 'target', 'tauri-mutation');
let failed = 0;
for (const m of MUTATIONS) {
  const work = mkdtempSync(join(tmpdir(), 'cavil-tauri-mut-'));
  try {
    cpSync(join(root, 'src-tauri'), join(work, 'src-tauri'), { recursive: true, filter: (s) => !/[\\/]src-tauri[\\/](target|gen)([\\/]|$)/.test(s) });
    cpSync(join(root, 'dist'), join(work, 'dist'), { recursive: true });
    const file = join(work, MAIN);
    const text = readFileSync(file, 'utf8');
    if (!text.includes(m.from)) {
      console.log(`❌ 准备失败（原文不在 ${MAIN}）：${m.what}`);
      failed++;
      continue;
    }
    writeFileSync(file, text.replace(m.from, m.to));
    const build = spawnSync('cargo', ['build', '-q', '-p', 'cavil-loop-client'], { cwd: join(work, 'src-tauri'), env: { ...process.env, CARGO_TARGET_DIR: target }, encoding: 'utf8' });
    if (build.status !== 0) {
      console.log(`❌ 改坏的副本编译失败：${m.what}\n${build.stderr.split('\n').slice(-8).join('\n')}`);
      failed++;
      continue;
    }
    const run = spawnSync(process.execPath, [join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '-c', 'playwright.tauri.config.ts', '--reporter=line'], {
      cwd: root,
      env: { ...process.env, CAVIL_TAURI_APP: join(target, 'debug', 'cavil-loop-client') },
      encoding: 'utf8',
      timeout: 600_000,
    });
    const out = `${run.stdout}${run.stderr}`;
    if (run.status === 0) {
      console.log(`❌ 没变红：${m.what}`);
      failed++;
    } else if (!out.includes(m.expect)) {
      console.log(`❌ 红了，但不是在预期那一步（缺「${m.expect}」）：${m.what}\n${out.split('\n').filter((l) => /Error|timeout|not found/.test(l)).slice(0, 5).join('\n')}`);
      failed++;
    } else {
      console.log(`✅ 变红（在「${m.expect}」那一步）：${m.what}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
console.log(`真实窗口负对照：本次跑了 ${MUTATIONS.length} 项，${MUTATIONS.length - failed} 项按预期变红，${failed} 项失败`);
process.exit(failed ? 1 : 0);
