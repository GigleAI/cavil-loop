// A machine for the "本机 daemon" section (GitHub#314): a fake HOME, the fake
// scheduler and system tools the daemon's own tests use
// (tests/fixtures/install-fakes.sh: systemctl / launchctl / plutil / uname / gh /
// tmux), and a local copy of this repository as the place the daemon is
// cloned from — so the back end runs the daemon's real scripts (GitHub#313)
// and nothing reaches the network.
//
// The PATH each back end gets is built from symlinks, so a test can take a
// tool away ("缺 tmux") even when the machine has it.
//
// A machine is ~2300 files: every test file that makes them calls `dropWorlds()` once it is done
// with them (GitHub#469).

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repository root. Inside a negative-control copy (client/test/mutation/run.mjs copies
// client/ into a temp folder) "three folders up" is the temp dir's parent, so the copy is told
// where the real client/ is through CLIENT_MUT_REPO, as the other tests that need it read it.
export const REPO = join(process.env.CLIENT_MUT_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'), '..');

export type Os = 'Linux' | 'Darwin';

export interface DaemonWorld {
  dir: string;
  home: string;
  /** the bare repository the daemon is cloned from */
  origin: string;
  /** the daemon's install location in the fake HOME */
  skill: string;
  fakes: string;
  /** fake scheduler state folders */
  sd: string;
  ld: string;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** A fake machine in `dir`, with the daemon not installed yet. */
export function daemonWorld(dir: string): DaemonWorld {
  worlds.push(dir);
  const fakes = join(dir, 'fakes');
  const r = spawnSync('bash', ['-c', 'source "$1/tests/fixtures/install-fakes.sh" && install_fakes "$2"', '_', REPO, fakes]);
  if (r.status !== 0) throw new Error(`install_fakes failed: ${r.stderr}`);
  // the daemon's source: this checkout's files (the client and docs are not needed), one commit, a bare origin
  const src = join(dir, 'src');
  mkdirSync(src, { recursive: true });
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', '.', ':!client', ':!docs'], { cwd: REPO }).toString().split('\0').filter(Boolean);
  execFileSync('bash', ['-c', 'cd "$1" && xargs -0 -I{} cp --parents -P {} "$2/" 2>/dev/null; true', '_', REPO, src], { input: files.join('\0') });
  git(src, 'init', '-q', '-b', 'main');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'daemon');
  const origin = join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', src, origin);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const sd = join(dir, 'sd');
  const ld = join(dir, 'ld');
  mkdirSync(sd);
  mkdirSync(ld);
  return { dir, home, origin, skill: join(home, '.agents', 'skills', 'cavil-loop'), fakes, sd, ld };
}

let pathSeq = 0;
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/local/bin'];

/**
 * A PATH with the fakes, the given agents' programs and the system's tools — minus `missing`.
 * Each tool is a symlink, so a missing tool is really gone. Two folders, fakes first: the fakes and
 * agents (a dozen links) in a fresh folder of this machine, and the system's tools (~1500 links) in
 * one folder per `missing` set shared by every case of this run (GitHub#469: building those per call
 * left millions of files behind). The first folder is the one `wrapTool` / `addTool` change.
 */
export function pathFor(w: DaemonWorld, o: { agents?: string[]; missing?: string[] } = {}): string {
  const bin = join(w.dir, `path-${++pathSeq}`);
  mkdirSync(bin);
  const missing = new Set(o.missing ?? []);
  linkAll(bin, [join(w.fakes, 'bin'), ...(o.agents ?? ['claude']).map((a) => join(w.fakes, `agents-${a}`))], missing);
  return `${bin}:${systemPath(missing)}`;
}

function linkAll(bin: string, from: string[], missing: Set<string>): void {
  for (const d of from) {
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      if (missing.has(name) || existsSync(join(bin, name))) continue;
      try {
        symlinkSync(join(d, name), join(bin, name));
      } catch {
        /* a name seen twice */
      }
    }
  }
}

/** The system's tools minus `missing`, built once per run (in this run's temp folder) and shared. */
function systemPath(missing: Set<string>): string {
  const key = createHash('sha256').update([...missing].sort().join('\0')).digest('hex').slice(0, 12);
  const dir = join(tmpdir(), `cavil-client-syspath-${key}`);
  if (existsSync(dir)) return dir;
  // built aside and renamed into place, so a case in another worker never sees a half-built folder
  const part = mkdtempSync(`${dir}.part-`);
  linkAll(part, SYSTEM_DIRS, missing);
  try {
    renameSync(part, dir);
  } catch {
    rmSync(part, { recursive: true, force: true });
    if (!existsSync(dir)) throw new Error(`could not build ${dir}`);
  }
  return dir;
}

/** The folder of a `pathFor` PATH where a case's own changes go (it comes first). */
const ownBin = (path: string) => path.split(':')[0];

/** A tool as a `pathFor` PATH finds it. */
function findTool(path: string, name: string): string | null {
  for (const d of path.split(':')) if (existsSync(join(d, name))) return join(d, name);
  return null;
}

const worlds: string[] = [];
/**
 * Remove every machine made since the last call (GitHub#469): a machine is ~2300 files, so each test
 * file calls this when a case (or, for one built in beforeAll, the file) is done with it.
 */
export function dropWorlds(): void {
  for (const d of worlds.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * TMPDIR as this process has it, for a child started with an environment of its own: without it
 * the child's temp files land in the system temp dir instead of this run's folder (GitHub#469).
 */
export const keepTmp = (): Record<string, string> => (process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {});

/** The back end's environment for this machine (test mode switches, GitHub#314). */
export function daemonEnv(w: DaemonWorld, o: { os: Os; path: string; extra?: Record<string, string>; opened?: string }): Record<string, string> {
  return {
    CAVIL_CLIENT_TEST_DAEMON_HOME: w.home,
    CAVIL_CLIENT_TEST_DAEMON_PATH: o.path,
    CAVIL_CLIENT_TEST_DAEMON_CLONE: w.origin,
    CAVIL_CLIENT_TEST_DAEMON_ENV: JSON.stringify({ FAKE_UNAME: o.os, FAKE_SD: w.sd, FAKE_LD: w.ld, ...(o.extra ?? {}) }),
    ...(o.opened ? { CAVIL_CLIENT_TEST_DAEMON_OPENED_FILE: o.opened } : {}),
  };
}

/** Install the daemon the way the README does (a clone in ~/.agents/skills), without the client. */
export function installByHand(w: DaemonWorld): void {
  mkdirSync(dirname(w.skill), { recursive: true });
  git(w.dir, 'clone', '-q', w.origin, w.skill);
}

/** Connect a project with the daemon's real `setup.sh --yes` (sub-issue 3 does this from the client). */
export function connect(w: DaemonWorld, key: string, os: Os, path: string, env: Record<string, string> = {}): string {
  const host = join(w.dir, 'projects', key);
  mkdirSync(host, { recursive: true });
  git(host, 'init', '-q', '-b', 'main');
  git(host, 'commit', '-q', '--allow-empty', '-m', 'init');
  const r = spawnSync('bash', [join(w.skill, 'setup.sh'), '--yes', host], {
    env: { ...keepTmp(), HOME: w.home, PATH: path, FAKE_UNAME: os, FAKE_SD: w.sd, FAKE_LD: w.ld, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`setup.sh failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return host;
}

/** A new commit on the daemon's origin; `edit` changes files in a scratch clone. */
export function pushDaemonChange(w: DaemonWorld, edit: (dir: string) => void): string {
  const tmp = join(w.dir, `change-${++pathSeq}`);
  git(w.dir, 'clone', '-q', w.origin, tmp);
  edit(tmp);
  git(tmp, 'commit', '-qam', 'change');
  git(tmp, 'push', '-q', 'origin', 'main');
  return git(tmp, 'rev-parse', 'HEAD').trim();
}

export const headOf = (dir: string) => git(dir, 'rev-parse', 'HEAD').trim();

export function appendLine(file: string, after: string, line: string): void {
  const t = readFileSync(file, 'utf8');
  if (!t.includes(after)) throw new Error(`${file}: no "${after}"`);
  writeFileSync(file, t.replace(after, `${after}\n${line}`));
}

/** Put a wrapper in front of one tool of a `pathFor` PATH (in its own folder); `$REAL` in the script is the real tool. */
export function wrapTool(path: string, name: string, script: string): void {
  const found = findTool(path, name);
  if (!found) throw new Error(`no ${name} on ${path}`);
  const real = realpathSync(found);
  const link = join(ownBin(path), name);
  rmSync(link, { force: true });
  writeFileSync(link, `#!/bin/bash\nREAL=${JSON.stringify(real)}\n${script}\n`);
  chmodSync(link, 0o755);
}

/** Give a `pathFor` PATH a tool back (as the person installing it would). */
export function addTool(path: string, name: string, from: string): void {
  symlinkSync(from, join(ownBin(path), name));
}

/** The machine's real copy of a tool. */
export function systemTool(name: string): string {
  for (const d of SYSTEM_DIRS) if (existsSync(join(d, name))) return join(d, name);
  throw new Error(`no ${name} on this machine`);
}

// ── "接上 daemon" (GitHub#315) ──

/**
 * A repository "on github.com" for this machine: a bare repository under `<dir>/gh/<owner>/<name>.git`,
 * reached through git's own `url.<base>.insteadOf = https://github.com/` — so the back end clones the
 * real address (https://github.com/<owner>/<name>.git, which stays the clone's origin) and nothing
 * reaches the network. Returns the environment that does the rewrite (for `daemonEnv`'s `extra`).
 */
export function githubRepo(w: DaemonWorld, repo: string): Record<string, string> {
  const base = join(w.dir, 'gh');
  const src = join(w.dir, `seed-${repo.replace('/', '-')}`);
  mkdirSync(src, { recursive: true });
  git(src, 'init', '-q', '-b', 'main');
  writeFileSync(join(src, 'README.md'), `# ${repo}\n`);
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'init');
  mkdirSync(join(base, repo.split('/')[0]), { recursive: true });
  git(w.dir, 'clone', '-q', '--bare', src, join(base, `${repo}.git`));
  return githubRewrite(w);
}

export function githubRewrite(w: DaemonWorld): Record<string, string> {
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${join(w.dir, 'gh')}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' };
}

/** A local copy at `dir` whose origin (as written in its config) is `origin`. */
export function localCopy(dir: string, origin: string | null): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return realpathSync(dir);
}

export const originOf = (dir: string) => git(dir, 'config', '--get', 'remote.origin.url').trim();

// ── a daemon from before the status script (GitHub#320) ──

/**
 * The daemon as installed before scripts/install-status.sh existed: origin gets a commit without the
 * script and then one that brings it back; the install is a clone reset to the first, so it follows
 * origin/main one fast-forward behind. `branch`: put both commits on that branch instead (origin/main
 * keeps the script) and make the install follow it. `originOld`: on main, origin's main itself stays
 * without the script (an old fork that never caught up). Returns the old commit.
 */
export function installOld(w: DaemonWorld, branch = 'main', o: { originOld?: boolean } = {}): string {
  const tmp = join(w.dir, `old-${++pathSeq}`);
  git(w.dir, 'clone', '-q', w.origin, tmp);
  if (branch !== 'main') git(tmp, 'checkout', '-q', '-b', branch);
  git(tmp, 'rm', '-q', 'scripts/install-status.sh');
  git(tmp, 'commit', '-qm', 'before the status script');
  const old = git(tmp, 'rev-parse', 'HEAD').trim();
  if (branch === 'main' && !o.originOld) git(tmp, 'revert', '--no-edit', 'HEAD');
  else git(tmp, 'commit', '-q', '--allow-empty', '-m', 'still without it');
  git(tmp, 'push', '-q', 'origin', branch);
  installByHand(w);
  if (branch !== 'main') git(w.skill, 'checkout', '-q', '-b', branch, '--track', `origin/${branch}`);
  git(w.skill, 'reset', '-q', '--hard', old);
  return old;
}

/** A copy of the daemon's files without git and without the status script, at `dir`. */
export function plainOldCopy(w: DaemonWorld, dir: string): string {
  mkdirSync(dirname(dir), { recursive: true });
  git(w.dir, 'clone', '-q', w.origin, dir);
  rmSync(join(dir, '.git'), { recursive: true, force: true });
  rmSync(join(dir, 'scripts', 'install-status.sh'));
  return realpathSync(dir);
}
