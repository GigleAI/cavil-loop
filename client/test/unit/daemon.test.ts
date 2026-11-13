// "本机 daemon" in settings (GitHub#314): the real back end (Rust, child
// process) runs the daemon's real scripts (GitHub#313) in a fake HOME, against
// the fake scheduler the daemon's own tests use. Every case reads the result
// back from the machine (files, scheduler state), not from the back end's word.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MemoryStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { appendLine, connect, daemonEnv, daemonWorld, dropWorlds, headOf, installByHand, installOld, pathFor, plainOldCopy, pushDaemonChange, wrapTool, type DaemonWorld, type Os } from '../support/daemon-world';
import { tempDir } from './helpers';

const open: HarnessBackend[] = [];
let w: DaemonWorld;

// a fresh daemon world per case: the fake tools, a copy of this checkout's daemon files, a git commit and a
// bare clone — a handful of child processes that a loaded box pushed past vitest's default 10 s hook limit
// (GitHub#413 code review round 1)
beforeEach(() => {
  w = daemonWorld(tempDir());
}, 30_000);
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
  dropWorlds();
});

function backend(os: Os, path: string, extra?: Record<string, string>, opened?: string[]) {
  const b = new HarnessBackend({
    db: join(w.dir, `cache-${open.length}.sqlite`),
    // nothing here talks to GitHub; the back end only insists the address is loopback
    endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
    credentials: new MemoryStore(),
    env: daemonEnv(w, { os, path, extra }),
    opened,
  });
  open.push(b);
  return b;
}

const sched = (b: any, key: string) => b.status.projects.find((p: any) => p.key === key)?.scheduler?.state;

describe('status', () => {
  it('not installed: says so, and the status script is not needed for that', async () => {
    const b = backend('Darwin', pathFor(w));
    const s = await b.call('daemonStatus');
    expect(s).toEqual({ state: 'missing', entry: w.skill });
  });

  it('installed, nothing connected: the daemon, gh, and the common tools, as the status script reports them', async () => {
    installByHand(w);
    const s = await backend('Darwin', pathFor(w)).call('daemonStatus');
    expect(s.state).toBe('ok');
    expect(s.status.daemon).toMatchObject({ form: 'checkout', version: headOf(w.skill) });
    expect(s.status.gh).toEqual({ installed: true, logged_in: true });
    expect(s.status.base_deps.missing).toEqual([]);
    expect(s.status.projects).toEqual([]);
  });

  it('a missing tool and a gh that is not signed in come through as such', async () => {
    installByHand(w);
    const s = await backend('Darwin', pathFor(w, { missing: ['tmux', 'flock'] }), { FAKE_GH_AUTH: '1' }).call('daemonStatus');
    expect(s.state).toBe('ok');
    expect(s.status.base_deps.missing).toEqual(['tmux', 'flock']);
    expect(s.status.gh).toEqual({ installed: true, logged_in: false });
  });

  it('jq missing: still "unreadable" (no projects, no states), but the common tools are checked and listed', async () => {
    installByHand(w);
    const s = await backend('Darwin', pathFor(w, { missing: ['jq', 'tmux'] })).call('daemonStatus');
    expect(s.state).toBe('unreadable');
    expect(s.reason).toContain('缺 jq');
    expect(s.precheck).toEqual({ os: 'Darwin', base_deps: { missing: ['tmux', 'jq'] } });
    expect(s.status).toBeUndefined();
  });

  it('the status script failing otherwise is "unreadable" with its words and no checklist, never "not installed" or "fine"', async () => {
    installByHand(w);
    writeFileSync(join(w.skill, 'scripts', 'install-status.sh'), '#!/usr/bin/env bash\necho "boom" >&2\nexit 5\n');
    const s = await backend('Darwin', pathFor(w)).call('daemonStatus');
    expect(s.state).toBe('unreadable');
    expect(s.reason).toContain('退出码 5');
    expect(s.reason).toContain('boom');
    expect(s.precheck).toBeUndefined();
  });

  it('a daemon from before the status script: unreadable, says it is too old, and what kind of install it is', async () => {
    installOld(w);
    const s = await backend('Darwin', pathFor(w)).call('daemonStatus');
    expect(s.state).toBe('unreadable');
    expect(s.reason).toContain('版本太旧');
    expect(s.outdated).toEqual({ form: 'checkout', target: realpathSync(w.skill) });
  });

  it('the scripts never see the environment of the client', async () => {
    installByHand(w);
    // a script that reports what it was given, in place of the status script
    writeFileSync(join(w.skill, 'scripts', 'install-status.sh'), `#!/usr/bin/env bash\njq -n --arg e "$(env | sort)" '{version:1, projects:[], env:$e}'\n`);
    process.env.GH_TOKEN = 'ghp_must_not_reach_the_daemon_000000000';
    try {
      const s = await backend('Darwin', pathFor(w)).call('daemonStatus');
      expect(s.state).toBe('ok');
      const env: string = s.status.env;
      expect(env).not.toContain('ghp_must_not_reach');
      expect(env).not.toContain('CAVIL_CLIENT_TEST');
      expect(env).toContain(`HOME=${w.home}\n`);
    } finally {
      delete process.env.GH_TOKEN;
    }
  });
});

describe('install', () => {
  it('clones the daemon into ~/.agents/skills and links it for Claude Code, as the README does', async () => {
    const b = backend('Darwin', pathFor(w));
    const r = await b.call('daemonInstall');
    expect(r.result).toBe('installed');
    expect(headOf(w.skill)).toBe(headOf(w.origin));
    const link = join(w.home, '.claude', 'skills', 'cavil-loop');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(w.skill);
    expect((await b.call('daemonStatus')).state).toBe('ok');
  });

  it('an existing install is kept as it is', async () => {
    installByHand(w);
    writeFileSync(join(w.skill, 'mine.txt'), 'local');
    const r = await backend('Darwin', pathFor(w)).call('daemonInstall');
    expect(r.result).toBe('existing');
    expect(readFileSync(join(w.skill, 'mine.txt'), 'utf8')).toBe('local');
    expect(existsSync(join(w.home, '.claude', 'skills', 'cavil-loop'))).toBe(false);
  });

  it('a clone that fails leaves nothing that looks installed', async () => {
    const b = new HarnessBackend({
      db: join(w.dir, 'c.sqlite'),
      endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
      credentials: new MemoryStore(),
      env: { ...daemonEnv(w, { os: 'Darwin', path: pathFor(w) }), CAVIL_CLIENT_TEST_DAEMON_CLONE: join(w.dir, 'nowhere.git') },
    });
    open.push(b);
    const r = await b.call('daemonInstall');
    expect(r.result).toBe('failed');
    expect(r.output).toContain('nowhere.git');
    expect((await b.call('daemonStatus')).state).toBe('missing');
  });
});

describe('connected projects (Linux, systemd)', () => {
  it('lists them; stop and start act on the timer and are read back; disconnect keeps the project config', async () => {
    installByHand(w);
    const path = pathFor(w);
    const host = connect(w, 'widget', 'Linux', path);
    const b = backend('Linux', path);
    let s = await b.call('daemonStatus');
    const p = s.status.projects.find((x: any) => x.key === 'widget');
    expect(p).toMatchObject({ key: 'widget', repo: 'acme/widget', host, deps: { state: 'ok' } });
    expect(sched(s, 'widget')).toBe('running');

    // "start" on a running one is refused before anything runs
    const calls = () => readFileSync(join(w.sd, 'calls'), 'utf8');
    const before = calls();
    expect((await b.call('daemonService', { key: 'widget', action: 'start' })).result).toBe('refused');
    expect(calls().split('\n').filter((l) => /^--user (start|stop) /.test(l))).toEqual(before.split('\n').filter((l) => /^--user (start|stop) /.test(l)));

    const stop = await b.call('daemonService', { key: 'widget', action: 'stop' });
    expect(stop).toMatchObject({ result: 'ok', state: 'stopped' });
    expect(readFileSync(join(w.sd, 'cavil-loop-poll@widget.timer.active'), 'utf8').trim()).toBe('inactive');
    s = await b.call('daemonStatus');
    expect(sched(s, 'widget')).toBe('stopped');

    const start = await b.call('daemonService', { key: 'widget', action: 'start' });
    expect(start).toMatchObject({ result: 'ok', state: 'running' });
    expect(readFileSync(join(w.sd, 'cavil-loop-poll@widget.timer.active'), 'utf8').trim()).toBe('active');

    const d = await b.call('daemonDisconnect', { key: 'widget' });
    expect(d.result).toBe('disconnected');
    expect(existsSync(join(w.home, '.config', 'cavil-loop', 'widget.conf'))).toBe(false);
    expect(existsSync(join(host, 'cavil-loop.config'))).toBe(true);
    expect((await b.call('daemonStatus')).status.projects).toEqual([]);
  });

  it('a scheduler that cannot be read: the state is "unknown", and neither stop nor start runs', async () => {
    installByHand(w);
    const path = pathFor(w);
    connect(w, 'widget', 'Linux', path);
    const b = backend('Linux', path, { FAKE_SD_MODE: 'fail' });
    expect(sched(await b.call('daemonStatus'), 'widget')).toBe('unknown');
    const n = readFileSync(join(w.sd, 'calls'), 'utf8').split('\n').length;
    for (const action of ['stop', 'start']) {
      const r = await b.call('daemonService', { key: 'widget', action });
      expect(r.result).toBe('refused');
      expect(r.output).toContain('读不到');
    }
    const after = readFileSync(join(w.sd, 'calls'), 'utf8').split('\n');
    expect(after.slice(n - 1).filter((l) => /^--user (start|stop) /.test(l))).toEqual([]);
    // disconnect: the script itself reads first and touches nothing
    const d = await b.call('daemonDisconnect', { key: 'widget' });
    expect(d.result).toBe('unknown');
    expect(existsSync(join(w.home, '.config', 'cavil-loop', 'widget.conf'))).toBe(true);
  });

  it('only fixed requests: a bad key, an unknown project or an unknown action runs nothing', async () => {
    installByHand(w);
    const b = backend('Linux', pathFor(w));
    for (const key of ['../x', 'a b', 'deploy', '']) {
      expect((await b.call('daemonService', { key, action: 'stop' })).result).toBe('refused');
      expect((await b.call('daemonDisconnect', { key })).result).toBe('refused');
      expect((await b.call('daemonOpen', { key, what: 'log' })).result).toBe('refused');
    }
    expect((await b.call('daemonService', { key: 'nope', action: 'stop' })).output).toContain('没有接入项目');
    expect((await b.call('daemonService', { key: 'nope', action: 'rm -rf' })).output).toBe('未知操作');
    expect(existsSync(join(w.sd, 'calls'))).toBe(false);
  });

  it('opens the log and the config the status script names, nothing else', async () => {
    installByHand(w);
    const path = pathFor(w);
    const host = connect(w, 'widget', 'Linux', path);
    const opened: string[] = [];
    const b = backend('Linux', path, undefined, opened);
    const s = await b.call('daemonStatus');
    const p = s.status.projects[0];
    writeFileSync(join(p.state_dir, 'poll.log'), 'x\n');
    expect((await b.call('daemonOpen', { key: 'widget', what: 'config' })).result).toBe('ok');
    expect((await b.call('daemonOpen', { key: 'widget', what: 'log' })).result).toBe('ok');
    expect((await b.call('daemonOpen', { key: 'widget', what: '/etc/passwd' })).result).toBe('refused');
    expect(opened).toEqual([`file:config:${join(host, 'cavil-loop.config')}`, `file:log:${join(p.state_dir, 'poll.log')}`]);
  });
});

describe('update (a git checkout on macOS)', () => {
  it('fast-forwards, then refreshes every Mac project; one that fails shows its own words and the others go on', async () => {
    installByHand(w);
    const path = pathFor(w);
    connect(w, 'widgeta', 'Darwin', path);
    connect(w, 'widgetb', 'Darwin', path);
    const plist = (k: string) => join(w.home, 'Library', 'LaunchAgents', `dev.luosky.cavil-loop.${k}.plist`);
    const oldB = readFileSync(plist('widgetb'), 'utf8');
    // the template changes upstream: every project's plist differs now
    const head = pushDaemonChange(w, (d) => appendLine(join(d, 'launchd', 'dev.luosky.cavil-loop.plist.template'), '<dict>', '    <!-- v2 {{KEY}} -->'));
    // launchd refuses widgetb's new file (and only that)
    const b = backend('Darwin', path, { FAKE_LD_REJECT: 'v2 widgetb' });
    const r = await b.call('daemonUpdate');
    expect(r.result).toBe('updated');
    expect(r.after).toBe(head);
    expect(headOf(w.skill)).toBe(head);
    const byKey = Object.fromEntries(r.refresh.map((x: any) => [x.key, x]));
    expect(Object.keys(byKey).sort()).toEqual(['widgeta', 'widgetb']);
    expect(byKey.widgeta.result).toBe('replaced');
    expect(readFileSync(plist('widgeta'), 'utf8')).toContain('v2 widgeta');
    expect(byKey.widgetb.result).toBe('failed');
    expect(byKey.widgetb.output).toContain('Bootstrap failed');
    // widgetb is back as it was, and loaded
    expect(readFileSync(plist('widgetb'), 'utf8')).toBe(oldB);
    expect(sched(await b.call('daemonStatus'), 'widgetb')).toBe('running');
  });

  it('a refresh that stops half-way (no final result) is "unconfirmed" with its words, never "restored"', async () => {
    installByHand(w);
    const path = pathFor(w);
    connect(w, 'widgeta', 'Darwin', path);
    pushDaemonChange(w, (d) => appendLine(join(d, 'launchd', 'dev.luosky.cavil-loop.plist.template'), '<dict>', '    <!-- v2 {{KEY}} -->'));
    // launchd refuses the new file, then the restore cannot even make its temporary file
    wrapTool(path, 'mktemp', 'case "$*" in *.restore.*) echo "mktemp: recovery file: No space left on device" >&2; exit 1;; esac\nexec "$REAL" "$@"');
    const b = backend('Darwin', path, { FAKE_LD_REJECT: 'v2 widgeta' });
    const r = await b.call('daemonUpdate');
    expect(r.result).toBe('updated');
    expect(r.refresh).toHaveLength(1);
    expect(r.refresh[0].result).toBe('unconfirmed');
    expect(r.refresh[0].output).toContain('没有给出最终结果');
    expect(r.refresh[0].output).toContain('No space left on device');
    expect(r.refresh[0].output).toContain('Bootstrap failed');
    // and indeed: the job is not back, the new file is still there — which "failed" (= restored) would have hidden
    expect(sched(await b.call('daemonStatus'), 'widgeta')).toBe('stopped');
  });

  it('the job cannot be read after unloading and loading it back fails: "needs a person", never "restored"', async () => {
    installByHand(w);
    const path = pathFor(w);
    connect(w, 'widgeta', 'Darwin', path);
    pushDaemonChange(w, (d) => appendLine(join(d, 'launchd', 'dev.luosky.cavil-loop.plist.template'), '<dict>', '    <!-- v2 {{KEY}} -->'));
    wrapTool(path, 'launchctl', 'if [ "${1:-}" = print ] && [ -f "$FAKE_LD/after-bootout" ]; then echo "launchctl: connection unavailable" >&2; exit 1; fi\n[ "${1:-}" = bootout ] && touch "$FAKE_LD/after-bootout"\nexec "$REAL" "$@"');
    const b = backend('Darwin', path, { FAKE_LD_BOOTSTRAP: 'fail' });
    const r = await b.call('daemonUpdate');
    expect(r.refresh).toHaveLength(1);
    expect(r.refresh[0].result).toBe('needs_human');
    expect(r.refresh[0].output).toContain('connection unavailable');
    // the job really is gone (asked of the fake scheduler directly)
    expect(existsSync(join(w.ld, 'dev.luosky.cavil-loop.widgeta.path'))).toBe(false);
  });

  it('local changes or a diverged branch stop it with git\'s words; nothing moves', async () => {
    installByHand(w);
    const b = backend('Darwin', pathFor(w));
    pushDaemonChange(w, (d) => appendLine(join(d, 'README.md'), '# ', 'upstream'));
    const was = headOf(w.skill);
    writeFileSync(join(w.skill, 'setup.sh'), readFileSync(join(w.skill, 'setup.sh'), 'utf8') + '\n# mine\n');
    let r = await b.call('daemonUpdate');
    expect(r.result).toBe('blocked');
    expect(r.output).toContain('setup.sh');
    expect(headOf(w.skill)).toBe(was);
    // committed locally: diverged, no fast-forward
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['-C', w.skill, '-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-qam', 'mine']);
    const mine = headOf(w.skill);
    r = await b.call('daemonUpdate');
    expect(r.result).toBe('blocked');
    expect(r.step).toContain('不能快进');
    expect(headOf(w.skill)).toBe(mine);
  });

  it('a remote that is not on github.com is not fetched from', async () => {
    installByHand(w);
    const b = new HarnessBackend({
      db: join(w.dir, 'c.sqlite'),
      endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
      credentials: new MemoryStore(),
      // the local origin is not the configured source this time
      env: { ...daemonEnv(w, { os: 'Darwin', path: pathFor(w) }), CAVIL_CLIENT_TEST_DAEMON_CLONE: join(w.dir, 'elsewhere.git') },
    });
    open.push(b);
    const r = await b.call('daemonUpdate');
    expect(r.result).toBe('blocked');
    expect(r.step).toContain('github.com');
  });
});

// GitHub#320: a daemon from before the status script. The back end judges the kind of install on its
// own; only a git checkout is updated, with the same fast-forward as above.
describe('a daemon from before the status script', () => {
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@x', '-c', 'user.name=t', ...a]).toString().trim();
  /** everything under `dir`, names and contents, to show nothing was touched */
  const snapshot = (dir: string): string => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n);
        const st = lstatSync(p);
        if (st.isDirectory()) walk(p);
        else out.push(`${p}:${st.isSymbolicLink() ? readlinkSync(p) : readFileSync(p, 'utf8').length}`);
      }
    };
    walk(dir);
    return out.join('\n');
  };

  it('a checkout: "更新 daemon" fast-forwards it to a version with the status script, then the status reads and Mac projects are refreshed', async () => {
    installByHand(w);
    const path = pathFor(w);
    connect(w, 'widgeta', 'Darwin', path);
    const old = (() => {
      // the install goes back to before the script, origin keeps a newer main with it
      rmSync(w.skill, { recursive: true, force: true });
      return installOld(w);
    })();
    const head = git(w.origin, 'rev-parse', 'main');
    const b = backend('Darwin', path);
    expect((await b.call('daemonStatus')).outdated.form).toBe('checkout');
    const r = await b.call('daemonUpdate');
    expect(r.result).toBe('updated');
    expect(r.before).toBe(old);
    expect(r.after).toBe(head);
    expect(headOf(w.skill)).toBe(head);
    expect(existsSync(join(w.skill, 'scripts', 'install-status.sh'))).toBe(true);
    // the Mac project's plist went through the daemon's own refresh, as in a normal update
    expect(r.refresh.map((x: any) => x.key)).toEqual(['widgeta']);
    expect(r.refresh[0].result).not.toBe('unconfirmed');
    const s = await b.call('daemonStatus');
    expect(s.state).toBe('ok');
    expect(s.status.daemon.version).toBe(head);
    expect(s.status.projects.map((p: any) => p.key)).toEqual(['widgeta']);
  });

  it('a checkout with local changes, a diverged commit or a remote not on github.com: stopped with git\'s words, nothing moves', async () => {
    const old = installOld(w);
    const b = backend('Darwin', pathFor(w));
    writeFileSync(join(w.skill, 'setup.sh'), readFileSync(join(w.skill, 'setup.sh'), 'utf8') + '\n# mine\n');
    let r = await b.call('daemonUpdate');
    expect(r.result).toBe('blocked');
    expect(r.output).toContain('setup.sh');
    expect(headOf(w.skill)).toBe(old);
    git(w.skill, 'commit', '-qam', 'mine');
    const mine = headOf(w.skill);
    r = await b.call('daemonUpdate');
    expect(r.result).toBe('blocked');
    expect(r.step).toContain('不能快进');
    expect(headOf(w.skill)).toBe(mine);
    expect(existsSync(join(w.skill, 'scripts', 'install-status.sh'))).toBe(false);

    const b2 = new HarnessBackend({
      db: join(w.dir, 'c2.sqlite'),
      endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
      credentials: new MemoryStore(),
      env: { ...daemonEnv(w, { os: 'Darwin', path: pathFor(w) }), CAVIL_CLIENT_TEST_DAEMON_CLONE: join(w.dir, 'elsewhere.git') },
    });
    open.push(b2);
    git(w.skill, 'reset', '-q', '--hard', old);
    r = await b2.call('daemonUpdate');
    expect(r.result).toBe('blocked');
    expect(r.step).toContain('github.com');
    expect(headOf(w.skill)).toBe(old);
  });

  it('pulled, but the branch it follows still has no status script: says so with the branch, never "updated"', async () => {
    const old = installOld(w, 'oldline');
    const b = backend('Darwin', pathFor(w));
    const r = await b.call('daemonUpdate');
    expect(r.result).toBe('still_old');
    expect(r.branch).toBe('oldline');
    expect(r.before).toBe(old);
    expect(r.after).not.toBe(old);
    expect(r.refresh).toEqual([]);
    expect((await b.call('daemonStatus')).state).toBe('unreadable');
  });

  it('a plain folder, directly or through a link: "directory"; update is refused and touches nothing', async () => {
    plainOldCopy(w, w.skill);
    const b = backend('Darwin', pathFor(w));
    let s = await b.call('daemonStatus');
    expect(s.outdated).toEqual({ form: 'directory', target: realpathSync(w.skill) });
    let before = snapshot(w.skill);
    let r = await b.call('daemonUpdate');
    expect(r.result).toBe('refused');
    expect(r.output).toContain('更新不了');
    expect(snapshot(w.skill)).toBe(before);

    rmSync(w.skill, { recursive: true, force: true });
    const target = plainOldCopy(w, join(w.dir, 'elsewhere', 'daemon'));
    symlinkSync(target, w.skill);
    s = await b.call('daemonStatus');
    expect(s.outdated).toEqual({ form: 'directory', target });
    before = snapshot(target);
    r = await b.call('daemonUpdate');
    expect(r.result).toBe('refused');
    expect(snapshot(target)).toBe(before);
  });

  it('a managed release: "managed"; update is refused and touches nothing', async () => {
    const rel = plainOldCopy(w, join(w.home, '.agents', 'releases', 'cavil-loop', 'releases', 'abc123'));
    mkdirSync(dirname(w.skill), { recursive: true });
    symlinkSync(rel, w.skill);
    const b = backend('Linux', pathFor(w));
    expect((await b.call('daemonStatus')).outdated).toEqual({ form: 'managed', target: rel });
    const before = snapshot(rel);
    const r = await b.call('daemonUpdate');
    expect(r.result).toBe('refused');
    expect(r.output).toContain('受管安装');
    expect(snapshot(rel)).toBe(before);
  });

  it('cannot tell: git missing, git failing, the folder unreadable — "unknown" with the error; update runs nothing', async () => {
    const old = installOld(w);
    // git missing (the folder has .git, so git has to confirm it)
    let b = backend('Darwin', pathFor(w, { missing: ['git'] }));
    let s = await b.call('daemonStatus');
    expect(s.outdated.form).toBe('unknown');
    expect(s.outdated.error).toContain('找不到 git');
    let r = await b.call('daemonUpdate');
    expect(r.result).toBe('refused');
    expect(r.output).toContain('找不到 git');

    // git failing: every call is recorded, so "runs nothing" is shown by the record
    const path = pathFor(w);
    const calls = join(w.dir, 'git-calls');
    wrapTool(path, 'git', `echo "$*" >> ${JSON.stringify(calls)}\necho "fatal: simulated failure" >&2\nexit 128`);
    b = backend('Darwin', path);
    s = await b.call('daemonStatus');
    expect(s.outdated.form).toBe('unknown');
    expect(s.outdated.error).toContain('simulated failure');
    r = await b.call('daemonUpdate');
    expect(r.result).toBe('refused');
    // the only git calls were the two judgements (status, update), no status / fetch / merge
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([`-C ${realpathSync(w.skill)} rev-parse --is-inside-work-tree`, `-C ${realpathSync(w.skill)} rev-parse --is-inside-work-tree`]);
    expect(headOf(w.skill)).toBe(old);

    // the folder itself cannot be read: whether a .git is in it is not known
    rmSync(w.skill, { recursive: true, force: true });
    plainOldCopy(w, w.skill);
    b = backend('Darwin', pathFor(w));
    chmodSync(w.skill, 0o000);
    try {
      s = await b.call('daemonStatus');
      expect(s.outdated.form).toBe('unknown');
      expect(s.outdated.error).toContain('.git');
      r = await b.call('daemonUpdate');
      expect(r.result).toBe('refused');
    } finally {
      chmodSync(w.skill, 0o755);
    }
  });

  it('on a normal install the back end\'s own judgement matches the status script\'s (checkout, worktree, managed, plain folder)', async () => {
    const b = backend('Linux', pathFor(w));
    const both = async (): Promise<[string, string]> => {
      const s = await b.call('daemonStatus');
      expect(s.state).toBe('ok');
      const script = s.status.daemon.form;
      const target = s.status.daemon.target ?? w.skill;
      rmSync(join(target, 'scripts', 'install-status.sh'));
      const t = await b.call('daemonStatus');
      return [script, t.outdated.form];
    };
    const forms: string[] = [];
    const reset = () => rmSync(w.skill, { recursive: true, force: true });

    installByHand(w);
    let [a, o] = await both();
    expect(o).toBe(a);
    forms.push(a);

    reset();
    const main = join(w.dir, 'wt-main');
    execFileSync('git', ['clone', '-q', w.origin, main]);
    git(main, 'worktree', 'add', '-q', '-b', 'wt', join(w.dir, 'wt'));
    mkdirSync(dirname(w.skill), { recursive: true });
    symlinkSync(join(w.dir, 'wt'), w.skill);
    [a, o] = await both();
    expect(o).toBe(a);
    forms.push(a);

    reset();
    const rel = join(w.home, '.agents', 'releases', 'cavil-loop', 'releases', 'def456');
    mkdirSync(dirname(rel), { recursive: true });
    execFileSync('git', ['clone', '-q', w.origin, rel]);
    rmSync(join(rel, '.git'), { recursive: true, force: true });
    symlinkSync(rel, w.skill);
    [a, o] = await both();
    expect(o).toBe(a);
    forms.push(a);

    reset();
    const plain = join(w.dir, 'plain');
    execFileSync('git', ['clone', '-q', w.origin, plain]);
    rmSync(join(plain, '.git'), { recursive: true, force: true });
    symlinkSync(plain, w.skill);
    [a, o] = await both();
    expect(o).toBe(a);
    forms.push(a);

    // each kind really was covered
    expect(forms).toEqual(['checkout', 'checkout', 'managed', 'directory']);
  });
});
