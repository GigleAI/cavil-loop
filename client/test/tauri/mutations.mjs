#!/usr/bin/env node
// Negative controls for the real-window test (GitHub#151 review round 1): each
// breaks one production handler of the app shell (src-tauri/src/main.rs, desktop.rs), rebuilds
// the real app into its own target dir, runs test/tauri against it, and requires
// the test to fail at the step that handler is responsible for. Off by default
// (GitHub#103); entry point test/tauri/mutations.sh. CI: Linux, under xvfb.
//
//   MUTATION=1 bash test/tauri/mutations.sh

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedFiles, isRelatedForApp, SHARED_OUTSIDE } from '../mutation/select.mjs';

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
    from: 'tauri::generate_handler![\n            backend,\n            mounted,',
    to: 'tauri::generate_handler![\n            mounted,',
    expect: 'app-root',
  },
  // GitHub#169: closing the window hides it, the shell keeps the sync beat, a click opens the item
  {
    what: '窗口隐藏后外壳不再发同步节拍',
    file: 'src-tauri/src/desktop.rs',
    from: '            d.push(json!({ "kind": "tick" }));\n        }\n    });',
    to: '            if main_visible(&beat) {\n                d.push(json!({ "kind": "tick" }));\n            }\n        }\n    });',
    expect: 'synced while hidden',
  },
  {
    what: '关窗不拦，窗口直接关掉（App 退出）',
    from: 'if w.label() == "main" && d.hide_on_close() {',
    to: 'if false && d.hide_on_close() {',
    expect: 'window hidden, app still running',
  },
  {
    what: '点通知只把窗口叫回来，不打开那一条',
    file: 'src-tauri/src/desktop.rs',
    from: '            d.push(json!({ "kind": "open", "key": key, "url": url }));',
    to: '            let _ = (key, url, &d);',
    expect: 'not found: [data-testid="detail"]',
  },
  {
    what: '隐藏启动（开机自启）时不启动同步节拍',
    from: '            desktop::spawn_background(handle.clone());',
    to: '            if !hidden {\n                desktop::spawn_background(handle.clone());\n            }',
    expect: 'synced while started hidden',
  },
];

const target = process.env.CAVIL_TAURI_MUT_TARGET ?? join(root, 'src-tauri', 'target', 'tauri-mutation');

/** One entry: copy, break, rebuild the real app, run test/tauri; 0 = red at the expected step. */
function one(m) {
  const work = mkdtempSync(join(tmpdir(), 'cavil-tauri-mut-'));
  try {
    cpSync(join(root, 'src-tauri'), join(work, 'src-tauri'), { recursive: true, filter: (s) => !/[\\/]src-tauri[\\/](target|gen)([\\/]|$)/.test(s) });
    const rel = m.file ?? MAIN;
    // an entry that breaks the window's own code rebuilds the window from the broken copy
    const windowCode = rel.startsWith('src/');
    if (windowCode) {
      for (const d of ['src', 'scripts', 'build']) cpSync(join(root, d), join(work, d), { recursive: true });
      for (const f of ['package.json', 'tsconfig.json']) cpSync(join(root, f), join(work, f));
      symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'));
    } else {
      cpSync(join(root, 'dist'), join(work, 'dist'), { recursive: true });
    }
    const file = join(work, rel);
    const text = readFileSync(file, 'utf8');
    if (!text.includes(m.from)) return fail(`准备失败（原文不在 ${rel}）：${m.what}`);
    writeFileSync(file, text.replace(m.from, m.to));
    if (windowCode) {
      const web = spawnSync(process.execPath, [join(work, 'scripts', 'build.mjs')], { cwd: work, encoding: 'utf8' });
      if (web.status !== 0) return fail(`改坏的副本构建窗口失败：${m.what}\n${(web.stderr ?? '').split('\n').slice(-8).join('\n')}`);
    }
    const build = spawnSync('cargo', ['build', '-q', '-p', 'cavil-loop-client'], { cwd: join(work, 'src-tauri'), env: { ...process.env, CARGO_TARGET_DIR: target }, encoding: 'utf8' });
    if (build.status !== 0) return fail(`改坏的副本编译失败：${m.what}\n${(build.stderr ?? '').split('\n').slice(-8).join('\n')}`);
    const run = spawnSync(process.execPath, [join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '-c', 'playwright.tauri.config.ts', '--reporter=line'], {
      cwd: root,
      env: { ...process.env, CAVIL_TAURI_APP: join(target, 'debug', 'cavil-loop-client') },
      encoding: 'utf8',
      timeout: 600_000,
    });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    if (run.error || run.signal) return fail(`执行异常（${run.error?.message ?? `信号 ${run.signal}`}）：${m.what}`);
    if (run.status === 0) return fail(`没变红：${m.what}`);
    if (!out.includes(m.expect)) {
      return fail(`红了，但不是在预期那一步（缺「${m.expect}」）：${m.what}\n${out.split('\n').filter((l) => /Error|timeout|not found/.test(l)).slice(0, 5).join('\n')}`);
    }
    console.log(`✅ 变红（在「${m.expect}」那一步）：${m.what}`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function fail(msg) {
  console.log(`❌ ${msg}`);
  return 1;
}

// Driven by test/tauri/mutations.sh, which passes every entry through tests/lib/mutation.sh's
// mutation_gate (so "skipped N" and "ran N" come from the project's one counter):
//   node mutations.mjs --count | --name I | --one I
//   node mutations.mjs --related   exit 0 = this change touches what these entries check, 1 = it does
//                                  not (both print why), 2 = cannot tell (GitHub#178)
const [cmd, arg] = process.argv.slice(2);
if (cmd === '--count') console.log(MUTATIONS.length);
else if (cmd === '--related') {
  const c = changedFiles(root);
  if (!c.ok) {
    console.log(`❌ 判断不了：${c.why}`);
    process.exitCode = 2;
  } else {
    // the shell / suite / fake GitHub they depend on, plus whatever file an entry itself breaks
    const broken = new Set(MUTATIONS.map((m) => m.file ?? MAIN));
    const hit = [...c.files.filter((f) => isRelatedForApp(f) || broken.has(f)), ...c.outside.filter((f) => SHARED_OUTSIDE.includes(f))];
    console.log(hit.length ? `相关：改了 ${hit.join('、')}` : `本次改动没有相关的真实窗口负对照。改了的文件：${[...c.files, ...c.outside].join('、') || '（无）'}`);
    process.exitCode = hit.length ? 0 : 1;
  }
}
else if (cmd === '--name') console.log(MUTATIONS[Number(arg)]?.what ?? '');
else if (cmd === '--one') {
  const m = MUTATIONS[Number(arg)];
  process.exitCode = m ? one(m) : fail(`没有第 ${arg} 项`);
} else {
  console.error('用法：由 test/tauri/mutations.sh 调用（--count | --name I | --related | --one I）');
  process.exitCode = 2;
}
