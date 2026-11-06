// Which negative controls a change needs (GitHub#178). Shared by the two client runners:
// test/mutation/run.mjs (unit + window entries) and test/tauri/mutations.mjs (real app).
//
// "Related" = the change could have changed whether that entry still goes red:
//   · the entry itself was added or edited (compared with the base branch's copy of the list),
//   · the product file it breaks changed,
//   · a test file holding one of the tests it names changed (editing only an assertion counts),
//   · shared test plumbing changed (fake GitHub, fixtures, helpers, config, the runner itself):
//     nobody can say which entries that touches, so every entry is related.
//
// Three outcomes are kept apart and never merged into "0 entries, all passed":
//   selected N entries / nothing related (says which files changed) / cannot tell (non-zero).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A path relative to client/ that is a test file (its tests are mapped one by one, never "shared"). */
export const isTestFile = (f) => /^test\/.*\.(test|spec)\.tsx?$/.test(f);

/**
 * Client-relative paths whose change makes every unit / window entry related. Everything under
 * test/ that is not a test file, not the entry list and not the real-app suite is shared plumbing.
 */
export function isSharedForUnit(f) {
  if (['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts'].includes(f)) return true;
  if (!f.startsWith('test/')) return false;
  if (isTestFile(f)) return false;
  if (f === 'test/mutation/mutations.mjs') return false; // compared entry by entry
  if (f.startsWith('test/tauri/')) return false; // the real-app suite has its own runner
  return true;
}

/** Repository paths outside client/ that both runners depend on. */
export const SHARED_OUTSIDE = ['tests/lib/mutation.sh'];

/**
 * What the real-app entries (test/tauri/mutations.mjs, they all break src-tauri/src/main.rs)
 * depend on, enumerated from what test/tauri/real-window.spec.ts actually loads (GitHub#178
 * review round 1): the app shell and its config, the real-window suite itself, the fake
 * GitHub it starts (../fake-github/server) and the recorded fixtures that server reads,
 * the window build script, and the selection rules.
 */
export const APP_DEP_PREFIXES = ['test/tauri/', 'test/fake-github/', 'test/fixtures/', 'src-tauri/src/', 'src-tauri/capabilities/'];
export const APP_DEP_FILES = [
  'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'playwright.tauri.config.ts', 'package.json', 'package-lock.json',
  'scripts/build.mjs', 'test/mutation/select.mjs',
];

/** Client-relative paths whose change makes the real-app entries related. */
export function isRelatedForApp(f) {
  return APP_DEP_PREFIXES.some((p) => f.startsWith(p)) || APP_DEP_FILES.includes(f);
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * What changed against the base. `base` = CLIENT_MUT_BASE, or the merge base of HEAD and origin/main.
 * Covers committed, staged, unstaged and untracked files. Resolves to
 *   { ok: true, base, prefix, files: [client-relative], outside: [repo-relative] }
 *   { ok: false, why }   — not a git checkout, base not found, git failed: "cannot tell"
 */
export function changedFiles(root, env = process.env) {
  let prefix, base;
  try {
    prefix = git(root, ['rev-parse', '--show-prefix']).trim();
  } catch (e) {
    return { ok: false, why: `读不了 git（${firstLine(e)}）` };
  }
  const wanted = env.CLIENT_MUT_BASE;
  try {
    base = wanted ? git(root, ['rev-parse', '--verify', `${wanted}^{commit}`]).trim() : git(root, ['merge-base', 'HEAD', 'origin/main']).trim();
  } catch (e) {
    return { ok: false, why: `找不到比较的起点 ${wanted ?? 'HEAD 和 origin/main 的分叉点'}（${firstLine(e)}）` };
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base)) return { ok: false, why: `比较的起点不是提交：[${base}]` };
  let all;
  try {
    const top = git(root, ['rev-parse', '--show-toplevel']).trim();
    const diff = execFileSync('git', ['diff', '--name-only', '-z', base], { cwd: top, encoding: 'utf8' });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: top, encoding: 'utf8' });
    all = [...new Set(`${diff}${untracked}`.split('\0').filter(Boolean))].sort();
  } catch (e) {
    return { ok: false, why: `git 读改动失败（${firstLine(e)}）` };
  }
  return {
    ok: true,
    base,
    prefix,
    files: all.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)),
    outside: all.filter((f) => !f.startsWith(prefix)),
  };
}

/**
 * The base branch's copy of the entry list, or null when the base has no separate list file yet
 * (then every entry counts as new). Throws when git or the import fails: "cannot tell".
 */
export async function baseEntries(root, changes, path = 'test/mutation/mutations.mjs') {
  const spec = `${changes.base}:${changes.prefix}${path}`;
  try {
    git(root, ['cat-file', '-e', spec]);
  } catch {
    return null;
  }
  const text = git(root, ['show', spec]);
  const dir = mkdtempSync(join(tmpdir(), 'cavil-mut-base-'));
  try {
    const f = join(dir, 'mutations.mjs');
    writeFileSync(f, text);
    const mod = await import(pathToFileURL(f).href);
    if (!Array.isArray(mod.MUTATIONS)) throw new Error('主干上的清单没有导出 MUTATIONS');
    return mod.MUTATIONS;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Entries naming a test that exists nowhere (a renamed test leaves its entry pointing at
 * nothing). [{ i, what, name }]; the baseline stops on any, and selection cannot decide without them.
 */
export function unmappedNames(entries, tests) {
  const out = [];
  for (const [i, m] of entries.entries()) {
    const known = m.runner === 'e2e' ? tests.e2e : tests.unit;
    for (const name of m.expect) if (!known.some((t) => t.name.includes(name))) out.push({ i, what: m.what, name });
  }
  return out;
}

/** Client-relative files an entry edits. */
export const editedFiles = (m) => (m.edits ? m.edits.map((e) => e.file) : [m.file]);

/**
 * Pure decision. Inputs:
 *   entries   the current list
 *   base      the base branch's list, or null (no list file there yet → every entry is new)
 *   changes   { files, outside } from changedFiles
 *   tests     { unit: [{ name, file }], e2e: [{ name, file }] } — where each named test lives
 * Returns { ok: true, indices, reasons, everything } or { ok: false, why }.
 */
export function selectEntries({ entries, base, changes, tests }) {
  const changed = new Set(changes.files);
  const shared = [...changes.files.filter(isSharedForUnit), ...changes.outside.filter((f) => SHARED_OUTSIDE.includes(f))];
  const all = entries.map((_, i) => i);
  if (shared.length) return { ok: true, indices: all, everything: `测试公共部分改了（${shared.join('、')}）`, reasons: {} };
  if (base === null) return { ok: true, indices: all, everything: '主干上还没有单独的负对照清单文件，每项都算新加', reasons: {} };
  const missing = unmappedNames(entries, tests);
  if (missing.length) return { ok: false, why: `找不到第 ${missing[0].i} 项点名的测试「${missing[0].name}」在哪个文件（${missing[0].what}）` };
  const before = new Map(base.map((m) => [m.what, JSON.stringify(m)]));
  const indices = [];
  const reasons = {};
  for (const [i, m] of entries.entries()) {
    const why = [];
    if (before.get(m.what) !== JSON.stringify(m)) why.push(before.has(m.what) ? '这一项改过' : '新加的一项');
    const edited = editedFiles(m).filter((f) => changed.has(f));
    if (edited.length) why.push(`要改坏的文件改了（${edited.join('、')}）`);
    const known = m.runner === 'e2e' ? tests.e2e : tests.unit;
    for (const name of m.expect) {
      const files = [...new Set(known.filter((t) => t.name.includes(name)).map((t) => t.file))];
      const hit = files.filter((f) => changed.has(f));
      if (hit.length) why.push(`点名的测试所在文件改了（${hit.join('、')}）`);
    }
    if (why.length) {
      indices.push(i);
      reasons[i] = [...new Set(why)];
    }
  }
  return { ok: true, indices, reasons, everything: '' };
}

function firstLine(e) {
  return String(e?.stderr || e?.message || e).trim().split('\n')[0];
}
