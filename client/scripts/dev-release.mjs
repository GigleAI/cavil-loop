#!/usr/bin/env node
// Publish one development build of the client (GitHub#215) and keep only the latest few.
// Run by .github/workflows/client.yml on a push to main, after the tests and the Mac build passed.
//
// A development build is a GitHub pre-release tagged `client/vX.Y.Z-dev.N` (scripts/dev-version.mjs),
// never marked Latest. Installed apps on the development channel take it
// (src-tauri/crates/core/src/update.rs); apps on the release channel never see it.
//
// Publishing, from a fresh read of the release list (any read that fails stops everything):
//   - a published development build with a higher version exists: publish nothing (an older run
//     that finished late never puts an older build on top)
//   - this version is already published with every file: nothing to publish (a rerun)
//   - otherwise it is created as a draft with every file, then published: an installed app never
//     sees a release with a missing file (drafts are invisible to it). A draft or a published
//     release of this version left half-done by an earlier run is filled in and published.
//   - read again: it must now be published, a pre-release, with every file — or this run fails.
// Then the old ones go: of the published development builds (exact tag shape AND marked
// pre-release), all but the `--keep` highest versions are deleted with their tags; and drafts of a
// lower development version than this run's (left by an earlier run a newer push cancelled).
// Every deletion is judged again, from a fresh read, right before it is made (see the clean-up below).
// Releases, the daemon's weekly releases, drafts of anything else and anything not in that exact
// shape are never touched. A
// deletion that fails is reported (a warning on the run) and retried by the next push.
//
//   node scripts/dev-release.mjs --version 0.5.1-dev.387 --sha <commit> --dir dist-release \
//        --notes-file notes.md [--keep 10] [--repo GigleAI/cavil-loop]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION_SHAPE } from './update-manifest.mjs';

export const TAG_PREFIX = 'client/v';

/** `X.Y.Z-dev.N` (the manifest builder's shape, one rule for both scripts) → [X, Y, Z, N]; anything else → null. */
export function parseDev(v) {
  const m = VERSION_SHAPE.dev.exec(String(v ?? ''));
  return m ? m.slice(1).map(Number) : null;
}

/** <0, 0, >0 like a comparator, for two parsed development versions. */
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];

/** The published development builds in a release list: [{ tag, version, parsed }], highest first. */
export function devReleases(list) {
  const out = [];
  for (const r of list) {
    if (r?.draft !== false || r?.prerelease !== true || typeof r?.tag_name !== 'string' || !r.tag_name.startsWith(TAG_PREFIX)) continue;
    const version = r.tag_name.slice(TAG_PREFIX.length);
    const parsed = parseDev(version);
    if (parsed) out.push({ tag: r.tag_name, version, parsed });
  }
  return out.sort((a, b) => cmp(b.parsed, a.parsed));
}

/**
 * What to do for `version`, given the release list and the files it must carry.
 * → { action: 'skip', why } | { action: 'done' } | { action: 'create' } | { action: 'fill', draft }
 */
export function decide(list, version, files) {
  const mine = parseDev(version);
  if (!mine) throw new Error(`版本号不是 X.Y.Z-dev.N：${version}`);
  const higher = devReleases(list).find((r) => cmp(r.parsed, mine) > 0);
  if (higher) return { action: 'skip', why: `已经有更新的开发版 ${higher.version}` };
  const tag = `${TAG_PREFIX}${version}`;
  const same = list.filter((r) => r?.tag_name === tag);
  if (same.length > 1) throw new Error(`${tag} 有 ${same.length} 个发版，不知道该用哪个`);
  if (!same.length) return { action: 'create' };
  const r = same[0];
  const names = new Set((r.assets ?? []).map((a) => a?.name));
  if (r.draft === false && r.prerelease === true && files.every((f) => names.has(f))) return { action: 'done' };
  if (r.draft === false && r.prerelease !== true) throw new Error(`${tag} 已经发布、但不是预发布：不碰它，请人看一下`);
  return { action: 'fill', draft: r.draft !== false };
}

/** The development builds to delete: all published ones but the `keep` highest. */
export function toPrune(list, keep) {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error(`--keep 要是正整数：${keep}`);
  return devReleases(list).slice(keep);
}

/**
 * Drafts the clean-up deletes: development-shaped drafts of a version lower than both this run's
 * `version` and the highest published development build. Two kinds end up here — a run a newer push
 * cancelled mid-publish, and an old build this clean-up (or an earlier one) already turned into a
 * draft as its first step. Never one of a higher version — a newer run may be publishing it now.
 */
export function staleDrafts(list, version) {
  let bar = parseDev(version);
  const top = devReleases(list)[0];
  if (top && cmp(top.parsed, bar) > 0) bar = top.parsed;
  return list
    .filter((r) => r?.draft === true && typeof r?.tag_name === 'string' && r.tag_name.startsWith(TAG_PREFIX))
    .map((r) => ({ tag: r.tag_name, parsed: parseDev(r.tag_name.slice(TAG_PREFIX.length)) }))
    .filter((r) => r.parsed && cmp(r.parsed, bar) < 0);
}

/**
 * What the clean-up deletes, from one read of the release list: `old` = published development
 * builds outside the `keep` highest, `draft` = drafts of a lower development version than `version`.
 * Each carries the release's id (it cannot change, unlike a tag name) and the tag.
 * The same function judges the selection and, from a fresh read right before each deletion, whether
 * that one release still qualifies (`stillToDelete`) — one rule, judged twice.
 */
export function pruneCandidates(list, keep, version) {
  const byTag = new Map(list.map((r) => [r?.tag_name, r]));
  const old = toPrune(list, keep).map((r) => ({ kind: 'old', id: byTag.get(r.tag)?.id, tag: r.tag }));
  const drafts = staleDrafts(list, version).map((r) => ({ kind: 'draft', id: list.find((x) => x?.draft === true && x?.tag_name === r.tag)?.id, tag: r.tag }));
  return [...old, ...drafts];
}

/**
 * From a fresh list: is `c` (one of `pruneCandidates`) still to be deleted? Same id, same tag, same
 * kind, still selected by the same rule — and the tag names exactly one release. Anything missing
 * or changed → { ok: false, why }.
 */
export function stillToDelete(list, c, keep, version, kind = c?.kind) {
  if (!Number.isSafeInteger(c?.id)) return { ok: false, why: '读不到它的发版编号' };
  const same = list.filter((r) => r?.id === c.id);
  if (same.length !== 1) return { ok: false, why: '这个发版已经不在了' };
  if (list.filter((r) => r?.tag_name === c.tag).length !== 1) return { ok: false, why: `标签 ${c.tag} 对应的发版不止一个` };
  const now = pruneCandidates(list, keep, version).find((x) => x.id === c.id);
  if (!now || now.tag !== c.tag || now.kind !== kind) return { ok: false, why: '它已经不符合清理条件（被改过）' };
  return { ok: true, release: same[0] };
}

// ---- what this build changed, on its release page (GitHub#348) ----------------------------
//
// Installed apps list what every version between theirs and the new one changed, read out of the
// release pages (src-tauri/crates/core/src/update.rs `notes`). So each development build's page
// carries, under `NOTES_HEADING`, the lines its commits added to RELEASE_NOTES.md since the
// previous published development build — and, after them, the title of every commit in that range
// that changed the app but added no line (GitHub#427): a commit whose own build was never published
// (packaging failed, a newer push cancelled it) has no page of its own, so this is the only place it
// can show up. Nothing to list, or the previous build's commit cannot be told or any history read
// fails → no section (the app then shows the commit title in the page's first line).

/** The heading the app looks for (update.rs `NOTES_HEADING`; test/unit/update-notes.test.ts holds both to one fixture). */
export const NOTES_HEADING = '### 更新内容';

/** The client directory (where RELEASE_NOTES.md is). */
const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The commit of the published development build right below `version`, when the release recorded
 * a full commit id; null when there is none (or it recorded a branch name).
 */
export function previousBuildCommit(list, version) {
  const mine = parseDev(version);
  if (!mine) return null;
  const prev = devReleases(list).find((r) => cmp(r.parsed, mine) < 0);
  const sha = prev && list.find((r) => r?.tag_name === prev.tag && r?.draft === false)?.target_commitish;
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * The note lines (`- …`) RELEASE_NOTES.md gained between two commits, in the file's order.
 * null = could not be told (a commit that is not in this clone, git failing).
 */
export function addedNotes(base, head, root = CLIENT_ROOT) {
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--no-color', '--no-ext-diff', '-U0', base, head, '--', 'RELEASE_NOTES.md'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
  return diff
    .split('\n')
    .filter((l) => l.startsWith('+- '))
    .map((l) => l.slice(1).trimEnd());
}

/**
 * What "changed the app" means: the files that go into the installed app (the window, the back end,
 * its icons and resources, the version). Tests, the test back end, CI, docs and the packaging scripts
 * change nothing a person using the app can see. Pathspecs, relative to the client directory.
 */
export const APP_PATHS = ['src', 'src-tauri', ':(exclude)src-tauri/crates/harness', 'build', 'package.json'];

/**
 * The commits on main's first-parent line after `base` up to `head` that changed the app (APP_PATHS)
 * and added no note line to RELEASE_NOTES.md, newest first: [{ sha, title }].
 * null = could not be told (git failing on the range or on any one commit) — never a partial list.
 */
export function untoldCommits(base, head, root = CLIENT_ROOT) {
  let log;
  try {
    log = execFileSync('git', ['log', '--first-parent', '--no-color', '--format=%H %s', `${base}..${head}`, '--', ...APP_PATHS], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
  const out = [];
  for (const line of log.split('\n')) {
    const m = /^([0-9a-f]{40}) (.*)$/.exec(line);
    if (!m) continue;
    const own = addedNotes(`${m[1]}^`, m[1], root);
    if (own === null) return null;
    const title = m[2].trim();
    if (!own.length && title) out.push({ sha: m[1], title });
  }
  return out;
}

/**
 * The lines under `NOTES_HEADING` for a build whose previous build was made from `base`: the note
 * lines RELEASE_NOTES.md gained (file order), then `- <title>` for each untold commit (newest first).
 * → { lines, notes, titles } | null (could not be told: no section at all, never half of one).
 */
export function buildNotes(base, head, root = CLIENT_ROOT) {
  const added = addedNotes(base, head, root);
  if (added === null) return null;
  const untold = untoldCommits(base, head, root);
  if (untold === null) return null;
  return { lines: [...added, ...untold.map((c) => `- ${c.title}`)], notes: added.length, titles: untold.length };
}

/** The release page's text: `notes` as given, then the added note lines under the heading (none → `notes` unchanged). */
export function composeBody(notes, added) {
  if (!added?.length) return notes;
  return `${notes.replace(/\s+$/, '')}\n\n${NOTES_HEADING}\n\n${added.join('\n')}\n`;
}

// ---- talking to GitHub (the gh CLI, with the workflow's token) ---------------------------

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Every release (drafts included: the token can see them), every page; throws when any read fails. */
export function readReleases(repo) {
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('GitHub 返回的发版列表看不懂');
  return pages.flat();
}

/**
 * The tag of a release about to be deleted (a draft by now). → 'gone' (deleted, or there is none),
 * 'kept' (definitely not this release's: another release names it, it points at another commit, or
 * the release recorded no full commit id — the release still goes, the tag stays), or 'retry' (could
 * not tell or could not delete: the draft stays, so the next run comes back to it).
 */
function settleTag(repo, release, fresh) {
  const tag = release.tag_name;
  const path = `repos/${repo}/git/refs/tags/${encodeURIComponent(tag).replace(/%2F/g, '/')}`;
  const want = String(release?.target_commitish ?? '');
  if (fresh.some((r) => r?.tag_name === tag && r?.id !== release.id)) return note('kept', tag, '还有别的发版用着它');
  let ref;
  try {
    ref = JSON.parse(gh(['api', path.replace('/git/refs/', '/git/ref/')]));
  } catch (e) {
    const err = String(e.stderr ?? e.message);
    if (/HTTP 404/.test(err)) return 'gone';
    return note('retry', tag, `读不到这个标签（${err.trim()}）`);
  }
  if (!/^[0-9a-f]{40}$/.test(want)) return note('kept', tag, '发版没记下完整的提交号');
  if (ref?.object?.type !== 'commit' || ref?.object?.sha !== want) return note('kept', tag, '它已经不指向那个发版的提交');
  try {
    gh(['api', '-X', 'DELETE', path]);
    return 'gone';
  } catch (e) {
    return note('retry', tag, `删不掉（${String(e.stderr ?? e.message).trim()}）`);
  }
}

function note(what, tag, why) {
  console.log(`::warning::标签 ${tag} ${what === 'kept' ? '不删' : '这次没删成，下次再来'}：${why}`);
  return what;
}

/**
 * One old development build, in steps whose progress lives on GitHub itself (so any step that fails,
 * or a run that is killed, is picked up by the next run — nothing is remembered locally):
 *   1. a published one is turned into a draft (no installed app sees it any more; the draft keeps the
 *      tag's name and the commit it was made from, which is how the next run knows the tag is its own)
 *   2. its tag goes, if it is this release's (settleTag); can't tell / can't delete → stop here
 *   3. the draft goes
 * Before every step the list is read again and the same rule decides whether it still qualifies.
 * → 'done' | 'skipped' (no longer qualifies) | 'later' (left for the next run) | 'stop' (a read failed)
 */
function cleanOne(repo, c, keep, version) {
  let kind = c.kind;
  for (;;) {
    let fresh;
    try {
      fresh = readReleases(repo);
    } catch (e) {
      console.log(`::warning::清理前重读发版列表失败，这次不再清理（下次合并再试）：${String(e.stderr ?? e.message).trim()}`);
      return 'stop';
    }
    const v = stillToDelete(fresh, c, keep, version, kind);
    if (!v.ok) {
      console.log(`⏭ 不删 ${c.tag}：${v.why}`);
      return kind === c.kind ? 'skipped' : 'later';
    }
    try {
      if (kind === 'old') {
        gh(['api', '-X', 'PATCH', `repos/${repo}/releases/${c.id}`, '-F', 'draft=true']);
        kind = 'draft';
        continue;
      }
      const t = settleTag(repo, v.release, fresh);
      if (t === 'retry') return 'later';
      // the tag step took time: read again before the last write
      const again = stillToDelete(readReleases(repo), c, keep, version, 'draft');
      if (!again.ok) {
        console.log(`⏭ 不删 ${c.tag}：${again.why}`);
        return 'later';
      }
      gh(['api', '-X', 'DELETE', `repos/${repo}/releases/${c.id}`]);
      console.log(`🗑 删掉旧开发版 ${c.tag}${t === 'gone' ? '（连同标签）' : '（标签留着）'}`);
      return 'done';
    } catch (e) {
      console.log(`::warning::清理 ${c.tag} 这一步失败（下次合并再试）：${String(e.stderr ?? e.message).trim()}`);
      return 'later';
    }
  }
}

function main() {
  const a = process.argv.slice(2);
  const opt = (n) => {
    const i = a.indexOf(`--${n}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const repo = opt('repo') ?? 'GigleAI/cavil-loop';
  const version = opt('version');
  const sha = opt('sha');
  const dir = opt('dir') ?? 'dist-release';
  const notes = opt('notes-file');
  const keep = Number(opt('keep') ?? '10');
  if (!parseDev(version)) throw new Error(`--version 不是 X.Y.Z-dev.N：${version}`);
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`--sha 不是完整的提交号：${sha}`);
  if (!notes) throw new Error('缺 --notes-file');
  const tag = `${TAG_PREFIX}${version}`;
  const paths = readdirSync(dir)
    .filter((f) => f === 'latest.json' || f.includes(`-${version}-`))
    .map((f) => join(dir, f))
    .sort();
  const files = paths.map((p) => basename(p));
  if (!files.includes('latest.json') || files.length < 2) throw new Error(`${dir} 里没有 ${version} 的包和 latest.json：${files.join(', ') || '（空）'}`);

  const before = readReleases(repo);
  const d = decide(before, version, files);
  if (d.action === 'skip') {
    console.log(`⏭ 不发 ${version}：${d.why}`);
  } else if (d.action === 'done') {
    console.log(`✅ ${tag} 已经发布过了，带齐了文件`);
  } else {
    const title = `Cavil Loop 客户端 ${version}（开发版，${sha.slice(0, 7)}）`;
    if (d.action === 'create') {
      const base = previousBuildCommit(before, version);
      const got = base ? buildNotes(base, sha) : null;
      console.log(
        got?.lines.length
          ? `发版页带上 ${got.notes} 条更新说明${got.titles ? `、补上 ${got.titles} 个没写更新说明的提交标题` : ''}（相对 ${base.slice(0, 7)}）`
          : `发版页不带更新说明：${!base ? '找不到上一个开发版的提交' : got ? '发版说明没有新增条目，也没有没写说明的 App 改动' : '比不出发版说明的变化'}`,
      );
      const body = join(mkdtempSync(join(tmpdir(), 'cavil-dev-release-')), 'notes.md');
      writeFileSync(body, composeBody(readFileSync(notes, 'utf8'), got?.lines));
      gh(['release', 'create', tag, ...paths, '--repo', repo, '--draft', '--prerelease', '--latest=false', '--target', sha, '--title', title, '--notes-file', body]);
    } else {
      gh(['release', 'upload', tag, ...paths, '--repo', repo, '--clobber']);
    }
    gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--prerelease', '--latest=false']);
    const after = readReleases(repo).filter((r) => r?.tag_name === tag);
    const names = new Set((after[0]?.assets ?? []).map((x) => x?.name));
    if (after.length !== 1 || after[0].draft !== false || after[0].prerelease !== true || !files.every((f) => names.has(f))) {
      throw new Error(`发完再读，${tag} 不是「已发布的预发布、带齐 ${files.length} 个文件」`);
    }
    console.log(`✅ 已发布 ${tag}（预发布）：${files.join(', ')}`);
  }

  // The clean-up (cleanOne): every step judged again from a fresh read, every step's progress kept
  // on GitHub, so a failure anywhere is finished by a later run. GitHub has no conditional delete,
  // so a change between the last read and a write itself is not caught.
  const old = pruneCandidates(readReleases(repo), keep, version);
  const tally = { done: 0, skipped: 0, later: 0 };
  for (const c of old) {
    const r = cleanOne(repo, c, keep, version);
    if (r === 'stop') {
      tally.later += old.length - tally.done - tally.skipped - tally.later;
      break;
    }
    tally[r]++;
  }
  console.log(`保留最近 ${keep} 个开发版；这次删了 ${tally.done} 个，跳过 ${tally.skipped} 个${tally.later ? `，${tally.later} 个留到下次` : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.log(`::error::${String(e.stderr ?? '').trim() || e.message}`);
    process.exit(1);
  }
}
