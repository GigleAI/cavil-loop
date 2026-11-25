#!/usr/bin/env node
// The hand-over between the Client workflow and the maintainers' Mac that builds and signs the Mac
// packages (scripts/mac-release.sh). Its own file, not part of dev-release.mjs: it serves both kinds
// of client release (development builds and client/vX.Y.Z); dev-release.mjs stays the development
// build's publisher, and this reuses its rules (file lists, buildState, decide, tags).
//
// One draft release per version is the whole protocol; all of its state lives on GitHub, nothing is
// remembered on either side. Installed apps never see a draft.
//   create   (Actions, development builds, once the tests and the Windows build passed) the draft
//            `client/v<version>` on the tested commit, carrying the Windows installer and its signature,
//            with the same judgement dev-release.mjs makes before it creates one (no higher published
//            development build, this version not out, its tag not there yet) and the same page (title,
//            what changed since the previous build). A draft of this version that never was public
//            gets the Windows files replaced. A release's draft is made by the workflow itself
//            (client.yml, job release: `gh release create --draft` on the tag it pushed).
//   waiting  (the Mac) the draft to build now, as JSON, or null: a release before a development
//            build; of the development drafts only the highest, and none below the highest published
//            development build (dev-release.mjs deletes those)
//   fetch    (the Mac) the draft's Windows files and its page text, into a directory
//   publish  (the Mac, releases only — development builds go through dev-release.mjs, which fills the
//            draft) every file in, then public, then read back: public, not a pre-release, every file
//            uploaded, the tag on the commit
//   stale    (the nightly run) any draft that has waited longer than --hours: listed, exit 1
//
//   node scripts/handover.mjs create --version V --sha S --dir D --notes-file N [--repo R]
//   node scripts/handover.mjs waiting [--repo R]
//   node scripts/handover.mjs fetch --tag T --dir D --notes-out F [--repo R]
//   node scripts/handover.mjs publish --tag T --sha S --dir D [--repo R]
//   node scripts/handover.mjs stale --hours H [--repo R]
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildState, createDraft, decide, devFiles, devReleases, gh, parseDev, readReleases, TAG_PREFIX, tagOn, tagState, windowsFiles } from './dev-release.mjs';
import { VERSION_SHAPE } from './update-manifest.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/;

/** 'dev' | 'stable' | null for a version string. */
export function channelOf(version) {
  if (parseDev(version)) return 'dev';
  return VERSION_SHAPE.stable.test(String(version ?? '')) ? 'stable' : null;
}

/**
 * Every draft handed to the Mac: a client draft that never was public (no publish time, the tag
 * not created by publishing), on a full commit, carrying both Windows files uploaded.
 * → [{ id, tag, version, channel, sha, created }]
 */
export function handedOver(list) {
  const out = [];
  for (const r of list) {
    if (r?.draft !== true || r?.published_at !== null || typeof r?.tag_name !== 'string' || !r.tag_name.startsWith(TAG_PREFIX)) continue;
    const version = r.tag_name.slice(TAG_PREFIX.length);
    const channel = channelOf(version);
    if (!channel || !FULL_SHA.test(String(r.target_commitish ?? ''))) continue;
    if (buildState(r, windowsFiles(version)).state !== 'complete') continue;
    out.push({ id: r.id, tag: r.tag_name, version, channel, sha: r.target_commitish, created: r.created_at ?? null });
  }
  return out;
}

const devCmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
const relCmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** The one draft the Mac builds now (see the header), or null. */
export function waiting(list) {
  const all = handedOver(list);
  const rel = all.filter((d) => d.channel === 'stable').sort((a, b) => relCmp(a.version, b.version));
  if (rel.length) return rel[0];
  const top = devReleases(list)[0]?.parsed;
  const dev = all
    .filter((d) => d.channel === 'dev' && (!top || devCmp(parseDev(d.version), top) > 0))
    .sort((a, b) => devCmp(parseDev(b.version), parseDev(a.version)));
  return dev[0] ?? null;
}

/** The handed-over drafts older than `hours` at `now`. A draft whose creation time cannot be read counts as old. */
export function stale(list, hours, now = Date.now()) {
  return handedOver(list).filter((d) => {
    const t = Date.parse(d.created ?? '');
    return !Number.isFinite(t) || now - t > hours * 3600_000;
  });
}

/** The files in `dir` that belong to `version` and are named in `names`; throws when one is missing. */
function filesOf(dir, names) {
  const have = new Set(readdirSync(dir));
  const missing = names.filter((n) => !have.has(n));
  if (missing.length) throw new Error(`${dir} 里缺：${missing.join(', ')}`);
  return names.map((n) => join(dir, n));
}

function create(a) {
  const { repo, version, sha, dir, notes } = a;
  if (channelOf(version) !== 'dev') throw new Error(`--version ${version} 不是开发版的版本号（正式版的草稿由工作流自己建）`);
  if (!FULL_SHA.test(sha ?? '')) throw new Error(`--sha 不是完整的提交号：${sha}`);
  if (!notes || !existsSync(notes)) throw new Error('缺 --notes-file');
  const tag = `${TAG_PREFIX}${version}`;
  const files = windowsFiles(version);
  const paths = filesOf(dir, files);
  const list = readReleases(repo);
  const d = decide(list, version, files);
  if (d.action === 'skip') return console.log(`⏭ 不交给 Mac：${d.why}`);
  if (d.action === 'unknown') throw new Error(`${tag}：${d.why}：什么都不写`);
  if (d.action === 'keep' || d.action === 'done') throw new Error(`${tag} 已经公开过：按维护者的选择，已公开的版本一律不改；等下一个提交发更高的版本`);
  const t = tagState(repo, tag);
  if (t.state !== 'absent') throw new Error(`${tag} 的标签${t.state === 'present' ? '已经存在：这个版本做过' : `读不出（${t.why}）`}：什么都不写`);
  if (d.action === 'create') createDraft(repo, list, version, sha, paths, notes);
  else gh(['release', 'upload', tag, ...paths, '--repo', repo, '--clobber']);
  const back = handedOver(readReleases(repo)).find((x) => x.tag === tag && x.sha === sha);
  if (!back) throw new Error(`交完再读，${tag} 不是「从没公开过、在 ${sha.slice(0, 7)} 上、带齐 Windows 文件」的草稿`);
  console.log(`✅ ${tag} 交给 Mac：草稿，带着 ${files.join(', ')}`);
}

function fetchDraft(a) {
  const { repo, tag, dir, notesOut } = a;
  const r = readReleases(repo).filter((x) => x?.tag_name === tag);
  if (r.length !== 1 || r[0].draft !== true) throw new Error(`${tag}：找不到唯一的草稿`);
  const version = tag.slice(TAG_PREFIX.length);
  for (const name of windowsFiles(version)) {
    const asset = (r[0].assets ?? []).find((x) => x?.name === name);
    if (!asset || !Number.isSafeInteger(asset.id)) throw new Error(`${tag} 的草稿里没有 ${name}`);
    const out = join(dir, name);
    // the asset's own address: drafts have no public download link
    const p = spawnSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
    if (p.status !== 0) throw new Error(`下载 ${name} 失败：${String(p.stderr).trim()}`);
    writeFileSync(out, p.stdout);
    if (statSync(out).size !== asset.size) throw new Error(`${name} 下载到 ${statSync(out).size} 字节，草稿里是 ${asset.size}`);
  }
  writeFileSync(notesOut, String(r[0].body ?? ''));
  console.log(`取回 ${tag} 的 Windows 文件和发版页文字`);
}

function publish(a) {
  const { repo, tag, sha, dir } = a;
  const version = tag.slice(TAG_PREFIX.length);
  if (channelOf(version) !== 'stable') throw new Error(`publish 只发正式版；开发版用 dev-release.mjs`);
  const files = devFiles(version);
  const paths = filesOf(dir, files);
  const same = readReleases(repo).filter((r) => r?.tag_name === tag);
  if (same.length !== 1 || same[0].draft !== true || same[0].published_at !== null) throw new Error(`${tag} 不是唯一的、从没公开过的草稿：什么都不写`);
  const t = tagOn(repo, tag, sha);
  if (!t.ok) throw new Error(`${tag}：${t.why}：什么都不写`);
  gh(['release', 'upload', tag, ...paths, '--repo', repo, '--clobber']);
  gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--prerelease=false', '--latest=false']);
  const after = readReleases(repo).filter((r) => r?.tag_name === tag);
  if (after.length !== 1 || after[0].draft !== false || after[0].prerelease !== false || buildState(after[0], files).state !== 'complete') {
    throw new Error(`发完再读，${tag} 不是「已发布的正式版、带齐 ${files.length} 个文件」`);
  }
  const t2 = tagOn(repo, tag, sha);
  if (!t2.ok) throw new Error(`发完再读，${tag} 的${t2.why}`);
  console.log(`✅ 已发布 ${tag}：${files.join(', ')}`);
}

function main() {
  const [cmd, ...a] = process.argv.slice(2);
  const opt = (n) => {
    const i = a.indexOf(`--${n}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const repo = opt('repo') ?? 'GigleAI/cavil-loop';
  if (cmd === 'waiting') return console.log(JSON.stringify(waiting(readReleases(repo))));
  if (cmd === 'stale') {
    const hours = Number(opt('hours'));
    if (!(hours > 0)) throw new Error('--hours 要是正数');
    const old = stale(readReleases(repo), hours);
    if (!old.length) return console.log(`没有等了超过 ${hours} 小时的草稿`);
    for (const d of old) console.log(`::error::${d.tag}（${d.sha.slice(0, 7)}）交给 Mac 已经超过 ${hours} 小时还没发布（建于 ${d.created ?? '读不出'}）：看一下 Mac 上的 mac-release.sh status`);
    process.exit(1);
  }
  if (cmd === 'create') return create({ repo, version: opt('version'), sha: opt('sha'), dir: opt('dir') ?? 'dist-release', notes: opt('notes-file') });
  if (cmd === 'fetch') return fetchDraft({ repo, tag: opt('tag'), dir: opt('dir'), notesOut: opt('notes-out') });
  if (cmd === 'publish') return publish({ repo, tag: opt('tag'), sha: opt('sha'), dir: opt('dir') });
  throw new Error(`不认识的命令：${cmd ?? '（空）'}（create / waiting / fetch / publish / stale）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.log(`::error::${String(e.stderr ?? '').trim() || e.message}`);
    process.exit(1);
  }
}
