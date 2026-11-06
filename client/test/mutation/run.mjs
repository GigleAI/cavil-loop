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
// Entries with `runner: 'e2e'` break the code the same way but run the named
// Playwright tests against the real Electron window instead (`expect` names
// test titles); the baseline then also runs those tests on an unmodified copy.
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
    from: 'for (const [col, titles] of byCol) place(placements, col, item, titles, keysByCol.get(col));',
    to: 'for (const [col, titles] of [...byCol].slice(0, 1)) place(placements, col, item, titles, keysByCol.get(col));',
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
  // review round 1: what is said must match what is sent (GitHub#140)
  { what: '登录前不核对 Client ID 和所选方式是否对得上', file: 'src/main/controller.ts',
    from: '    if (mismatch) {', to: '    if (false) {',
    expect: ['a Client ID that does not match the chosen method is refused before anything is sent'] },
  { what: '选 GitHub App 却填了 OAuth 应用的 ID 也放行', file: 'src/shared/appKind.ts',
    from: "if (kind === 'github-app' && !isAppId) {", to: 'if (false) {',
    expect: ['a Client ID that does not match the chosen method is refused before anything is sent'] },
  { what: 'ID 和方式对不上时仍显示较小的权限说明', file: 'src/shared/appKind.ts',
    from: "if (clientIdKindProblem(kind, clientId)) return '所填的 Client ID 和登录方式对不上，登录前请先改好。';", to: '',
    expect: ['says nothing reassuring for a mismatched ID'] },
  { what: '退回上一版说法：GitHub App「碰不到代码」', file: 'src/shared/appKind.ts',
    from: "'用 GitHub App 时，权限由那个 App 登记时勾选的决定，登录时没法再收窄；GitHub 授权页上列的才算数。本应用这一版只读取看板数据。'",
    to: "'GitHub 授权页上会列出：Issues、Pull requests、Projects 读写，仓库基本信息只读，碰不到代码。'",
    expect: ['never promises a GitHub App cannot touch code'] },
  { what: '退回上一版说法：OAuth 应用一律「不过期」', file: 'src/shared/appKind.ts',
    from: "    oauth: '看应用的设置：开了「令牌过期」的会过期（本应用会自动续期）；没开的不过期，直到你撤销。',",
    to: "    oauth: '不过期，直到你撤销。',",
    expect: ['never states a fixed lifetime'] },
  // ---- search / filter / table / view import (#137) ----
  { what: '取反当成不取反（-label:x 当成 label:x）', file: 'src/shared/filter.ts',
    from: 'return c.negated ? !hit : hit;', to: 'return hit;',
    expect: ['label: exact name, case-insensitive; comma = either; repeated = both; - negates', 'same items as GitHub: -label:Done'] },
  { what: '去掉黄条判断：不认识的词不列出来、当成字段去筛（结果变成 0 条）', file: 'src/shared/filter.ts',
    from: 'if (!FIELDS.includes(field) || values.some((v) => !v) || !valuesSupported(field, values)) {', to: 'if (false) {',
    expect: ['date comparison: updated:>2026-01-01', 'custom field: priority:High', 'several unsupported words are all listed, in order'] },
  { what: '逗号「或」当成「且」', file: 'src/shared/filter.ts',
    from: 'const hit = c.values.some((v) => valueHit(item, c.field, v, ctx, tokens));', to: 'const hit = c.values.every((v) => valueHit(item, c.field, v, ctx, tokens));',
    expect: ['same items as GitHub: label:pending/human,pending/agent', 'is: open / closed (merged counts as closed, as on GitHub) / merged / issue / pr'] },
  { what: '中文像 GitHub 那样按词切开，词中间的部分搜不到', file: 'src/shared/filter.ts',
    from: '.every((w) => lc(item.title).includes(w) ||', to: ".every((w) => lc(item.title).split(/[\\s\\p{P}]+/u).includes(w) ||",
    expect: ['free text: title, any position, case-insensitive; Chinese in the middle of a run'] },
  { what: 'is:closed 不含已合并的 PR', file: 'src/shared/filter.ts',
    from: "if (v === 'closed') return item.state !== 'open';", to: "if (v === 'closed') return item.state === 'closed';",
    expect: ['same items as GitHub: is:closed'] },
  { what: '@previous / @next 对调', file: 'src/shared/filter.ts',
    from: "    '@next': list[i + 1]?.id ?? null,\n    '@previous': list[i - 1]?.id ?? null,", to: "    '@next': list[i - 1]?.id ?? null,\n    '@previous': list[i + 1]?.id ?? null,",
    expect: ['same items as GitHub: iteration:@previous', 'iteration: title, @current / @next / @previous per Project, no: / has:'] },
  { what: '子 issue 不缩进到父 issue 下', file: 'src/data/table.ts',
    from: 'if (p) children.set(p, [...(children.get(p) ?? []), it]);', to: 'if (p) top.push(it);',
    expect: ['hierarchy: sub-issues under their parent, recursively; a child in another group stays at top level there'] },
  { what: '合并来源时关联 PR 被仓库那份（读不到关联 PR）盖掉', file: 'src/data/merge.ts',
    from: 'const linked = newer.linkedPrs ?? older.linkedPrs;', to: 'const linked = newer.linkedPrs;',
    expect: ['linked pull requests come from the copy that knows them, even when the repository copy is newer'] },
  { what: '导入覆盖用户在首次读取前改过的设置', file: 'src/main/controller.ts',
    from: "if (!p.touched.includes(k)) (next as any)[k] = patch[k];", to: '(next as any)[k] = patch[k];',
    expect: ['a change made before the Project was first read wins over the import; a failed read imports later'] },
  { what: '导入不只一次：之后每轮同步都重新导入，冲掉用户的修改', file: 'src/main/controller.ts',
    from: '    this.deps.cache.setSetting(PENDING_IMPORTS, pending);\n    if (view !== this.state.view) {', to: '    if (view !== this.state.view) {',
    expect: ['the import happens once: a later change of the saved view on GitHub does not override the client'] },
  { what: '删掉再加 Project 不重新导入', file: 'src/main/controller.ts',
    from: "    if (src.kind === 'project') {\n      const pending", to: "    if (false) {\n      const pending",
    expect: ['settings changed by the user survive a restart; removing and re-adding the Project imports again'] },
  { what: '字段名只认英文：中文 / 带引号的自定义字段落进文字搜索（筛成 0 条、没有黄条）', file: 'src/shared/filter.ts',
    from: String.raw`const m = token.match(/^(-?)("[^"]+"|[^\s:"]+):(.*)$/);`, to: 'const m = token.match(/^(-?)([A-Za-z][A-Za-z0-9_-]*):(.*)$/);',
    expect: ['Chinese custom field: 优先级:高', 'quoted field name with a space: "Start date":2026-11-01', 'a Chinese custom field next to supported words: the supported part still filters (as in an imported view)'] },
  { what: '看板不用视图的排序（导入了「按更新时间」也仍按编号排）', file: 'src/data/board.ts',
    from: 'const cardOrder = sort ? itemSorter(sort, projects, items) : BY_REPO_NUMBER;', to: 'const cardOrder = BY_REPO_NUMBER;',
    expect: ['import a board view sorted by "updated, newest first" → the board shows newest first', 'recorded board view 2 ("by update, newest first") → every board column is newest first'] },
  { what: '带引号含冒号的普通文字被当成字段', file: 'src/shared/filter.ts',
    from: String.raw`const m = token.match(/^(-?)("[^"]+"|[^\s:"]+):(.*)$/);`, to: 'const m = token.replace(/"/g, "").match(/^(-?)([^\\s:]+):(.*)$/);',
    expect: ['a quoted word with a colon in it is plain text, not a field'] },
  { what: '导入时 /views/N 被忽略，总是导入第一个视图', file: 'src/shared/viewImport.ts',
    from: 'if (wanted === undefined) return { view: project.views[0], note: null };', to: 'return { view: project.views[0], note: null };',
    expect: ['pickView: /views/N when present, else the first one with a note; no views at all is said'] },
  { what: '改完重读时把条目挪到末尾（打乱「Project 里的顺序」）', file: 'src/data/itemRefresh.ts',
    from: '        ? snap.items.map((x) => (x.key === base.key ? next! : x))', to: '        ? [...snap.items.filter((x) => x.key !== base.key), next]',
    expect: ['label added on the first item: re-read at once → table and board order unchanged → still unchanged after a full sync', 'pure rule: an item still on the Project is replaced in place; one gone from it is removed; one new to it is appended'] },
  // ---- sub-item #138: viewing and changing items ----
  { what: '合并不带看到的提交（PR 期间被推新提交也照合）', file: 'src/data/actions.ts',
    from: '{ merge_method: action.method, sha: action.headOid }', to: '{ merge_method: action.method }',
    expect: ['a new commit was pushed after the user looked', 'merge sends the method and the commit the user saw'] },
  { what: '加标签改成整份覆盖（按缓存里的列表 PUT）', file: 'src/data/actions.ts',
    from: '      await addLabel(client, it.repo, it.number, action.label);',
    to: "      await client.rest('PUT', `${repoPath(it.repo)}/issues/${it.number}/labels`, { labels: [...it.labels.map((l) => l.name), action.label] });",
    expect: ['add a label: POST with just that label'] },
  { what: '删标签改成整份覆盖', file: 'src/data/actions.ts',
    from: '      await removeLabel(client, it.repo, it.number, action.label);',
    to: "      await client.rest('PUT', `${repoPath(it.repo)}/issues/${it.number}/labels`, { labels: it.labels.map((l) => l.name).filter((n) => n !== action.label) });",
    expect: ['remove a label: DELETE of that one label'] },
  { what: '仓库里没有同名里程碑时改用别的里程碑', file: 'src/data/actions.ts',
    from: "const pick = same.find((m) => m.state === 'open') ?? same[0];", to: "const pick = same.find((m) => m.state === 'open') ?? same[0] ?? ms[0];",
    expect: ['no milestone with that title in this repository'] },
  { what: '看板不可写时照样发字段修改', file: 'src/data/actions.ts',
    from: 'if (!p.viewerCanUpdate) throw', to: 'if (false) throw',
    expect: ['a Project the account cannot change'] },
  { what: '离线时照样发修改', file: 'src/main/controller.ts',
    from: 'if (write && !writesEnabled(this.state.sync))', to: 'if (false)',
    expect: ['offline round → every change refused before sending'] },
  { what: '修改成功后不立即重读', file: 'src/main/controller.ts',
    from: 'const problem = await this.refreshOne(c.client, c.session, repo, number);', to: 'const problem = null;',
    expect: ['add a label: POST with just that label', 'iteration: set and clear', 'an item not on the board'] },
  { what: '详情按时间正序（最老在上）', file: 'src/data/detail.ts',
    from: 'const desc = (a: { at: string }, b: { at: string }) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);',
    to: 'const desc = (a: { at: string }, b: { at: string }) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);',
    expect: ['comments, reviews and their line comments by time', 'pure ordering'] },
  { what: '详情只读评论第一页', file: 'src/data/detail.ts',
    from: 'withComments = it.comments.pageInfo.hasNextPage;', to: 'withComments = false;',
    expect: ['every page read'] },
  { what: '合并方式不看仓库允许哪些', file: 'src/data/detail.ts',
    from: "...(r.mergeCommitAllowed ? (['merge'] as const) : []),", to: "...(['merge'] as const),",
    expect: ['only the methods the repository allows'] },
  { what: '提交已变（409）不说明要刷新', file: 'src/data/actions.ts',
    from: 'if (st === 409) return', to: 'if (false) return',
    expect: ['a new commit was pushed after the user looked'] },
  { what: '拖卡改了这一条所在的所有看板，而不只是这张卡所在的', file: 'src/data/board.ts',
    from: '  for (const k of card.projectKeys) {', to: '  for (const k of it.projects.map((m) => m.projectKey)) {',
    expect: ['a card in one Project changes only that one'] },
  { what: '详情的 GitHub HTML 外层文字不转义', file: 'src/renderer/detailHtml.ts',
    from: "return s.replace(/[&<>\"']/g,", to: "return s; void s.replace(/[&<>\"']/g,",
    expect: ['names and paths around GitHub\'s HTML are escaped'] },
  // ---- review round 1 of PR #150 ----
  { what: '评审的逐行评论只读第一页（超过 100 条丢后面的）', file: 'src/data/detail.ts',
    from: '    for (let n = 0; page.pageInfo.hasNextPage; n++) {', to: '    for (let n = 0; false; n++) {',
    expect: ['a review with more than 100 line comments'] },
  { what: '逐行评论后续页读失败时当作读完了', file: 'src/data/detail.ts',
    from: '      const d: { node: { comments?: Page<GqlLineComment> } | null } = await client.graphql(REVIEW_COMMENTS_QUERY, { id: r.id, after: page.pageInfo.endCursor });',
    to: '      let d: { node: { comments?: Page<GqlLineComment> } | null };\n      try { d = await client.graphql(REVIEW_COMMENTS_QUERY, { id: r.id, after: page.pageInfo.endCursor }); } catch { break; }',
    expect: ['a review with more than 100 line comments'] },
  { what: '详情图片放开到任何 HTTPS 地址', file: 'src/renderer/detailHtml.ts',
    from: "img-src ${IMAGE_HOSTS.join(' ')} data:", to: 'img-src https: data:',
    expect: ['images: only github.com / api.github.com load'] },
  { what: '主进程请求过滤放行 github.com 以外的子域', file: 'src/platform/index.ts',
    from: "(u.hostname === 'github.com' || u.hostname === 'api.github.com')", to: "u.hostname.endsWith('github.com')",
    expect: ['the main-process request filter'] },
  // ---- review round 2 of PR #150: every late answer of the detail panel, per call site (real Electron) ----
  { what: '同一次打开里，慢的详情读取盖过改完后的重读', file: 'src/renderer/DetailPanel.tsx', runner: 'e2e',
    from: '    const r = await api().loadDetail(itemKey);\n    if (!mine()) return;', to: '    const r = await api().loadDetail(itemKey);',
    expect: ['leave an item and come back'] },
  { what: '同一次打开里，改了字之后旧文字的预览照样显示', file: 'src/renderer/DetailPanel.tsx', runner: 'e2e',
    from: "              const r = await api().previewMarkdown(item.repo, reply);\n              if (!mine()) return;", to: "              const r = await api().previewMarkdown(item.repo, reply);",
    expect: ['leave an item and come back'] },
  { what: '离开再回来：旧的发送清掉新草稿（复审第 2 轮复现的情形）', file: 'src/renderer/DetailPanel.tsx', runner: 'e2e',
    from: '    if (!mine()) {\n      onLeftBehind', to: '    if (false) {\n      onLeftBehind',
    expect: ['leave an item and come back', 'a slow answer for the item you left'] },
  { what: '不按「打开」区分面板：换条目、回到原条目都沿用同一个面板', file: 'src/renderer/BoardView.tsx', runner: 'e2e',
    from: '<DetailPanel key={opened.n} ', to: '<DetailPanel ',
    expect: ['leave an item and come back'] },
  { what: '同一次打开里，旧的读取盖过新的读取', file: 'src/renderer/openSession.ts',
    from: "return () => open && seq[kind] === mine;", to: "return () => open;",
    expect: ['within one opening a newer call of the same kind wins'] },
  { what: '打开结束后仍收下它发出的回应', file: 'src/renderer/openSession.ts',
    from: "      open = false;", to: "      void 0;",
    expect: ['an opening that ended rejects every answer'] },
  // ---- pending/human reminders (GitHub#139) ----
  { what: '只算开着的条目（已关闭 / 已合并不算待处理）', file: 'src/data/pending.ts',
    from: 'for (const it of snap.items) if (hasLabel(it, this.label)) out.set(it.key, it);',
    to: "for (const it of snap.items) if (hasLabel(it, this.label) && it.state === 'open') out.set(it.key, it);",
    expect: ['start: what is already pending becomes one summary', 'notified exactly once — open issue, closed issue and merged PR alike', 'a closed item counts the same as an open one'] },
  { what: '读失败的来源当成空（报「移除」，恢复后又报「新增」）', file: 'src/main/controller.ts',
    from: '    this.observePending(accepted);',
    to: "    this.observePending([...accepted, ...round.status.filter((st) => !st.ok).map((st) => ({ sourceKey: st.sourceKey, fetchedAt: 0, items: [] }))]);",
    expect: ['a source that fails mid-pagination', 'offline rounds and back'] },
  { what: '不去重：同一条目按来源各算一个', file: 'src/data/pending.ts',
    from: '        const prev = out.get(key);\n        if (!prev || it.updatedAt > prev.updatedAt) out.set(key, it);',
    to: '        out.set(`${key}|${out.size}`, it);',
    expect: ['an item carried by two sources is notified once, counted once', 'start: what is already pending becomes one summary', 'two sources that both start carrying one item in the same round'] },
  { what: '第一次读到的来源逐条通知，而不是汇总', file: 'src/data/pending.ts',
    from: '      if (newSources.includes(set)) continue;\n', to: '',
    expect: ['start: what is already pending becomes one summary', 'a newly added source: what it brings is summarised once'] },
  { what: '摘掉标签后还记着（再挂上不再通知）', file: 'src/data/pending.ts',
    from: '      this.bySource.set(snap.sourceKey, set);\n', to: '      this.bySource.set(snap.sourceKey, new Map([...(this.bySource.get(snap.sourceKey) ?? []), ...set]));\n',
    expect: ['label removed and put back → notified again'] },
  { what: '标签名区分大小写（GitHub 不区分）', file: 'src/data/pending.ts',
    from: "return want !== '' && item.labels.some((l) => l.name.toLowerCase() === want);",
    to: "return want !== '' && item.labels.some((l) => l.name === label.trim());",
    expect: ['another label name: recounted silently'] },
  { what: '退出登录不清角标', file: 'src/main/controller.ts',
    from: '    this.pending.reset();\n', to: '',
    expect: ['sign out clears the badge and the count'] },
  { what: '系统拒绝通知时不告诉用户', file: 'src/main/controller.ts',
    from: 'this.deps.alerts?.notify(a, (d) => this.reportNotification(d));', to: 'this.deps.alerts?.notify(a);',
    expect: ['is shown in the app (not silently lost)'] },
  { what: '「通知被拒」黄条的标识里带上时间：同一个原因也当成新问题', file: 'src/renderer/warnings.ts',
    from: "return notifyProblem ? { 'board-notify-problem': notifyProblem } : {};",
    to: "return notifyProblem ? { 'board-notify-problem': `${notifyProblem}@${Date.now()}${Math.random()}` } : {};",
    expect: ['× closes it for this reason only'] },
  { what: '删除来源后角标不变', file: 'src/main/controller.ts',
    from: '    this.pending.prune(sources.map((s) => s.key));\n', to: '',
    expect: ['removing a source drops what only it carried'] },
  { what: '改「等人处理的标签」后提醒仍按旧标签计数（两处设置各管各）', file: 'src/main/controller.ts',
    from: '      this.pending.relabel(next.human, this.snapshots);\n', to: '',
    expect: ['another label name: recounted silently'] },
  // ---- app icon (GitHub#144) ----
  { what: '图标不留苹果网格边（满幅 1024）', file: 'scripts/icon.mjs',
    from: 'export const BODY = 824;', to: 'export const BODY = 1024;',
    expect: ['is exactly what the generator makes', "sits on Apple's icon grid"] },
  { what: '原图的黑边不去掉', file: 'scripts/icon.mjs',
    from: '          if (!insideSource(sx, sy)) continue;\n', to: '',
    expect: ['is exactly what the generator makes'] },
  { what: '包内图标比对不看差异，一律通过', file: 'scripts/icon.mjs',
    from: 'ok: distance <= SAME_ICON_MAX_DISTANCE,', to: 'ok: true,',
    expect: ['fails on a different picture', 'exits 0 only on a match'] },
  { what: '取 .icns 里第一张而不是最大的一张', file: 'scripts/icon.mjs',
    from: 'if (!best || img.width > best.img.width)', to: 'if (!best)',
    expect: ['fails on a different picture, even when the smaller slots are ours'] },
  { what: '读不到图标文件当成通过', file: 'scripts/icon.mjs',
    from: "if (!existsSync(icnsPath)) throw new Error(`Info.plist names ${name}, but Contents/Resources/${name} does not exist`);",
    to: "if (!existsSync(icnsPath)) return { icon: name, entry: '', size: '', distance: 0, ok: true, img: decodePng(readFileSync(expectedPng)) };",
    expect: ['cannot read → refuses, never passes', 'exits 0 only on a match'] },
  // ---- yellow bars can be closed (GitHub#153) ----
  { what: '黄条标识带上「数据截至」时间：只是时间过去也当成新问题', file: 'src/renderer/warnings.ts',
    from: "JSON.stringify([f.sourceKey, f.error ?? ''])", to: "JSON.stringify([f.sourceKey, f.error ?? '', f.dataFrom])",
    expect: ['two states that differ only in "data as of"', 'only time passes (same failure, older data)'] },
  { what: '离线标识带上「数据截至」时间', file: 'src/renderer/warnings.ts',
    from: "if (sync.offline) out.offline = 'offline';", to: "if (sync.offline) out.offline = 'offline ' + sync.dataFrom;",
    expect: ['two states that differ only in "data as of"'] },
  { what: '同步不完整只认来源、不认失败原因', file: 'src/renderer/warnings.ts',
    from: "JSON.stringify([f.sourceKey, f.error ?? ''])", to: 'f.sourceKey',
    expect: ['the reason changes', 'sync incomplete: source + reason'] },
  { what: '黄条不再出现时不清关闭记录（恢复后再失败、取消筛选后再筛选仍被收着）', file: 'src/renderer/warnings.ts',
    from: 'if (current[k] !== undefined && current[k] === dismissed[k])', to: 'if (current[k] === undefined || current[k] === dismissed[k])',
    expect: ['recovers, then fails the same way again', 'closed → filter cleared', 'sync incomplete closed → offline'] },
  { what: '关一条黄条把别的也收起', file: 'src/renderer/warnings.ts',
    from: 'return current[kind] !== undefined && dismissed[kind] !== current[kind];', to: 'return current[kind] !== undefined && Object.keys(dismissed).length === 0;',
    expect: ['close → only that bar goes'] },
  { what: '黄条不再出现时不清关闭记录（真窗口：恢复后再失败）', file: 'src/renderer/warnings.ts', runner: 'e2e',
    from: 'if (current[k] !== undefined && current[k] === dismissed[k])', to: 'if (current[k] === undefined || current[k] === dismissed[k])',
    expect: ['yellow bars: × closes one bar'] },
  { what: '只在看板页对账：在设置页期间恢复 / 导入改了筛选都错过', file: 'src/renderer/App.tsx', runner: 'e2e',
    from: 'const live = current ? reconcile(closed, current) : closed;', to: "const live = current && page === 'board' ? reconcile(closed, current) : closed;",
    expect: ['yellow bars: × closes one bar', 'yellow bars: a closed "unsupported words" bar comes back'] },
  { what: '切到设置页被当成取消筛选：只是来回切页，筛选黄条也重新弹出', file: 'src/renderer/App.tsx', runner: 'e2e',
    from: 'warningIds(sync, parsed)', to: "warningIds(sync, page === 'board' ? parsed : parseFilter(''))",
    expect: ['yellow bars: a closed "unsupported words" bar comes back'] },
  // ---- the copy-the-command page in the dmg (GitHub#153) ----
  { what: '剪贴板接口失败后不退回「选中 + 复制」', file: 'build/复制放行命令.html', runner: 'e2e',
    from: "Promise.resolve(p).then(function () { say(COPIED, 'ok'); }, fallback);", to: "Promise.resolve(p).then(function () { say(COPIED, 'ok'); }, function () {});",
    expect: ['clipboard API fails (reject)', 'both ways fail (older way refuses)'] },
  { what: '旧写法复制失败也当成已复制', file: 'build/复制放行命令.html', runner: 'e2e',
    from: "return document.execCommand('copy') === true;", to: "document.execCommand('copy');\n        return true;",
    expect: ['both ways fail (older way refuses)'] },
  { what: '网页里的命令和定义不一致', file: 'build/复制放行命令.html',
    from: '<code id="cmd">xattr -dr com.apple.quarantine "/Applications/Cavil Loop.app"</code>', to: '<code id="cmd">xattr -d com.apple.quarantine "/Applications/Cavil Loop.app"</code>',
    expect: ['build/复制放行命令.html carries exactly that command', 'copies the text of the element it shows'] },
  { what: 'txt 里的命令和定义不一致', file: 'build/打不开时看这里.txt',
    from: '"/Applications/Cavil Loop.app"', to: '"/Applications/CavilLoop.app"',
    expect: ['build/打不开时看这里.txt carries exactly that command'] },
  // review round 1 of PR #158: every copy of the command gets its own negative control
  { what: '背景源文件里的命令和定义不一致', file: 'build/dmg-background.html',
    from: '<code>xattr -dr com.apple.quarantine "/Applications/Cavil Loop.app"</code>', to: '<code>xattr -dr com.apple.quarantine "/Applications/Cavil-Loop.app"</code>',
    expect: ['build/dmg-background.html carries exactly that command'] },
  { what: '发版说明里的命令和定义不一致', file: 'RELEASE_NOTES.md',
    from: '     xattr -dr com.apple.quarantine "/Applications/Cavil Loop.app"', to: '     xattr -dr com.apple.quarantine /Applications/Cavil\\ Loop.app"',
    expect: ['RELEASE_NOTES.md carries exactly that command'] },
  { what: 'Mac 检查脚本找的命令和定义不一致', file: 'scripts/mac-open-check.sh',
    from: `grep -qF 'xattr -dr com.apple.quarantine "/Applications/Cavil Loop.app"' "$page"`, to: `grep -qF 'xattr -dr com.apple.quarantine "/Applications/CavilLoop.app"' "$page"`,
    expect: ['scripts/mac-open-check.sh carries exactly that command'] },
  { what: 'dmg 里列了一个不存在的文件', file: 'electron-builder.yml',
    from: 'path: build/复制放行命令.html', to: 'path: build/复制命令.html',
    expect: ['every listed file exists', 'lists the app, the Applications link and every extra file'] },
  { what: 'dmg 里的图标放到窗口看不见的下方', file: 'electron-builder.yml',
    from: '    - x: 240\n      y: 368', to: '    - x: 240\n      y: 440',
    expect: ['every icon sits inside the visible part of the window'] },
];

const list = process.env.CLIENT_MUT_LIST ? JSON.parse(readFileSync(process.env.CLIENT_MUT_LIST, 'utf8')) : MUTATIONS;
const VITEST = process.env.CLIENT_MUT_VITEST ?? join(root, 'node_modules', 'vitest', 'vitest.mjs');
const TIMEOUT_MS = Number(process.env.CLIENT_MUT_TIMEOUT_MS ?? 180_000);

function sandbox() {
  const work = mkdtempSync(join(tmpdir(), 'cavil-client-mut-'));
  for (const d of ['src', 'test', 'build']) cpSync(join(root, d), join(work, d), { recursive: true });
  for (const f of ['package.json', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts', 'electron-builder.yml', 'RELEASE_NOTES.md']) cpSync(join(root, f), join(work, f));
  cpSync(join(root, 'scripts'), join(work, 'scripts'), { recursive: true });
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

/** Build the copy and run the Playwright tests whose title matches `grep`; resolve like runVitest. */
function runE2e(work, grep) {
  const out = join(work, 'e2e-report.json');
  return new Promise((resolve) => {
    let child;
    try {
      const cmd = `node scripts/build.mjs >/dev/null && node node_modules/@playwright/test/cli.js test --reporter=json -g ${JSON.stringify(grep)}`;
      child = spawn('bash', ['-c', cmd], {
        cwd: work,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out },
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

const E2E_GREPS = () => [...new Set(list.filter((m) => m.runner === 'e2e').flatMap((m) => m.expect))];
const grepOf = (names) => names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

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
    const names = E2E_GREPS();
    if (names.length) {
      const e = await runE2e(work, grepOf(names));
      if (e.kind === 'broken') return fail(`界面基线没跑成：${e.why}`);
      const got = e2eResults(e.report);
      const missing = names.filter((n) => !got.some((t) => t.status === 'passed' && t.name.includes(n)));
      if (e.status !== 0 || missing.length) return fail(`界面基线不是全绿（退出码 ${e.status}，没通过：${missing.join('；') || '其他'}）`);
      console.log(`✅ 界面基线：未改动的副本 ${got.length} 条界面测试全过`);
    }
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
    const e2e = m.runner === 'e2e';
    const r = e2e ? await runE2e(work, grepOf(m.expect)) : await runVitest(work);
    if (r.kind === 'broken') return fail(`执行异常（${r.why}）：${m.what}`);
    if (r.status === 0) return fail(`没变红：${m.what}`);
    const all = e2e ? e2eResults(r.report) : results(r.report);
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
