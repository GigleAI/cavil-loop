#!/usr/bin/env node
// Negative controls for the client's unit tests (same convention as the
// shell tests in ../../tests, GitHub#103): each entry breaks one spot of the
// real source in a throw-away copy and requires `vitest run` to go red.
//
//   node test/mutation/run.mjs              -> only counts: "负对照：跳过 N 项"
//   MUTATION=1 node test/mutation/run.mjs   -> runs every one
//
// A mutation whose `from` text is no longer in the file is a failure too
// (checked only with MUTATION=1), so a refactor cannot silently disarm one.

import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const MUTATIONS = [
  {
    what: '去重失效：同一条目按来源各算一张',
    file: 'src/data/merge.ts',
    from: "byKey.set(it.key, { ...it, projects: [...it.projects], sources: [...it.sources] });",
    to: "byKey.set(it.key + '|' + snap.sourceKey, { ...it, projects: [...it.projects], sources: [...it.sources] });",
  },
  {
    what: '迭代合列只看名字、不看开始日期',
    file: 'src/data/board.ts',
    from: 'return `iteration:${it.title}\\u0000${it.startDate}`;',
    to: 'return `iteration:${it.title}`;',
  },
  {
    what: '两个 Project 迭代不同时只出一张卡',
    file: 'src/data/board.ts',
    from: 'for (const [col, titles] of byCol) place(placements, col, item, titles);',
    to: 'for (const [col, titles] of [...byCol].slice(0, 1)) place(placements, col, item, titles);',
  },
  {
    what: '没有迭代字段时不回退到按状态',
    file: 'src/data/board.ts',
    from: "if (mode === 'iteration' && !projects.some((p) => p.hasIterationField)) {",
    to: "if (false) {",
  },
  {
    what: '已结束的迭代不再标出',
    file: 'src/data/board.ts',
    from: 'return addDays(it.startDate, it.duration) <= today;',
    to: 'return false;',
  },
  {
    what: '里程碑不按截止日期排序',
    file: 'src/data/board.ts',
    from: "const sort = due ? `0${due}` : '1';",
    to: "const sort = '1';",
  },
  {
    what: '不在任何所选 Project 的条目不进「未加入看板」',
    file: 'src/data/board.ts',
    from: '    place(placements, COL_UNBOARDED, item, []);\n    return;',
    to: '    return;',
  },
  {
    what: '离线时修改入口不变灰',
    file: 'src/data/board.ts',
    from: 'return !sync.offline;',
    to: 'return true;',
  },
  {
    what: 'Project 只读第一页',
    file: 'src/data/fetchSources.ts',
    from: 'if (!p.items.pageInfo.hasNextPage) break;',
    to: 'break;',
  },
  {
    what: '仓库来源不读最近 14 天关闭的',
    file: 'src/data/fetchSources.ts',
    from: 'export const REPO_RECENT_DAYS = 14;',
    to: 'export const REPO_RECENT_DAYS = 0;',
  },
  {
    what: '某来源读失败时把它当成空，而不是沿用上一轮',
    file: 'src/data/sync.ts',
    from: "if (err instanceof GitHubError && err.kind === 'auth') authFailed = true;",
    to: "snapshots.set(src.key, { sourceKey: src.key, fetchedAt: now, items: [] });\n      if (err instanceof GitHubError && err.kind === 'auth') authFailed = true;",
  },
  {
    what: '连不上 GitHub 不算离线',
    file: 'src/data/sync.ts',
    from: "const offline = !(err instanceof GitHubError) || err.kind === 'network';",
    to: 'const offline = false;',
  },
  {
    what: '缓存不覆盖旧快照',
    file: 'src/data/cache.ts',
    from: 'ON CONFLICT(source_key) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data',
    to: 'ON CONFLICT(source_key) DO NOTHING',
  },
  {
    what: '凭据被撤销后不回登录页',
    file: 'src/main/controller.ts',
    from: 'if (round.authFailed) await this.logout(REASON_REVOKED);',
    to: '',
  },
  {
    what: '授权等待中被当成失败',
    file: 'src/data/deviceFlow.ts',
    from: "case 'authorization_pending':",
    to: "case 'authorization_pending_disabled':",
  },
  {
    what: '用户拒绝授权不区分出来',
    file: 'src/data/deviceFlow.ts',
    from: "case 'access_denied':",
    to: "case 'access_denied_disabled':",
  },
  {
    what: '短码过期不区分出来',
    file: 'src/data/deviceFlow.ts',
    from: "case 'expired_token':",
    to: "case 'expired_token_disabled':",
  },
  {
    what: '分页链接指向别的主机也照跟',
    file: 'src/data/github.ts',
    from: "if (new URL(url).origin !== origin) throw",
    to: "if (false) throw",
  },
  {
    what: '钥匙串「找不到」被当成错误',
    file: 'src/platform/credentials.ts',
    from: 'if (exitCode(err) === 44) return resolve(null);',
    to: '',
  },
];

if (process.env.MUTATION !== '1') {
  console.log(`负对照：跳过 ${MUTATIONS.length} 项（MUTATION=1 时运行）`);
  process.exit(0);
}

let failed = 0;
let ran = 0;
for (const m of MUTATIONS) {
  ran++;
  const work = mkdtempSync(join(tmpdir(), 'cavil-client-mut-'));
  try {
    for (const d of ['src', 'test']) cpSync(join(root, d), join(work, d), { recursive: true });
    for (const f of ['package.json', 'tsconfig.json', 'vitest.config.ts']) cpSync(join(root, f), join(work, f));
    symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'));
    const target = join(work, m.file);
    const text = readFileSync(target, 'utf8');
    if (!text.includes(m.from)) {
      console.log(`❌ 准备失败（原文不在 ${m.file}）：${m.what}`);
      failed++;
      continue;
    }
    writeFileSync(target, text.replace(m.from, m.to));
    const r = spawnSync(join(work, 'node_modules', '.bin', 'vitest'), ['run', '--reporter=dot'], { cwd: work, encoding: 'utf8' });
    if (r.status === 0) {
      console.log(`❌ 没变红：${m.what}`);
      failed++;
    } else {
      console.log(`✅ 变红：${m.what}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
console.log(`负对照：本次跑了 ${ran} 项，${ran - failed} 项按预期变红，${failed} 项失败`);
process.exit(failed ? 1 : 0);
