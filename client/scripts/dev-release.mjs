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
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
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
 * Drafts an earlier run left behind (cancelled by a newer push mid-publish): development-shaped
 * drafts of a version lower than `version`. Never one of a higher version — a newer run may be
 * publishing it right now. A draft has no tag yet, so only the draft goes.
 */
export function staleDrafts(list, version) {
  const mine = parseDev(version);
  return list
    .filter((r) => r?.draft === true && typeof r?.tag_name === 'string' && r.tag_name.startsWith(TAG_PREFIX))
    .map((r) => ({ tag: r.tag_name, parsed: parseDev(r.tag_name.slice(TAG_PREFIX.length)) }))
    .filter((r) => r.parsed && cmp(r.parsed, mine) < 0);
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
export function stillToDelete(list, c, keep, version) {
  if (!Number.isSafeInteger(c?.id)) return { ok: false, why: '读不到它的发版编号' };
  const same = list.filter((r) => r?.id === c.id);
  if (same.length !== 1) return { ok: false, why: '这个发版已经不在了' };
  if (list.filter((r) => r?.tag_name === c.tag).length !== 1) return { ok: false, why: `标签 ${c.tag} 对应的发版不止一个` };
  const now = pruneCandidates(list, keep, version).find((x) => x.id === c.id);
  if (!now || now.tag !== c.tag || now.kind !== c.kind) return { ok: false, why: '它已经不符合清理条件（被改过）' };
  return { ok: true, release: same[0] };
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
 * The tag of a deleted release: only when no release names it any more (fresh read) and it still
 * points at the commit that release recorded (`target_commitish`, the full commit id it was created
 * with). Anything else (a read that fails, another release on it, moved, not a commit id) keeps the tag.
 */
function deleteTag(repo, tag, release) {
  const keepIt = (why) => console.log(`::warning::标签 ${tag} 没删：${why}`);
  const want = String(release?.target_commitish ?? '');
  if (!/^[0-9a-f]{40}$/.test(want)) return keepIt('发版没记下完整的提交号');
  try {
    if (readReleases(repo).some((r) => r?.tag_name === tag)) return keepIt('还有发版用着它');
    const ref = JSON.parse(gh(['api', `repos/${repo}/git/ref/tags/${encodeURIComponent(tag).replace(/%2F/g, '/')}`]));
    if (ref?.object?.type !== 'commit' || ref?.object?.sha !== want) return keepIt('它已经不指向那个发版的提交');
    gh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/tags/${encodeURIComponent(tag).replace(/%2F/g, '/')}`]);
  } catch (e) {
    keepIt(String(e.stderr ?? e.message).trim());
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

  const d = decide(readReleases(repo), version, files);
  if (d.action === 'skip') {
    console.log(`⏭ 不发 ${version}：${d.why}`);
  } else if (d.action === 'done') {
    console.log(`✅ ${tag} 已经发布过了，带齐了文件`);
  } else {
    const title = `Cavil Loop 客户端 ${version}（开发版，${sha.slice(0, 7)}）`;
    if (d.action === 'create') {
      gh(['release', 'create', tag, ...paths, '--repo', repo, '--draft', '--prerelease', '--latest=false', '--target', sha, '--title', title, '--notes-file', notes]);
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

  // Each deletion is judged again from a fresh read right before it (the list can change meanwhile:
  // someone unmarks a pre-release, a newer run publishes). The release goes by its id; its tag only
  // when no release names it any more and it still points at the commit the release recorded.
  // A read that fails stops the clean-up (the next push retries it); GitHub has no conditional
  // delete, so a change between that last read and the delete itself is not caught.
  const old = pruneCandidates(readReleases(repo), keep, version);
  let failed = 0;
  let done = 0;
  for (const c of old) {
    let fresh;
    try {
      fresh = readReleases(repo);
    } catch (e) {
      console.log(`::warning::删旧开发版前重读发版列表失败，这次不再删（下次合并再试）：${String(e.stderr ?? e.message).trim()}`);
      failed += old.length - done - failed;
      break;
    }
    const v = stillToDelete(fresh, c, keep, version);
    if (!v.ok) {
      console.log(`⏭ 不删 ${c.tag}：${v.why}`);
      done++;
      continue;
    }
    try {
      gh(['api', '-X', 'DELETE', `repos/${repo}/releases/${c.id}`]);
      console.log(`🗑 删掉旧开发版${c.kind === 'draft' ? '（没发完的草稿）' : ''} ${c.tag}`);
      if (c.kind === 'old') deleteTag(repo, c.tag, v.release);
      done++;
    } catch (e) {
      failed++;
      console.log(`::warning::删旧开发版 ${c.tag} 失败（下次合并再试）：${String(e.stderr ?? e.message).trim()}`);
    }
  }
  console.log(`保留最近 ${keep} 个开发版；这次处理了 ${done} 个${failed ? `，${failed} 个没删掉` : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.log(`::error::${String(e.stderr ?? '').trim() || e.message}`);
    process.exit(1);
  }
}
