#!/usr/bin/env node
// Negative controls for the client's unit tests (GitHub#103 convention).
// Entry point is test/mutation/run.sh, which goes through
// tests/lib/mutation.sh's `mutation_gate` once per entry. This file does the
// work for one step at a time:
//
//   node run.mjs --count        number of entries
//   node run.mjs --name I       one-line description of entry I
//   node run.mjs --baseline     unmodified copy: the suite must pass
//   node run.mjs --one I        entry I: the listed tests must fail by assertion
//
// "Red" is only accepted when vitest itself ran and reported a failed result
// for every test named in `expect`. A runner that cannot start, a signal, a
// timeout, a missing report or "something else failed" all count as a failed
// negative control — never as "went red as expected".
//
// Env for the runner's own tests: CLIENT_MUT_VITEST (vitest entry to run),
// CLIENT_MUT_TIMEOUT_MS, CLIENT_MUT_LIST (JSON file replacing MUTATIONS).

import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const MUTATIONS = [
  { what: '去重失效：同一条目按来源各算一张', file: 'src/data/merge.ts',
    from: "byKey.set(it.key, { ...it, projects: [...it.projects], sources: [...it.sources] });",
    to: "byKey.set(it.key + '|' + snap.sourceKey, { ...it, projects: [...it.projects], sources: [...it.sources] });",
    expect: ['an item from a Project and from its repository is one item'] },
  { what: '迭代合列只看名字、不看开始日期', file: 'src/data/board.ts',
    from: 'return `iteration:${it.title}\\u0000${it.startDate}`;', to: 'return `iteration:${it.title}`;',
    expect: ['same title but different start date stays two columns'] },
  { what: '两个 Project 迭代不同时只出一张卡', file: 'src/data/board.ts',
    from: 'for (const [col, titles] of byCol) place(placements, col, item, titles);',
    to: 'for (const [col, titles] of [...byCol].slice(0, 1)) place(placements, col, item, titles);',
    expect: ['one issue in two Projects with different iterations'] },
  { what: '没有迭代字段时不回退到按状态', file: 'src/data/board.ts',
    from: "if (mode === 'iteration' && !projects.some((p) => p.hasIterationField)) {", to: 'if (false) {',
    expect: ['falls back to status with a notice'] },
  { what: '已结束的迭代不再标出', file: 'src/data/board.ts',
    from: 'return addDays(it.startDate, it.duration) <= today;', to: 'return false;',
    expect: ['ended iterations are flagged'] },
  { what: '里程碑不按截止日期排序', file: 'src/data/board.ts',
    from: "const sort = due ? `0${due}` : '1';", to: "const sort = '1';",
    expect: ['milestones: same title across repos merges'] },
  { what: '不在任何所选 Project 的条目不进「未加入看板」', file: 'src/data/board.ts',
    from: '    place(placements, COL_UNBOARDED, item, []);\n    return;', to: '    return;',
    expect: ['items not in any selected Project go to 未加入看板'] },
  { what: '离线时修改入口不变灰', file: 'src/data/board.ts',
    from: 'return !sync.offline;', to: 'return true;',
    expect: ['offline → disabled; online → enabled'] },
  { what: 'Project 只读第一页', file: 'src/data/fetchSources.ts',
    from: 'if (!p.items.pageInfo.hasNextPage) break;', to: 'break;',
    expect: ['reads both pages'] },
  { what: '仓库来源不读最近 14 天关闭的', file: 'src/data/fetchSources.ts',
    from: 'export const REPO_RECENT_DAYS = 14;', to: 'export const REPO_RECENT_DAYS = 0;',
    expect: ['reads every open item plus anything updated in the last 14 days'] },
  { what: '某来源读失败时把它当成空，而不是沿用上一轮', file: 'src/data/sync.ts',
    from: "if (err instanceof GitHubError && err.kind === 'auth') authFailed = true;",
    to: "snapshots.set(src.key, { sourceKey: src.key, fetchedAt: now, items: [] });\n      replaced.push({ sourceKey: src.key, fetchedAt: now, items: [] });\n      if (err instanceof GitHubError && err.kind === 'auth') authFailed = true;",
    expect: ['a source that fails mid-pagination keeps its previous snapshot'] },
  { what: '连不上 GitHub 不算离线', file: 'src/data/sync.ts',
    from: "const offline = !(err instanceof GitHubError) || err.kind === 'network';", to: 'const offline = false;',
    expect: ['offline restart: cached content still shows'] },
  { what: '缓存不覆盖旧快照', file: 'src/data/cache.ts',
    from: 'ON CONFLICT(source_key) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data',
    to: 'ON CONFLICT(source_key) DO NOTHING',
    expect: ['each successful round replaces the cached snapshot as a whole'] },
  { what: '凭据被撤销后不回登录页', file: 'src/main/controller.ts',
    from: 'if (session === this.session) await this.logout(REASON_REVOKED);', to: '',
    expect: ['revoked credential → next sync returns to login'] },
  { what: '授权等待中被当成失败', file: 'src/data/deviceFlow.ts',
    from: "case 'authorization_pending':", to: "case 'authorization_pending_disabled':",
    expect: ['waiting → user approves'] },
  { what: '用户拒绝授权不区分出来', file: 'src/data/deviceFlow.ts',
    from: "case 'access_denied':", to: "case 'access_denied_disabled':",
    expect: ['user denies on GitHub'] },
  { what: '短码过期不区分出来', file: 'src/data/deviceFlow.ts',
    from: "case 'expired_token':", to: "case 'expired_token_disabled':",
    expect: ['code expires (GitHub says so)'] },
  { what: '分页链接指向别的主机也照跟', file: 'src/data/github.ts',
    from: 'if (new URL(url).origin !== origin) throw', to: 'if (false) throw',
    expect: ['refuses to follow a pagination link to another host'] },
  { what: '钥匙串「找不到」被当成错误', file: 'src/platform/credentials.ts',
    from: 'if (exitCode(err) === 44) return resolve(null);', to: '',
    expect: ['set → get → clear round-trips'] },
  // ---- review round 1 of PR #140 ----
  { what: '退出登录不清缓存', file: 'src/main/controller.ts',
    from: '    // Signing out forgets everything read with that account.\n    this.wipeCache();', to: '',
    expect: ['sign out → another account signs in'] },
  { what: '缓存归属不记账（同账号离线重启也看不到缓存）', file: 'src/main/controller.ts',
    from: 'if (login && login === this.owner) return;', to: 'return;',
    expect: ['offline restart: cached content still shows'] },
  { what: '凭据在 App 外被换掉、离线重启时照显示旧缓存', file: 'src/main/controller.ts',
    from: "if (this.deps.cache.getSetting<string | null>('cacheCredential', null) !== credentialTag(stored.accessToken)) {", to: 'if (false) {',
    expect: ['restart offline: the other account'] },
  { what: '旧账号的在途同步在换账号后照样写入', file: 'src/main/controller.ts',
    from: 'if (session !== this.session) {', to: 'if (false) {',
    expect: ['a round still in flight for the first account'] },
  { what: '同步途中删掉的来源被旧请求写回', file: 'src/main/controller.ts',
    from: 'const accepted = round.replaced.filter((snap) => current(snap.sourceKey));', to: 'const accepted = round.replaced;',
    expect: ['removed → the finished old request'] },
  { what: '删掉又重加的来源收下删除前发出的旧请求', file: 'src/main/controller.ts',
    from: ' && (this.epochs.get(key) ?? 0) === epochAtStart.get(key);', to: ';',
    expect: ['removed and added again'] },
  // ---- review round 2 of PR #140 ----
  { what: '凭据写完不再核对登录是否已取消 / 已退出', file: 'src/main/controller.ts',
    from: 'await this.deps.credentials.set(encodeGrant(grant));\n        if (run !== this.loginRun) {',
    to: 'await this.deps.credentials.set(encodeGrant(grant));\n        if (false) {',
    expect: ['cancel while saving → nothing kept', 'sign out while saving → same'] },
  { what: '凭据写入 / 删除不排队', file: 'src/main/controller.ts',
    from: 'const p = this.credQueue.then(fn);', to: 'const p = fn();',
    expect: ['an older login finishing its save after a newer login'] },
  // ---- GitHub App sign-in (maintainer's choice on PR #140) ----
  { what: '快到期也不提前续期', file: 'src/main/controller.ts',
    from: 'if (!force && (used.expiresAt == null || used.expiresAt - this.now() > REFRESH_MARGIN_MS)) return',
    to: 'if (!force) return',
    expect: ['near expiry: refreshed before the round'] },
  { what: '续期不合并：同时触发会续两次', file: 'src/main/controller.ts',
    from: 'if (this.refreshing) return this.refreshing;', to: '',
    expect: ['two rounds asking at once share one refresh'] },
  { what: 'GitHub 回 401 时不续期重试', file: 'src/main/controller.ts',
    from: "if (r === 'ok') return this.runRound(true);", to: "if (r === 'ok') return;",
    expect: ['GitHub says 401 before the deadline'] },
  { what: '续期被拒当成连不上（不退出登录）', file: 'src/main/controller.ts',
    from: "if (reason === 'expired') {",
    to: 'if (false) {',
    expect: ['GitHub refuses the refresh token'] },
  { what: '连不上 GitHub 也当成续期被拒（误退出登录）', file: 'src/main/controller.ts',
    from: "if (reason === 'unreachable') return 'unreachable';",
    to: "if (reason === 'unreachable') { await signOut(); return 'ended'; }",
    expect: ['GitHub unreachable at refresh time'] },
  { what: '续期后不更新缓存绑定（离线重启丢缓存）', file: 'src/main/controller.ts',
    from: "if (this.owner && saved) this.deps.cache.setSetting('cacheCredential', credentialTag(next.accessToken));",
    to: '',
    expect: ['refreshed, then the round could not reach GitHub'] },
  { what: '续期写完不再核对是否已退出', file: 'src/main/controller.ts',
    from: "          if (!current()) return 'ended' as const;\n          // GitHub has rotated",
    to: '          // GitHub has rotated',
    expect: ['signing out while the refreshed token is being saved'] },
  // ---- review of 2026-11-05 17:48: refresh failure paths ----
  { what: '续期接口 5xx 带错误正文时不先按「暂时不可用」处理', file: 'src/data/deviceFlow.ts',
    from: 'if (res.status >= 500 || res.status === 429) {', to: 'if (false) {',
    expect: ['HTTP 503 with an error body', 'HTTP 503 {"error":"temporarily_unavailable"} → unreachable'] },
  { what: '续期的任何错误都当成凭据失效', file: 'src/data/deviceFlow.ts',
    from: 'if (body.error === REFRESH_TOKEN_REJECTED) {', to: 'if (body.error) {',
    expect: ['an unknown refresh error', 'HTTP 400 {"error":"temporarily_unavailable"} → error'] },
  { what: '续期后写钥匙串失败就整次作废（继续用已被 GitHub 作废的旧续期令牌）', file: 'src/main/controller.ts',
    from: '          try {\n            await this.deps.credentials.set(encodeGrant(next));\n          } catch (e) {\n            saved = false;\n            this.unsavedProblem = (e as Error).message;\n          }',
    to: '          await this.deps.credentials.set(encodeGrant(next));',
    expect: ['refreshed but the keychain refuses the write'] },
  { what: '没存进钥匙串的凭据之后不再重试保存', file: 'src/main/controller.ts',
    from: '    await this.saveUnsavedGrant();\n', to: '',
    expect: ['refreshed but the keychain refuses the write'] },
  { what: '登录轮询遇到 503 直接判登录失败', file: 'src/data/deviceFlow.ts',
    from: "if (e instanceof DeviceFlowError && e.reason === 'unreachable') continue;", to: '',
    expect: ['a device-flow poll that gets a 503'] },
  { what: '整份换回本轮复审时的旧实现（提交 f533fcb：未处理拒绝 + 503 误清登录）', file: 'src/main/controller.ts',
    fromGit: 'f533fcb78365446cce003ae5a28a4d088facb082:client/src/main/controller.ts',
    expect: ['no unhandled rejection, still signed in', 'refreshed but the keychain refuses the write'] },
  // ---- review round 2 (18:10): sign-out when the keychain refuses the delete ----
  { what: '退出时删凭据失败就把错误抛出去（页面停在看板）', file: 'src/main/controller.ts',
    from: 'const err = await this.serialCredential(() => this.clearStored());\n    // only while',
    to: 'const err = await this.serialCredential(async () => { await this.deps.credentials.clear(); return null as string | null; });\n    // only while',
    expect: ['manual sign-out + delete refused'] },
  { what: '整份换回第 2 轮复审时的旧实现（提交 bdce2b2）', file: 'src/main/controller.ts',
    fromGit: 'bdce2b2:client/src/main/controller.ts',
    expect: ['manual sign-out + delete refused', 'refresh refused (bad_refresh_token) + delete refused'] },
  // ---- review (2026-11-05 19:49): quit while the sign-out's keychain delete is outstanding ----
  { what: '退出登录不先撤销「可信」就去删钥匙串（删除没返回就关 App，重启自动登录旧账号）', file: 'src/main/controller.ts',
    from: '    this.setTrusted([]);\n    // Signing out forgets', to: '    // Signing out forgets',
    expect: ['sign-out, delete-pending, quit', 'sign-out, delete-queued, quit'] },
  { what: '启动时不看可信名单，钥匙串里有什么就用什么', file: 'src/main/controller.ts',
    from: 'if (!trusted.includes(credentialTag(stored.accessToken))) {', to: 'if (false) {',
    expect: ['sign-out, delete-pending, quit', 'sign-out, delete-fails, quit', 'credential replaced outside the app: not trusted'] },
  { what: '续期写钥匙串时不同时信任新旧两份（写一半关 App，重启被迫重新登录）', file: 'src/main/controller.ts',
    from: '          this.setTrusted([used.accessToken, next.accessToken]);\n', to: '',
    expect: ['a refresh quits while writing the new token'] },
  { what: '整份换回本轮复审时的旧实现（提交 1dc8219）', file: 'src/main/controller.ts',
    fromGit: '1dc8219:client/src/main/controller.ts',
    expect: ['sign-out, delete-pending, quit', 'sign-out, delete-queued, quit'] },
  // ---- review (2026-11-05 20:12): upgrade from a preview build ----
  { what: '没有可信名单的旧数据就信任钥匙串里那份（旧版已退出的账号被登录回去）', file: 'src/main/controller.ts',
    from: "this.deps.cache.getSetting<string[] | null>(TRUSTED, null) ?? [];", to: "this.deps.cache.getSetting<string[] | null>(TRUSTED, null) ?? [credentialTag(stored.accessToken)];",
    expect: ['old build signed out but could not delete the credential', 'old build simply signed in'] },
  { what: '整份换回本轮复审时的旧实现（提交 ad63b3f）', file: 'src/main/controller.ts',
    fromGit: 'ad63b3f:client/src/main/controller.ts',
    expect: ['old build signed out but could not delete the credential'] },
  // sign-in method (GitHub#140: OAuth app by default, GitHub App when chosen)
  { what: '保存 Client ID 时不管选的是哪种，一律写进 OAuth 应用那一格', file: 'src/main/controller.ts',
    from: 'this.deps.cache.setSetting(CLIENT_ID_SETTING[this.state.appKind], v);', to: 'this.deps.cache.setSetting(CLIENT_ID_SETTING.oauth, v);',
    expect: ["the chosen kind's Client ID is the one sent to GitHub"] },
  { what: '选 GitHub App 但没填 ID 时，偷偷改用内置的 OAuth 应用', file: 'src/main/controller.ts',
    from: "'github-app': deps.defaultGithubAppClientId ?? DEFAULT_GITHUB_APP_CLIENT_ID,",
    to: "'github-app': deps.defaultGithubAppClientId || (deps.defaultClientId ?? DEFAULT_OAUTH_CLIENT_ID),",
    expect: ['GitHub App has no built-in ID, so signing in says what to fill in and calls nothing'] },
  { what: '切回 OAuth 应用后仍用 GitHub App 的 ID 登录', file: 'src/main/controller.ts',
    from: "    this.set({ appKind: k, ...this.clientIdFor(k) });", to: "    this.set({ appKind: k });",
    expect: ["switching back to the OAuth app sends the OAuth app's ID"] },
  { what: '预览版存在唯一那格里的 GitHub App ID 被当成 OAuth 应用', file: 'src/main/controller.ts',
    from: "const kind: AppKind = /^Iv/.test(old) ? 'github-app' : 'oauth';", to: "const kind: AppKind = 'oauth';",
    expect: ['a preview build that saved a GitHub App ID in the single box'] },
  { what: '续期用当前设置的 Client ID，而不是登录时那个应用的', file: 'src/main/controller.ts',
    from: "this.deps.cache.getSetting<string>('grantClientId', '') || this.state.clientId;", to: 'this.state.clientId;',
    expect: ['changing the sign-in method while signed in: the token is still refreshed with the app it came from'] },
];

const list = process.env.CLIENT_MUT_LIST ? JSON.parse(readFileSync(process.env.CLIENT_MUT_LIST, 'utf8')) : MUTATIONS;
const VITEST = process.env.CLIENT_MUT_VITEST ?? join(root, 'node_modules', 'vitest', 'vitest.mjs');
const TIMEOUT_MS = Number(process.env.CLIENT_MUT_TIMEOUT_MS ?? 180_000);

function sandbox() {
  const work = mkdtempSync(join(tmpdir(), 'cavil-client-mut-'));
  for (const d of ['src', 'test']) cpSync(join(root, d), join(work, d), { recursive: true });
  for (const f of ['package.json', 'tsconfig.json', 'vitest.config.ts']) cpSync(join(root, f), join(work, f));
  symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'));
  return work;
}

/** Run vitest in `work`; resolve to { kind: 'report', status, report } or { kind: 'broken', why }. */
function runVitest(work) {
  const out = join(work, 'vitest-report.json');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [VITEST, 'run', '--reporter=json', `--outputFile=${out}`], {
        cwd: work,
        env: { ...process.env, CLIENT_MUT_CHILD: '1', CLIENT_MUT_REPO: root },
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

function results(report) {
  return report.testResults.flatMap((f) => f.assertionResults.map((a) => ({ name: a.fullName, status: a.status })));
}

async function baseline() {
  const work = sandbox();
  try {
    const r = await runVitest(work);
    if (r.kind === 'broken') return fail(`基线没跑成：${r.why}`);
    const all = results(r.report);
    // the runner's own self-tests skip themselves inside child runs; anything else must pass
    const bad = all.filter((t) => t.status !== 'passed' && !(t.status === 'skipped' || t.status === 'pending') );
    const passed = all.filter((t) => t.status === 'passed').length;
    if (r.status !== 0 || bad.length || passed === 0 || r.report.numFailedTestSuites) {
      return fail(`基线不是全绿（退出码 ${r.status}，${all.length} 条，未通过：${bad.map((t) => t.name).join('；') || '套件加载失败'}）`);
    }
    console.log(`✅ 基线：未改动的副本 ${passed} 条全过（另 ${all.length - passed} 条是负对照执行器的自检，子进程里不跑）`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function one(i) {
  const m = list[i];
  if (!m) return fail(`没有第 ${i} 项`);
  const work = sandbox();
  try {
    const target = join(work, m.file);
    if (m.fromGit) {
      let old;
      try {
        old = execFileSync('git', ['show', m.fromGit], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return fail(`准备失败（取不到 ${m.fromGit}）：${m.what}`);
      }
      writeFileSync(target, old);
    } else {
      const text = readFileSync(target, 'utf8');
      if (!text.includes(m.from)) return fail(`准备失败（原文不在 ${m.file}）：${m.what}`);
      writeFileSync(target, text.replace(m.from, m.to));
    }
    const r = await runVitest(work);
    if (r.kind === 'broken') return fail(`执行异常（${r.why}）：${m.what}`);
    if (r.status === 0) return fail(`没变红：${m.what}`);
    const all = results(r.report);
    const missing = m.expect.filter((name) => !all.some((t) => t.status === 'failed' && t.name.includes(name)));
    if (missing.length) {
      const failed = all.filter((t) => t.status === 'failed').map((t) => t.name);
      return fail(`红了，但不是预期的断言（缺：${missing.join('；')}；实际失败：${failed.join('；') || '无，可能是套件加载失败'}）：${m.what}`);
    }
    console.log(`✅ 变红（${m.expect.length} 条预期断言失败）：${m.what}`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function fail(msg) {
  console.log(`❌ ${msg}`);
  return 1;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === '--count') console.log(list.length);
else if (cmd === '--name') console.log(list[Number(arg)]?.what ?? '');
else if (cmd === '--baseline') process.exitCode = await baseline();
else if (cmd === '--one') process.exitCode = await one(Number(arg));
else {
  console.error('用法：由 test/mutation/run.sh 调用（--count | --name I | --baseline | --one I）');
  process.exitCode = 2;
}
