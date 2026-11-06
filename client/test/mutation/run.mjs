#!/usr/bin/env node
// Negative controls for the client's unit tests (GitHub#103 convention).
// Entry point is test/mutation/run.sh, which goes through
// tests/lib/mutation.sh's `mutation_gate` once per entry. This file does the
// work for one step at a time:
//
//   node run.mjs --count        number of entries
//   node run.mjs --check        every entry's source text is still there (nothing is run)
//   node run.mjs --name I       one-line description of entry I
//   node run.mjs --baseline     unmodified copy: the suite must pass
//   node run.mjs --one I        entry I: the listed tests must fail by assertion
//
// Entries may break the Rust back end (src-tauri/…): every copy builds its own
// back end (cargo, shared target dir MUT_TARGET) and the suites drive that one.
//
// "Red" is only accepted when vitest itself ran and reported a failed result
// for every test named in `expect`. A runner that cannot start, a signal, a
// timeout, a missing report or "something else failed" all count as a failed
// negative control — never as "went red as expected".
//
// Entries with `runner: 'e2e'` break the code the same way but run the named
// Playwright tests against the real window (with the real back end behind the
// test bridge) instead (`expect` names test titles); the baseline then also runs
// those tests on an unmodified copy.
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
  { what: '缓存不覆盖旧快照', file: 'src-tauri/crates/core/src/store.rs',
    from: 'ON CONFLICT(source_key) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data',
    to: 'ON CONFLICT(source_key) DO NOTHING',
    expect: ['each successful round replaces the cached snapshot as a whole'] },
  { what: '凭据被撤销后不回登录页', file: 'src/app/controller.ts',
    from: 'if (session === this.session && this.signedIn) await this.logout(REASON_REVOKED);',
    to: '',
    expect: ['revoked credential → next sync returns to login'] },
  { what: '授权等待中被当成失败', file: 'src-tauri/crates/core/src/device.rs',
    from: 'Some("authorization_pending") => continue,',
    to: 'Some("authorization_pending_disabled") => continue,',
    expect: ['waiting → user approves'] },
  { what: '用户拒绝授权不区分出来', file: 'src-tauri/crates/core/src/device.rs',
    from: 'Some("access_denied") =>',
    to: 'Some("access_denied_disabled") =>',
    expect: ['user denies on GitHub'] },
  { what: '短码过期不区分出来', file: 'src-tauri/crates/core/src/device.rs',
    from: 'Some("expired_token") =>',
    to: 'Some("expired_token_disabled") =>',
    expect: ['code expires (GitHub says so)'] },
  { what: '分页链接指向别的主机也照跟', file: 'src/data/github.ts',
    from: 'if (new URL(url).origin !== origin) throw', to: 'if (false) throw',
    expect: ['refuses to follow a pagination link to another host'] },
  { what: '钥匙串「找不到」被当成错误', file: 'src-tauri/crates/core/src/platform.rs',
    from: '            // 44 = errSecItemNotFound\n            Some(44) => Ok(None),\n',
    to: '',
    expect: ['set → get → clear round-trips'] },
  // ---- review round 1 of PR #140 ----
  { what: '退出登录不清缓存',
    edits: [
      { file: 'src-tauri/crates/core/src/engine.rs', from: '("viewer", Value::Null)],\n                    true,', to: '("viewer", Value::Null)],\n                    false,' },
      { file: 'src/app/controller.ts', from: '    this.dropMirror();\n    this.cache.mirror(\'viewer\', null);', to: '    this.cache.mirror(\'viewer\', null);' },
    ],
    expect: ['sign out → another account signs in'] },
  { what: '缓存归属不记账（同账号离线重启也看不到缓存）', file: 'src-tauri/crates/core/src/engine.rs',
    from: '        if login.is_some() && login.map(str::to_string) == st.owner {\n            self.d.store.set_setting(CACHE_CREDENTIAL, &tag)?;\n            return Ok(false);\n        }',
    to: '        if true {\n            self.d.store.set_setting(CACHE_CREDENTIAL, &tag)?;\n            return Ok(false);\n        }',
    expect: ['offline restart: cached content still shows'] },
  { what: '凭据在 App 外被换掉、离线重启时照显示旧缓存', file: 'src-tauri/crates/core/src/engine.rs',
    from: 'if self.d.store.get_str(CACHE_CREDENTIAL).as_deref() != Some(tag.as_str()) {',
    to: 'if false {',
    expect: ['restart offline: the other account'] },
  { what: '旧账号的在途同步在换账号后照样写入（窗口和后台两道核对都去掉）',
    edits: [
      { file: 'src/app/controller.ts', from: '    if (session !== this.session) return over();\n    // GitHub says', to: '    // GitHub says' },
      { file: 'src/app/controller.ts', from: '      if (a.stale || session !== this.session) return over();', to: '      if (false) return over();' },
      { file: 'src/app/controller.ts', from: '    if (!(await this.writeSnapshots(session, accepted))) return over();', to: '    await this.writeSnapshots(session, accepted);' },
      { file: 'src-tauri/crates/core/src/engine.rs', from: '        if st.session != session || st.grant.is_none() {\n            return Ok(false);\n        }', to: '        if false {\n            return Ok(false);\n        }' },
      { file: 'src-tauri/crates/core/src/engine.rs', from: '        let mut st = self.lock();\n        if st.session != session {\n            return Ok(None);\n        }', to: '        let mut st = self.lock();\n        if false {\n            return Ok(None);\n        }' },
    ],
    expect: ['a round still in flight for the first account'] },
  { what: '同步途中删掉的来源被旧请求写回',
    edits: [
      { file: 'src/app/controller.ts', from: 'let accepted = round.replaced.filter((snap) => current(snap.sourceKey));', to: 'let accepted = round.replaced;' },
      { file: 'src/app/controller.ts', from: '    accepted = accepted.filter((snap) => current(snap.sourceKey));\n', to: '' },
    ],
    expect: ['removed → the finished old request'] },
  { what: '删掉又重加的来源收下删除前发出的旧请求', file: 'src/app/controller.ts',
    from: ' && (this.epochs.get(key) ?? 0) === epochAtStart.get(key);',
    to: ';',
    expect: ['removed and added again'] },
  // ---- review round 2 of PR #140 ----
  { what: '凭据写完不再核对登录是否已取消 / 已退出', file: 'src-tauri/crates/core/src/engine.rs',
    from: '                if run != st.login_run {\n                    Ok(FinishOut::Stale { login_reason: None })',
    to: '                if false {\n                    Ok(FinishOut::Stale { login_reason: None })',
    expect: ['cancel while saving → nothing kept', 'sign out while saving → same'] },
  { what: '凭据写入 / 删除不排队', file: 'src-tauri/crates/core/src/engine.rs',
    from: '        let job: Shared<BoxFuture<\'static, T>> = async move {\n            prev.await;\n',
    to: '        let job: Shared<BoxFuture<\'static, T>> = async move {\n            let _ = prev;\n',
    expect: ['an older login finishing its save after a newer login'] },
  // ---- GitHub App sign-in (maintainer's choice on PR #140) ----
  { what: '快到期也不提前续期', file: 'src-tauri/crates/core/src/engine.rs',
    from: 'if !force && used.expires_at.map(|e| e - now > REFRESH_MARGIN_MS).unwrap_or(true) {',
    to: 'if !force {',
    expect: ['near expiry: refreshed before the round'] },
  { what: '续期不合并：同时触发会续两次',
    edits: [
      { file: 'src-tauri/crates/core/src/engine.rs', from: '        if let Some((_, f)) = existing {\n            return f.await;\n        }\n', to: '' },
      { file: 'src-tauri/crates/core/src/engine.rs', from: '            match st.refreshing.clone() {', to: '            match None::<(u64, SharedFresh)> {' },
    ],
    expect: ['two rounds asking at once share one refresh'] },
  { what: 'GitHub 回 401 时不续期重试', file: 'src/app/controller.ts',
    from: 'if (r === \'ok\') return this.runRound(true);',
    to: 'if (r === \'ok\') return;',
    expect: ['GitHub says 401 before the deadline'] },
  { what: '续期被拒当成连不上（不退出登录）', file: 'src-tauri/crates/core/src/engine.rs',
    from: 'Failure::Expired => self.sign_out_from_refresh(current(&self)),',
    to: 'Failure::Expired => FreshOut::of(Fresh::Unreachable),',
    expect: ['GitHub refuses the refresh token'] },
  { what: '连不上 GitHub 也当成续期被拒（误退出登录）', file: 'src-tauri/crates/core/src/engine.rs',
    from: 'Failure::Unreachable => FreshOut::of(Fresh::Unreachable),',
    to: 'Failure::Unreachable => self.sign_out_from_refresh(current(&self)),',
    expect: ['GitHub unreachable at refresh time'] },
  { what: '续期后不更新缓存绑定（离线重启丢缓存）', file: 'src-tauri/crates/core/src/engine.rs',
    from: '            if st.owner.is_some() && saved {\n                if let Err(e) = me.d.store.set_setting(CACHE_CREDENTIAL, &Value::String(credential_tag(&next.access_token))) {\n                    db_problem.get_or_insert(e);\n                }\n            }\n',
    to: '',
    expect: ['refreshed, then the round could not reach GitHub'] },
  { what: '续期写完不再核对是否已退出', file: 'src-tauri/crates/core/src/engine.rs',
    from: '            let mut st = me.lock();\n            if !still(&st) {\n                return FreshOut::of(Fresh::Ended);\n            }\n            st.grant = Some(next.clone());',
    to: '            let mut st = me.lock();\n            st.grant = Some(next.clone());',
    expect: ['signing out while the refreshed token is being saved'] },
  // ---- review of 2026-11-05 17:48: refresh failure paths ----
  { what: '续期接口 5xx 带错误正文时不先按「暂时不可用」处理', file: 'src-tauri/crates/core/src/device.rs',
    from: 'if res.status >= 500 || res.status == 429 {',
    to: 'if false {',
    expect: ['HTTP 503 with an error body', 'HTTP 503 {"error":"temporarily_unavailable"} → unreachable'] },
  { what: '续期的任何错误都当成凭据失效', file: 'src-tauri/crates/core/src/device.rs',
    from: 'if body.get("error").and_then(|v| v.as_str()) == Some(REFRESH_TOKEN_REJECTED) {',
    to: 'if truthy(body.get("error")) {',
    expect: ['an unknown refresh error', 'HTTP 400 {"error":"temporarily_unavailable"} → error'] },
  { what: '续期后写钥匙串失败就整次作废（继续用已被 GitHub 作废的旧续期令牌）', file: 'src-tauri/crates/core/src/engine.rs',
    from: '                Err(e) => {\n                    me.lock().unsaved_problem = Some(e);\n                    false\n                }',
    to: '                Err(e) => return FreshOut { result: Fresh::Failed, problem: Some(Some(e)), signed_out: None },',
    expect: ['refreshed but the keychain refuses the write'] },
  { what: '没存进钥匙串的凭据之后不再重试保存', file: 'src/app/controller.ts',
    from: '    await this.saveUnsaved();\n',
    to: '',
    expect: ['refreshed but the keychain refuses the write'] },
  { what: '登录轮询遇到 503 直接判登录失败', file: 'src-tauri/crates/core/src/device.rs',
    from: '            Err(e) if e.reason == Failure::Unreachable => continue,\n',
    to: '',
    expect: ['a device-flow poll that gets a 503'] },
  // ---- review round 2 (18:10): sign-out when the keychain refuses the delete ----
  { what: '退出时删凭据失败就把错误抛出去（页面停在看板）', file: 'src-tauri/crates/core/src/api.rs',
    from: '            let (session, message) = e.logout(a.get("reason").and_then(|v| v.as_str()));\n            Ok(json!({ "session": session, "message": message }))',
    to: '            let (session, message) = e.logout(a.get("reason").and_then(|v| v.as_str()));\n            if let (Some(m), _) = e.logout_result(session).await {\n                return Err(m);\n            }\n            Ok(json!({ "session": session, "message": message }))',
    expect: ['manual sign-out + delete refused'] },
  // ---- review (2026-11-05 19:49): quit while the sign-out's keychain delete is outstanding ----
  { what: '退出登录不先撤销「可信」就去删钥匙串（删除没返回就关 App，重启自动登录旧账号）', file: 'src-tauri/crates/core/src/engine.rs',
    from: '                &[(TRUSTED, Value::Array(vec![])), (CACHE_OWNER, Value::Null)',
    to: '                &[(CACHE_OWNER, Value::Null)',
    expect: ['sign-out, delete-pending, quit', 'sign-out, delete-queued, quit'] },
  { what: '启动时不看可信名单，钥匙串里有什么就用什么', file: 'src-tauri/crates/core/src/engine.rs',
    from: 'if marked || !self.trusted().contains(&tag) {',
    to: 'if false {',
    expect: ['sign-out, delete-pending, quit', 'sign-out, delete-fails, quit', 'credential replaced outside the app: not trusted'] },
  { what: '续期写钥匙串时不同时信任新旧两份（写一半关 App，重启被迫重新登录）', file: 'src-tauri/crates/core/src/engine.rs',
    from: '                me.set_trusted(&[&used.access_token, &next.access_token]).err()\n            };',
    to: '                None::<String>\n            };',
    expect: ['a refresh quits while writing the new token'] },
  // ---- review (2026-11-05 20:12): upgrade from a preview build ----
  { what: '没有可信名单的旧数据就信任钥匙串里那份（旧版已退出的账号被登录回去）', file: 'src-tauri/crates/core/src/engine.rs',
    from: 'if marked || !self.trusted().contains(&tag) {',
    to: 'if marked || (self.d.store.get_setting(TRUSTED).is_some() && !self.trusted().contains(&tag)) {',
    expect: ['old build signed out but could not delete the credential', 'old build simply signed in'] },
  // sign-in method (GitHub#140: OAuth app by default, GitHub App when chosen)
  { what: '保存 Client ID 时不管选的是哪种，一律写进 OAuth 应用那一格', file: 'src/app/controller.ts',
    from: 'this.cache.setSetting(CLIENT_ID_SETTING[this.state.appKind], v);',
    to: 'this.cache.setSetting(CLIENT_ID_SETTING.oauth, v);',
    expect: ["the chosen kind's Client ID is the one sent to GitHub"] },
  { what: '选 GitHub App 但没填 ID 时，偷偷改用内置的 OAuth 应用', file: 'src/app/controller.ts',
    from: "'github-app': deps.defaultGithubAppClientId ?? DEFAULT_GITHUB_APP_CLIENT_ID,",
    to: "'github-app': deps.defaultGithubAppClientId || (deps.defaultClientId ?? DEFAULT_OAUTH_CLIENT_ID),",
    expect: ['GitHub App has no built-in ID, so signing in says what to fill in and calls nothing'] },
  { what: '切回 OAuth 应用后仍用 GitHub App 的 ID 登录', file: 'src/app/controller.ts',
    from: "    this.set({ appKind: k, ...this.clientIdFor(k) });", to: "    this.set({ appKind: k });",
    expect: ["switching back to the OAuth app sends the OAuth app's ID"] },
  { what: '预览版存在唯一那格里的 GitHub App ID 被当成 OAuth 应用', file: 'src/app/controller.ts',
    from: "const kind: AppKind = /^Iv/.test(old) ? 'github-app' : 'oauth';", to: "const kind: AppKind = 'oauth';",
    expect: ['a preview build that saved a GitHub App ID in the single box'] },
  { what: '续期用当前设置的 Client ID，而不是登录时那个应用的', file: 'src-tauri/crates/core/src/engine.rs',
    from: 'let client_id = self.d.store.get_str(GRANT_CLIENT_ID).filter(|s| !s.is_empty()).unwrap_or(fallback);',
    to: 'let client_id = fallback;',
    expect: ['changing the sign-in method while signed in: the token is still refreshed with the app it came from'] },
  // review round 1: what is said must match what is sent (GitHub#140)
  { what: '登录前不核对 Client ID 和所选方式是否对得上', file: 'src/app/controller.ts',
    from: '        clientIdKindProblem(this.state.appKind, clientId);',
    to: '        null;',
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
  { what: '导入覆盖用户在首次读取前改过的设置', file: 'src/app/controller.ts',
    from: "if (!p.touched.includes(k)) (next as any)[k] = patch[k];", to: '(next as any)[k] = patch[k];',
    expect: ['a change made before the Project was first read wins over the import; a failed read imports later'] },
  { what: '导入不只一次：之后每轮同步都重新导入，冲掉用户的修改', file: 'src/app/controller.ts',
    from: '    this.cache.setSetting(PENDING_IMPORTS, pending);\n    if (view !== this.state.view) {', to: '    if (view !== this.state.view) {',
    expect: ['the import happens once: a later change of the saved view on GitHub does not override the client'] },
  { what: '删掉再加 Project 不重新导入', file: 'src/app/controller.ts',
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
  { what: '离线时照样发修改', file: 'src/app/controller.ts',
    from: 'if (write && !writesEnabled(this.state.sync))', to: 'if (false)',
    expect: ['offline round → every change refused before sending'] },
  { what: '修改成功后不立即重读', file: 'src/app/controller.ts',
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
  { what: '后台代发请求不核对地址（窗口能让它把凭据发去别处）', file: 'src-tauri/crates/core/src/engine.rs',
    from: '        if !http::under(&self.d.endpoints.api, &req.url) {',
    to: '        if false {',
    expect: ['refused before anything is sent'] },
  // ---- the back end holds the credential (GitHub#151) ----
  { what: '后台把凭据交给窗口（登录状态里带上访问令牌）', file: 'src-tauri/crates/core/src/engine.rs',
    from: '                "canRefresh": g.refresh_token.is_some(),',
    to: '                "canRefresh": g.refresh_token.is_some(),\n                "token": g.access_token,',
    expect: ['no command and no answer carries a token'] },
  { what: '窗口带来的 Authorization 头盖过后台的凭据', file: 'src-tauri/crates/core/src/engine.rs',
    from: '                k != "authorization" && k != "cookie" && k != "host"',
    to: '                k != "cookie" && k != "host"',
    expect: ['a header the window sets cannot replace the credential'] },
  { what: '窗口能写描述凭据的设置', file: 'src-tauri/crates/core/src/api.rs',
    from: '            if SECRET_KEYS.contains(&k) {',
    to: '            if false {',
    expect: ['the settings that describe the credential cannot be written from the window'] },
  { what: '地址核对按前缀比（/apix 也算 GitHub 接口）', file: 'src-tauri/crates/core/src/http.rs',
    from: '    bp.is_empty() || up == bp || up.starts_with(&format!("{bp}/"))',
    to: '    up.starts_with(bp)',
    expect: ['refused before anything is sent'] },
  { what: '窗口里又用 macOS 11（Safari 14）没有的接口（请求全失败）', file: 'src/data/github.ts', runner: 'e2e',
    from: 'signal: init.signal ?? timeoutSignal(30_000),', to: 'signal: init.signal ?? AbortSignal.timeout(30_000),',
    expect: ['on an engine without the newer web APIs'] },
  { what: '新登录不等先前的取消送达后台（晚到的取消把新登录也取消了）', file: 'src/app/controller.ts',
    from: '      await this.loginCancels;\n', to: '',
    expect: ['a cancel that reaches the back end late does not end the sign-in started after it'] },
  // ---- PR #161 review round 2: a cancel / sign-out landing while a sign-in commits ----
  { what: '登录提交写数据库时放开状态锁（取消 / 退出能插进检查与提交之间）',
    edits: [
      { file: 'src-tauri/crates/core/src/engine.rs', from: '                    match me.d.store.write_all(\n', to: '                    drop(st);\n                    let written = me.d.store.write_all(\n' },
      { file: 'src-tauri/crates/core/src/engine.rs', from: '                        !same_owner,\n                    ) {\n', to: '                        !same_owner,\n                    );\n                    st = me.lock();\n                    match written {\n' },
    ],
    expect: ['cancel sent while the commit waits for the database', 'sign-out sent while the commit waits for the database'] },
  { what: '取消一个已经提交的登录尝试时不退出（「已登录」还在路上时用户点了取消）', file: 'src-tauri/crates/core/src/engine.rs',
    from: '        committed.then(|| self.logout(Some("登录已取消")))', to: '        let _ = committed;\n        None',
    expect: ['a cancel naming an attempt that already committed signs it out'] },
  // ---- PR #161 review round 1: a database that refuses a write ----
  { what: '退出时数据库写失败也当成退出成功（不写备用标记、不告诉用户）', file: 'src-tauri/crates/core/src/engine.rs',
    from: 'let durable = match write().or_else(|_| write()) {', to: 'let durable = match write().or_else(|_| Ok::<(), String>(())) {',
    expect: ['the sign-out is not reported as clean'] },
  { what: '启动时不看退出标记', file: 'src-tauri/crates/core/src/engine.rs',
    from: 'let marked = self.d.store.signed_out_marked();', to: 'let marked = false;',
    expect: ['the sign-out is not reported as clean'] },
  { what: '退出标记写不成也不说「下次可能自动登录回去」', file: 'src-tauri/crates/core/src/engine.rs',
    from: '                    Some(e) if undurable => Some(format!(', to: '                    Some(e) if false && undurable => Some(format!(',
    expect: ['neither the database nor the marker can be written'] },
  { what: '窗口不显示退出时后台给的说明', file: 'src/app/controller.ts',
    from: 'await this.applySignedOut(session, message ?? reason);', to: 'await this.applySignedOut(session, reason);',
    expect: ['the explanation is on screen at once, while the keychain delete is still pending'] },
  { what: '换账号时清不掉旧缓存也照常登录', file: 'src-tauri/crates/core/src/engine.rs',
    from: '                Err(e) => {\n                    return StartOut::Login {\n                        reason: Some(format!("本地缓存没能清空（{e}），为免显示别的账号的数据，这次没有自动登录；可以重新登录")),\n                        wiped: true,\n                    }\n                }',
    to: '                Err(_) => {}',
    expect: ["a credential the cache was not read with, and the wipe refused"] },
  { what: '没人认领的缓存清不掉时照样交给窗口', file: 'src-tauri/crates/core/src/engine.rs',
    from: '        if self.lock().owner.is_none() {\n            return vec![];\n        }\n', to: '',
    expect: ['is never handed to the window'] },
  { what: '续期后数据库写失败不告诉用户', file: 'src-tauri/crates/core/src/engine.rs',
    from: '            } else {\n                db_problem.map(db_problem_message)\n            };', to: '            } else {\n                db_problem.map(|_| String::new()).filter(|_| false)\n            };',
    expect: ['still signed in on the new token, and the user is told'] },
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
  // ---- pending/human reminders (GitHub#139, rebuilt on Tauri in #169) ----
  { what: '只算开着的条目（已关闭 / 已合并不算待处理）', file: 'src/data/pending.ts',
    from: 'for (const it of snap.items) if (hasLabel(it, this.label)) out.set(it.key, it);',
    to: "for (const it of snap.items) if (hasLabel(it, this.label) && it.state === 'open') out.set(it.key, it);",
    expect: ['start: what is already pending becomes one summary', 'notified exactly once — open issue, closed issue and merged PR alike', 'a closed item counts the same as an open one'] },
  { what: '读失败的来源当成空（报「移除」，恢复后又报「新增」）', file: 'src/app/controller.ts',
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
  { what: '退出登录不清角标', file: 'src/app/controller.ts',
    from: '    this.pending.reset();\n', to: '',
    expect: ['sign out clears the badge and the count'] },
  { what: '系统拒绝通知时不告诉用户', file: 'src/app/controller.ts',
    from: '      (r) => this.reportNotification(r),', to: '      (r) => void r,',
    expect: ['is shown in the app (not silently lost)'] },
  { what: '「通知被拒」黄条的标识里带上时间：同一个原因也当成新问题', file: 'src/renderer/warnings.ts',
    from: "return notifyProblem ? { 'board-notify-problem': notifyProblem } : {};",
    to: "return notifyProblem ? { 'board-notify-problem': `${notifyProblem}@${Date.now()}${Math.random()}` } : {};",
    expect: ['× closes it for this reason only', "its id is the system's reason"] },
  { what: '删除来源后角标不变', file: 'src/app/controller.ts',
    from: '    this.pending.prune(sources.map((s) => s.key));\n', to: '',
    expect: ['removing a source drops what only it carried'] },
  { what: '改「等人处理的标签」后提醒仍按旧标签计数（两处设置各管各）', file: 'src/app/controller.ts',
    from: '      this.pending.relabel(next.human, this.snapshots);\n', to: '',
    expect: ['another label name: recounted silently'] },
  { what: '外壳的同步节拍不触发同步', file: 'src/app/controller.ts',
    from: "    if (ev.kind === 'tick') {\n      void this.syncNow();\n      return;", to: "    if (ev.kind === 'tick') {\n      return;",
    expect: ['a sync beat from the shell runs a round'] },
  { what: '点通知不打开那一条', file: 'src/app/controller.ts',
    from: '      this.set({ focus: { key: ev.key, seq: ++this.focusSeq } });', to: '      void ev;',
    expect: ['a clicked item notification opens that item in the app'] },
  { what: '通知调用本身出错时不告诉用户', file: 'src/app/controller.ts',
    from: "      (e) => this.reportNotification({ ok: false, error: (e as Error).message ?? String(e) }),", to: '      () => {},',
    expect: ['a notification call that itself fails is shown like a refusal'] },
  { what: '界面：点通知后从设置页回到看板时，又把上一次点过的那条打开', file: 'src/renderer/App.tsx',
    from: '          onFocusTaken={() => setFocusReq(null)}', to: '          onFocusTaken={() => {}}',
    runner: 'e2e', expect: ['pending/human: start-up summary, one notification per new label at the next beat, badge, label setting, a click opens the item'] },
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
  { what: 'dmg 里列了一个不存在的文件', file: 'scripts/release-command.mjs',
    from: "export const DMG_EXTRA_FILES = ['build/复制放行命令.html',", to: "export const DMG_EXTRA_FILES = ['build/复制命令.html',",
    expect: ['every listed file exists', 'lists the app, the Applications link and every extra file'] },
  { what: 'dmg 里的图标放到窗口看不见的下方', file: 'scripts/dmg-layout.mjs',
    from: "{ path: 'build/复制放行命令.html', x: 240, y: 368 }", to: "{ path: 'build/复制放行命令.html', x: 240, y: 440 }",
    expect: ['every icon sits inside the visible part of the window'] },
  // ---- GitHub#155: PRs under their issue (board and table, each call site), folded detail, avatars, floating detail, zoom ----
  { what: '看板不把 PR 挪到关联 issue 下面', file: 'src/data/board.ts',
    from: '  if (!nest.on) return sorted;', to: '  return sorted;',
    expect: ['"updated" sort: the pair moves as one', 'any other sort: the pair sits where the issue sits'] },
  { what: '表格（不缩进子 issue 时）不把 PR 挪到关联 issue 下面', file: 'src/data/table.ts',
    from: '    if (!prs) return sorted.map(', to: '    return sorted.map(',
    expect: ['"updated" sort: the pair moves as one', 'any other sort: the pair sits where the issue sits'] },
  { what: '表格缩进子 issue 时不把 PR 挪到关联 issue 下面', file: 'src/data/table.ts',
    from: '  const hosts = prs ? prHosts(sorted) : new Map<string, string>();', to: '  const hosts = new Map<string, string>();',
    expect: ['table with sub-issues indented'] },
  { what: '按更新时间排时，一对只按 issue 自己的时间排（不看 PR 更新）', file: 'src/data/prNest.ts',
    from: '  return under.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), item.updatedAt);', to: '  return item.updatedAt;',
    expect: ['"updated" sort: the pair moves as one', 'table with sub-issues indented'] },
  { what: '按编号等其他方式排时，一对也按两者较晚的更新时间挪位置', file: 'src/data/prNest.ts',
    from: "  if (sort?.field !== 'updated') return units;", to: '  if (!sort) return units;',
    expect: ['any other sort: the pair sits where the issue sits'] },
  { what: '一个 PR 关联同列两个 issue 时跟到后一个下面', file: 'src/data/prNest.ts',
    from: '      if (l.key === it.key || !here.has(l.key) || hosts.has(l.key)) continue;', to: '      if (l.key === it.key || !here.has(l.key)) continue;',
    expect: ['goes under the first of them only'] },
  { what: '一个 issue 下的几个 PR 不按更新时间从新到旧', file: 'src/data/prNest.ts',
    from: 'export const PR_ORDER = (a: Item, b: Item) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);', to: 'export const PR_ORDER = (a: Item, b: Item) => 0;',
    expect: ['several PRs under one issue: newest first'] },
  { what: '分泳道时，别的仓库的 PR 不跟着 issue 进它的泳道', file: 'src/data/board.ts',
    from: '    under ? { ...entry, under, lane: lanes.get(under) ?? entry.lane } : entry,', to: '    under ? { ...entry, under } : entry,',
    expect: ["swimlanes: a PR from another repository follows its issue"] },
  { what: '存下的详情宽度不检查范围', file: 'src/shared/viewSettings.ts',
    from: "  return typeof v === 'number' && Number.isFinite(v) && v >= DETAIL_MIN_WIDTH && v <= DETAIL_MAX_WIDTH;", to: "  return typeof v === 'number';",
    expect: ['older saved settings get the new ones by default'] },
  { what: '详情默认全部展开（不只展开最新一条）', file: 'src/renderer/detailHtml.ts',
    from: "  return unfold === 'all' || (unfold === 'latest' && i === 0);", to: "  return unfold !== 'none';",
    expect: ['by default only the newest entry is unfolded'] },
  { what: '折叠行的摘要不再转义', file: 'src/renderer/detailHtml.ts',
    from: '<span class="excerpt"> · ${escapeHtml(excerpt)}</span>', to: '<span class="excerpt"> · ${excerpt}</span>',
    expect: ['the preview is plain text, escaped again'] },
  { what: '图片放开成 GitHub 的全部图片域名（含图片代理、附件）', file: 'src/renderer/detailHtml.ts',
    from: "export const IMAGE_HOSTS = ['https://github.com', 'https://api.github.com', AVATAR_HOST];", to: "export const IMAGE_HOSTS = ['https://github.com', 'https://api.github.com', 'https://*.githubusercontent.com'];",
    expect: ['images: only github.com / api.github.com (and the avatar host) load'] },
  { what: '放大停在原档（一档也升不上去）', file: 'src-tauri/crates/core/src/zoom.rs',
    from: '        Step::In => LEVELS.iter().copied().find(|&l| l > current)', to: '        Step::In => LEVELS.iter().copied().find(|&l| l >= current)',
    expect: ['steps through the levels, stops at both ends'] },
  { what: '缩放档位不存下来（重开回到 100%）', file: 'src-tauri/crates/core/src/zoom.rs',
    from: '    let kept = store.set_setting(SETTING, &json!(level));', to: '    let kept: Result<(), String> = Ok(());',
    expect: ['the level is kept: a restart on the same files comes back at it'] },
  { what: '存下的缩放值不是档位之一也照用', file: 'src-tauri/crates/core/src/zoom.rs',
    from: '        .filter(|v| LEVELS.contains(v))\n', to: '',
    expect: ['a kept value that is not one of the levels reads as 100%'] },
  { what: '详情不再浮在看板上（又和看板并排挤窄看板）', file: 'src/renderer/styles.css', runner: 'e2e',
    from: '.detail { position: absolute; top: 0; right: 0; bottom: 0; z-index: 5; display: flex;', to: '.detail { flex: none; display: flex;',
    expect: ['GitHub#155: avatars; the detail floats over the board'] },
  { what: '拖出来的详情宽度不保存', file: 'src/renderer/panelWidth.ts', runner: 'e2e',
    from: 'void Promise.resolve(api().setView({ detailWidth: last }))', to: 'void Promise.resolve()',
    expect: ['GitHub#155: avatars; the detail floats over the board'] },
  { what: '页面的图片策略没有头像地址（头像全加载不出）', file: 'src-tauri/tauri.conf.json', runner: 'e2e',
    from: ' https://api.github.com https://avatars.githubusercontent.com",', to: ' https://api.github.com",',
    expect: ['GitHub#155: avatars; the detail floats over the board'] },
  { what: '头像加载失败时不换成首字母', file: 'src/renderer/Avatar.tsx', runner: 'e2e',
    from: '      onError={() => setFailed(true)}', to: '      onError={() => {}}',
    expect: ['GitHub#155: avatars; the detail floats over the board'] },
  { what: '在回复框里按 Esc 也关掉详情（草稿丢了）', file: 'src/renderer/DetailPanel.tsx', runner: 'e2e',
    from: "      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;\n", to: '',
    expect: ['GitHub#155: avatars; the detail floats over the board'] },

];

const list = process.env.CLIENT_MUT_LIST ? JSON.parse(readFileSync(process.env.CLIENT_MUT_LIST, 'utf8')) : MUTATIONS;
const VITEST = process.env.CLIENT_MUT_VITEST ?? join(root, 'node_modules', 'vitest', 'vitest.mjs');
// a copy builds the Rust back end, then runs the whole suite (≈ 320 tests): give it room
const TIMEOUT_MS = Number(process.env.CLIENT_MUT_TIMEOUT_MS ?? 600_000);

function sandbox() {
  const work = mkdtempSync(join(tmpdir(), 'cavil-client-mut-'));
  for (const d of ['src', 'test', 'build']) cpSync(join(root, d), join(work, d), { recursive: true });
  // the Rust back end's sources (not its build output: a mutated copy is built into MUT_TARGET)
  cpSync(join(root, 'src-tauri'), join(work, 'src-tauri'), { recursive: true, filter: (s) => !/[\\/]src-tauri[\\/](target|gen)([\\/]|$)/.test(s) });
  for (const f of ['package.json', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts', 'RELEASE_NOTES.md']) cpSync(join(root, f), join(work, f));
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

/** Run vitest in `work`; resolve to { kind: 'report', status, report } or { kind: 'broken', why }. */
async function runVitest(work) {
  // a runner that is not there fails at once, before minutes of building the back end
  if (!existsSync(VITEST)) return { kind: 'broken', why: `启动失败：找不到测试执行器 ${VITEST}` };
  const be = await buildBackend(work);
  if (be.broken) return { kind: 'broken', why: be.broken };
  return runVitestWith(work, be.bin);
}

function runVitestWith(work, harness) {
  const out = join(work, 'vitest-report.json');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [VITEST, 'run', '--reporter=json', `--outputFile=${out}`], {
        cwd: work,
        env: { ...process.env, CLIENT_MUT_CHILD: '1', CLIENT_MUT_REPO: root, CAVIL_HARNESS: harness },
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
async function runE2e(work, grep) {
  const be = await buildBackend(work);
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

const [cmd, arg] = process.argv.slice(2);
if (cmd === '--count') console.log(list.length);
else if (cmd === '--check') process.exitCode = check();
else if (cmd === '--name') console.log(list[Number(arg)]?.what ?? '');
else if (cmd === '--baseline') process.exitCode = await baseline();
else if (cmd === '--one') process.exitCode = await one(Number(arg));
else {
  console.error('用法：由 test/mutation/run.sh 调用（--count | --name I | --baseline | --one I）');
  process.exitCode = 2;
}
