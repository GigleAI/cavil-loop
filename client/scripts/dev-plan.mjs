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
//     not carrying every file a build carries (`devFiles`,
//     judged by the publish step's own `decide`: not "done") → build (the publish step fills it in)
//     the same commit as this run's                         → no build, unless forced
//     another commit, those paths differ (git diff)         → build
//     another commit, those paths identical                 → no build, unless forced
//     git cannot tell (the commit is not in this clone, …)  → build ("can't tell")
//   the release list cannot be read                         → build ("can't tell")
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
import { decide, devFiles, devReleases, readReleases } from './dev-release.mjs';

/** What starts the Client workflow (its `paths` filter), as pathspecs from the repository root. */
export const CLIENT_INPUTS = ['client', '.github/workflows/client.yml', '.github/actions/client-setup'];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The newest published development build, the commit it was made from, and whether it carries every
 * file (the publish step's own judgement: `decide` says "done" — anything else, including a list it
 * cannot judge, is "not complete").
 * → { tag, sha, complete } (sha null = no full commit recorded) | null (there is none)
 */
export function latestBuild(list) {
  const top = devReleases(list)[0];
  if (!top) return null;
  const sha = list.find((r) => r?.tag_name === top.tag && r?.draft === false)?.target_commitish;
  let complete = false;
  try {
    complete = decide(list, top.version, devFiles(top.version)).action === 'done';
  } catch {
    complete = false;
  }
  return { tag: top.tag, sha: typeof sha === 'string' && FULL_SHA.test(sha) ? sha : null, complete };
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
  if (!latest) return { build: true, why: '还没有发布过开发版：照常构建' };
  if (!latest.sha) return { build: true, why: `上一个开发版 ${latest.tag} 没记下完整的提交号：照常构建` };
  if (latest.complete !== true) return { build: true, why: `上一个开发版 ${latest.tag} 没带齐文件（Mac、Windows 的包或更新清单缺了）：照常构建，发布那一步把它补齐或发新版` };
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
    latest = latestBuild(readReleases(repo));
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
