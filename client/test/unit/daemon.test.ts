// "本机 daemon" in settings (GitHub#314): the real back end (Rust, child
// process) runs the daemon's real scripts (GitHub#313) in a fake HOME, against
// the fake scheduler the daemon's own tests use. Every case reads the result
// back from the machine (files, scheduler state), not from the back end's word.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { appendLine, connect, daemonEnv, daemonWorld, headOf, installByHand, pathFor, pushDaemonChange, wrapTool, type DaemonWorld, type Os } from '../support/daemon-world';
import { tempDir } from './helpers';

const open: HarnessBackend[] = [];
let w: DaemonWorld;

beforeEach(() => {
  w = daemonWorld(tempDir());
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
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

  it('a daemon from before the status script: unreadable, with what to do', async () => {
    installByHand(w);
    const { rmSync } = await import('node:fs');
    rmSync(join(w.skill, 'scripts', 'install-status.sh'));
    const s = await backend('Darwin', pathFor(w)).call('daemonStatus');
    expect(s.state).toBe('unreadable');
    expect(s.reason).toContain('git -C');
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
