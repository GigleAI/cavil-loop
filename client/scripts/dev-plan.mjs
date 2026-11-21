#!/usr/bin/env node
// Does this run of the nightly development build (GitHub#628) have anything new to publish?
// Run by .github/workflows/client.yml's mode job, only on the runs that may publish a development
// build: the nightly schedule, and a manual run on main with "publish" ticked.
//
// The maintainer's choice on #628 (Q1 = A): a development build comes out on a night only when the
// client changed since the last one that was published. "The client" is what starts the Client
// workflow at all (its path filter): client/, the workflow file, the client test setup.
//
//   latest published development build (exact tag shape, marked pre-release, not a draft; highest
//   version first — scripts/dev-release.mjs `devReleases`) and the full commit it was built from:
//     none, or no full commit recorded                      → build ("nothing to compare with")
//     not carrying every file a build carries, uploaded
//     (`devFiles` + `buildState`, the publish step's own
//     verdict): incomplete, or a file it cannot judge      → build (the publish step fills it in, or
//                                                            refuses while a file cannot be judged)
//     the same commit as this run's                         → no build, unless forced
//     another commit, those paths differ (git diff)         → build
//     another commit, those paths identical                 → no build, unless forced
//     git cannot tell (the commit is not in this clone, …)  → build ("can't tell")
//   the release list cannot be read                         → build ("can't tell")
//   a development build of a higher version than the latest published one that is not public — a
//   tag with no published release (a public build the publish step hid to fill it in, then could
//   not finish: GitHub#628 review round 4), or a draft when this token can see drafts
//                                                            → build (the publish step finishes it, or
//                                                              publishes a newer version over it)
//   the tag list cannot be read                             → build ("can't tell")
// This run's token can only read (contents: read), and GitHub lists drafts only to tokens that can
// write — so the tag is what shows a hidden build here: a published release's tag stays when it is
// turned back into a draft, and a fresh draft has none (it is created on publishing). A draft that
// never was public and has no tag holds nothing installed apps miss: the plan's commit comparison
// with the last public build still sees every client change since.
// Building when it cannot tell costs one extra build; skipping when it cannot tell could lose a
// night's changes. A forced run on the commit already published builds and checks again; its
// publish step then finds that version complete and writes nothing (dev-release.mjs).
//
//   node scripts/dev-plan.mjs --sha <commit> [--force] [--repo GigleAI/cavil-loop]
//   → writes build=true|false and why=<one line> to $GITHUB_OUTPUT (when set), and says why on stdout
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildState, devFiles, devReleases, parseDev, readReleases, TAG_PREFIX } from './dev-release.mjs';

/** What starts the Client workflow (its `paths` filter), as pathspecs from the repository root. */
export const CLIENT_INPUTS = ['client', '.github/workflows/client.yml', '.github/actions/client-setup'];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FULL_SHA = /^[0-9a-f]{40}$/;

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];

/**
 * A development build that was made but is not public now, of a higher version than the newest
 * published one (there is none: any version): from `tags` (tag names) without a published release,
 * and from drafts in `list` (when the token sees them). The highest → { tag, version, kind:
 * 'tag' | 'draft' } | null.
 */
export function hiddenBuild(list, tags) {
  const top = devReleases(list)[0];
  const isPublic = new Set(list.filter((r) => r?.draft === false).map((r) => r?.tag_name));
  const seen = [
    ...tags.map((t) => ({ tag: t, kind: 'tag' })),
    ...list.filter((r) => r?.draft === true && typeof r?.tag_name === 'string').map((r) => ({ tag: r.tag_name, kind: 'draft' })),
  ];
  let best = null;
  for (const c of seen) {
    if (typeof c.tag !== 'string' || !c.tag.startsWith(TAG_PREFIX) || isPublic.has(c.tag)) continue;
    const parsed = parseDev(c.tag.slice(TAG_PREFIX.length));
    if (!parsed || (top && cmp(parsed, top.parsed) <= 0)) continue;
    if (!best || cmp(parsed, best.parsed) > 0) best = { ...c, parsed };
  }
  return best && { tag: best.tag, version: best.tag.slice(TAG_PREFIX.length), kind: best.kind };
}

/**
 * The newest published development build, the commit it was made from, whether it carries every
 * file, uploaded (the publish step's own verdict, `buildState`), and any hidden build above it.
 * `tags` = the repository's client/v* tag names, or 'unreadable'.
 * → { tag, sha, complete, state, hidden, tags } | null (there is no published one: hidden/tags then
 *   travel as `{ none: true, hidden, tags }`)
 */
export function latestBuild(list, tags = []) {
  const top = devReleases(list)[0];
  const hidden = tags === 'unreadable' ? null : hiddenBuild(list, tags);
  const extra = { hidden, tags: tags === 'unreadable' ? 'unreadable' : 'ok' };
  if (!top) return hidden || tags === 'unreadable' ? { none: true, ...extra } : null;
  const rel = list.find((r) => r?.tag_name === top.tag && r?.draft === false);
  const sha = rel?.target_commitish;
  const state = buildState(rel, devFiles(top.version)).state;
  return { tag: top.tag, sha: typeof sha === 'string' && FULL_SHA.test(sha) ? sha : null, complete: state === 'complete', state, ...extra };
}

/** The repository's client/v* tag names (every page); throws when a read fails. */
export function readTags(repo) {
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/git/matching-refs/tags/${TAG_PREFIX}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const pages = JSON.parse(out);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('GitHub 返回的标签列表看不懂');
  const refs = pages.flat();
  if (!refs.every((r) => typeof r?.ref === 'string' && r.ref.startsWith('refs/tags/'))) throw new Error('GitHub 返回的标签列表看不懂');
  return refs.map((r) => r.ref.slice('refs/tags/'.length));
}

/**
 * Do the client's inputs differ between two commits? → true | false | null (git cannot tell).
 * `git diff --quiet` exits 1 when they differ, 0 when they do not, anything else on an error.
 */
export function clientChanged(base, head, root = REPO_ROOT) {
  try {
    execFileSync('git', ['diff', '--quiet', '--no-ext-diff', base, head, '--', ...CLIENT_INPUTS], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    return false;
  } catch (e) {
    return e?.status === 1 ? true : null;
  }
}

/**
 * The decision, from what was read. `latest` = latestBuild(…) or the string 'unreadable';
 * `changed` = clientChanged(…) (only asked when there is a commit to compare with).
 * → { build, why }
 */
export function plan({ latest, head, force, changed }) {
  if (latest === 'unreadable') return { build: true, why: '读不到发版列表，不知道上一个开发版是哪个提交：照常构建' };
  if (latest?.tags === 'unreadable') return { build: true, why: '读不到标签列表，不知道有没有停在草稿、没公开的开发版：照常构建' };
  if (latest?.hidden) {
    return { build: true, why: `开发版 ${latest.hidden.tag} 做过但现在没有公开（${latest.hidden.kind === 'tag' ? '标签在、发版页不在：上次补传或发布没做完' : '停在草稿'}）：照常构建，发布那一步把它补齐，或发一个更新的版本` };
  }
  if (!latest || latest.none) return { build: true, why: '还没有发布过开发版：照常构建' };
  if (!latest.sha) return { build: true, why: `上一个开发版 ${latest.tag} 没记下完整的提交号：照常构建` };
  if (latest.complete !== true) {
    return latest.state === 'unknown'
      ? { build: true, why: `读不出上一个开发版 ${latest.tag} 的文件是否已上传完成：照常构建，发布那一步再核对，仍读不出就什么都不写` }
      : { build: true, why: `上一个开发版 ${latest.tag} 没带齐文件（Mac、Windows 的包、签名或更新清单缺了或没上传完）：照常构建，发布那一步把它补齐或发新版` };
  }
  const last = `上一个开发版 ${latest.tag}（${latest.sha.slice(0, 7)}）`;
  if (latest.sha === head) {
    return force
      ? { build: true, why: `${last}就是这个提交；勾了「客户端没改动也出」：照样构建检查，发布那一步会发现这个版本已经发过、什么都不写` }
      : { build: false, why: `${last}就是这个提交：没有新东西，这次不构建、不发` };
  }
  const c = typeof changed === 'function' ? changed(latest.sha, head) : changed;
  if (c === null) return { build: true, why: `比不出 ${last}以来客户端有没有改动：照常构建` };
  if (c) return { build: true, why: `${last}以来客户端有改动：构建并发布` };
  return force
    ? { build: true, why: `${last}以来客户端没有改动；勾了「客户端没改动也出」：构建并发布` }
    : { build: false, why: `${last}以来客户端没有改动：这次不构建、不发` };
}

function main() {
  const a = process.argv.slice(2);
  const opt = (n) => {
    const i = a.indexOf(`--${n}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const repo = opt('repo') ?? 'GigleAI/cavil-loop';
  const head = opt('sha');
  if (!FULL_SHA.test(head ?? '')) throw new Error(`--sha 不是完整的提交号：${head}`);
  let latest;
  try {
    const list = readReleases(repo);
    let tags;
    try {
      tags = readTags(repo);
    } catch (e) {
      console.log(`::warning::读标签列表失败：${String(e.stderr ?? e.message).trim()}`);
      tags = 'unreadable';
    }
    latest = latestBuild(list, tags);
  } catch (e) {
    console.log(`::warning::读发版列表失败：${String(e.stderr ?? e.message).trim()}`);
    latest = 'unreadable';
  }
  const r = plan({ latest, head, force: a.includes('--force'), changed: (base, h) => clientChanged(base, h) });
  console.log(`${r.build ? '构建' : '不构建'}：${r.why}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build=${r.build}\nwhy=${r.why.replace(/\n/g, ' ')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exit(1);
  }
}
