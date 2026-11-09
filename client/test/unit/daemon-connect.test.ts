// "接上 daemon" from the repository list (GitHub#315): the real back end (Rust,
// child process) connects a repository to the daemon by running the daemon's
// real setup.sh (GitHub#313) in a fake HOME with the fake scheduler. Every case
// reads the result back from the machine — the project's config, the daemon's
// registration, the scheduler's state — not from the back end's word.
//
// Five situations (an existing copy, a clone, a folder of another repository,
// an agent whose program is missing, setup.sh failing), the opposite-dependency
// pair (codex without claude is complete; claude without codex is not), and the
// whole way: install → connect → running → stop → disconnect.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { daemonEnv, daemonWorld, githubRepo, githubRewrite, installByHand, localCopy, originOf, pathFor, type DaemonWorld, type Os } from '../support/daemon-world';
import { tempDir } from './helpers';

const REPO = 'acme/widget'; // what the fake gh answers for `gh repo view` (tests/fixtures/install-fakes.sh)
const open: HarnessBackend[] = [];
let w: DaemonWorld;

beforeEach(() => {
  w = daemonWorld(tempDir());
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
});

function backend(os: Os, path: string, extra: Record<string, string> = {}, pickFolder?: (s: string | null) => string | null) {
  const b = new HarnessBackend({
    db: join(w.dir, `cache-${open.length}.sqlite`),
    endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
    credentials: new MemoryStore(),
    env: daemonEnv(w, { os, path, extra: { ...githubRewrite(w), ...extra } }),
    pickFolder,
  });
  open.push(b);
  return b;
}

/** Start a connect and read its output until it ends; `chunks` are the pieces as the window would get them. */
async function connectAndWait(b: HarnessBackend, args: Record<string, string>) {
  const started = await b.call('daemonConnect', args);
  if (started.result !== 'started') return { started, outcome: null, output: '', chunks: [] as string[] };
  let from = 0;
  let output = '';
  const chunks: string[] = [];
  for (let i = 0; i < 2400; i++) {
    const r = await b.call('daemonConnectPoll', { job: started.job, from });
    expect(r.result).toBe('ok');
    if (r.output) {
      chunks.push(r.output);
      output += r.output;
    }
    from = r.next;
    if (r.done) return { started, outcome: r.outcome, output, chunks };
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('connect did not end');
}

const conf = (key: string) => join(w.home, '.config', 'cavil-loop', `${key}.conf`);
const project = (s: any, key: string) => s.status.projects.find((p: any) => p.key === key);

describe('the dialog\'s facts', () => {
  it('agents come from the daemon\'s own drivers (claude first); a copy below ~/github is found by its origin', async () => {
    installByHand(w);
    githubRepo(w, REPO);
    const mine = localCopy(join(w.home, 'github', 'widget'), 'git@github.com:Acme/Widget.git');
    localCopy(join(w.home, 'github', 'acme', 'other'), 'https://github.com/acme/other.git');
    localCopy(join(w.home, 'code', 'nested', 'deep', 'widget'), 'https://github.com/acme/widget.git'); // too deep: not looked for
    const b = backend('Linux', pathFor(w));
    const i = await b.call('daemonConnectInfo', { repo: REPO });
    expect(i.result).toBe('ok');
    expect(i.agents[0]).toBe('claude');
    expect([...i.agents].sort()).toEqual(['claude', 'codex', 'cursor', 'opencode']);
    expect(i.candidates).toEqual([mine]);
    expect(i.connected).toEqual([]);
    expect(i.clone_parent).toBe(join(w.home, 'github'));
  });

  it('the folder picker is the system\'s (here: the test answers); a cancel is no path', async () => {
    installByHand(w);
    const asked: (string | null)[] = [];
    let answer: string | null = join(w.home);
    const b = backend('Linux', pathFor(w), {}, (s) => (asked.push(s), answer));
    expect(await b.call('daemonPickFolder', { start: w.home })).toEqual({ result: 'ok', path: w.home });
    answer = null;
    expect(await b.call('daemonPickFolder', {})).toEqual({ result: 'ok', path: null });
    // a start that is not an existing absolute folder is not passed on
    await b.call('daemonPickFolder', { start: 'relative/x' });
    expect(asked).toEqual([w.home, null, null]);
  });

  it('only fixed requests: a bad repository name or an agent the daemon does not have runs nothing', async () => {
    installByHand(w);
    const b = backend('Linux', pathFor(w));
    for (const repo of ['', 'a', '../x/y', 'a/b/c', 'a/b;rm']) {
      expect((await b.call('daemonConnectInfo', { repo })).result).toBe('refused');
      expect((await b.call('daemonConnect', { repo, agent: 'claude', cloneInto: w.home })).result).toBe('refused');
    }
    for (const agent of ['nope', '../claude', '_common', 'claude; rm']) {
      expect((await b.call('daemonPrecheck', { agent })).result).toBe('refused');
      expect((await b.call('daemonConnect', { repo: REPO, agent, cloneInto: w.home })).result).toBe('refused');
    }
    expect((await b.call('daemonConnect', { repo: REPO, agent: 'claude' })).output).toContain('要么选一个本地目录');
    expect(existsSync(join(w.sd, 'calls'))).toBe(false);
  });
});

describe('connecting (Linux, systemd)', () => {
  it('an existing copy: setup.sh runs on it, its output comes as it goes, and the project is read back running', async () => {
    installByHand(w);
    githubRepo(w, REPO);
    const host = localCopy(join(w.home, 'github', 'widget'), 'https://github.com/acme/widget.git');
    const b = backend('Linux', pathFor(w));
    expect(await b.call('daemonCheckDir', { repo: REPO, dir: host })).toEqual({ result: 'ok', dir: host, config: null });
    const r = await connectAndWait(b, { repo: REPO, agent: 'claude', dir: host });
    expect(r.started.result).toBe('started');
    expect(r.outcome).toMatchObject({ result: 'connected', key: 'widget', state: 'running', already: false, dir: host });
    // the output came in pieces, setup.sh's own lines among them
    expect(r.chunks.length).toBeGreaterThan(1);
    expect(r.output).toContain('cavil-loop setup');
    expect(r.output).toContain('setup 完成');
    // the machine: registered, config written with the chosen agent, the timer on
    expect(existsSync(conf('widget'))).toBe(true);
    expect(readFileSync(join(host, 'cavil-loop.config'), 'utf8')).toMatch(/^WORKER_AGENT="claude"/m);
    expect(readFileSync(join(w.sd, 'cavil-loop-poll@widget.timer.active'), 'utf8').trim()).toBe('active');
    const s = await b.call('daemonStatus');
    expect(project(s, 'widget')).toMatchObject({ repo: REPO, host, scheduler: { state: 'running' } });
    // the dialog now says it is connected; a second connect of the same folder changes nothing
    expect((await b.call('daemonConnectInfo', { repo: REPO })).connected).toEqual([{ key: 'widget', host, state: 'running' }]);
    const again = await connectAndWait(b, { repo: REPO, agent: 'claude', dir: host });
    expect(again.outcome).toMatchObject({ result: 'connected', already: true, key: 'widget' });
    expect(again.output).not.toContain('cavil-loop setup');
  });

  it('no copy yet: clones https://github.com/<owner>/<name>.git into the chosen folder, then connects it', async () => {
    installByHand(w);
    githubRepo(w, REPO);
    const parent = join(w.home, 'github');
    mkdirSync(parent);
    const b = backend('Linux', pathFor(w));
    expect((await b.call('daemonConnectInfo', { repo: REPO })).candidates).toEqual([]);
    const r = await connectAndWait(b, { repo: REPO, agent: 'claude', cloneInto: parent });
    const host = join(parent, 'widget');
    expect(r.outcome).toMatchObject({ result: 'connected', key: 'widget', state: 'running', dir: realpathSync(host) });
    expect(r.output).toContain('git clone https://github.com/acme/widget.git');
    // the clone's origin is the real address, not the test's rewrite
    expect(originOf(host)).toBe('https://github.com/acme/widget.git');
    expect(readFileSync(join(host, 'README.md'), 'utf8')).toBe('# acme/widget\n');
    expect(project(await b.call('daemonStatus'), 'widget')).toMatchObject({ host: realpathSync(host) });
    // a folder that already has <name> in it is not cloned into
    const twice = await b.call('daemonConnect', { repo: REPO, agent: 'claude', cloneInto: parent });
    expect(twice.result).toBe('refused');
    expect(twice.output).toContain('已经存在');
  });

  it('a clone that fails leaves no folder behind and connects nothing', async () => {
    installByHand(w);
    // no such repository "on github.com"
    const parent = join(w.home, 'github');
    mkdirSync(parent);
    const b = backend('Linux', pathFor(w));
    const r = await connectAndWait(b, { repo: REPO, agent: 'claude', cloneInto: parent });
    expect(r.outcome.result).toBe('failed');
    expect(r.outcome.output).toContain('克隆失败');
    expect(r.output).toMatch(/fatal|does not exist|not found/i);
    expect(existsSync(join(parent, 'widget'))).toBe(false);
    expect(existsSync(conf('widget'))).toBe(false);
  });

  it('a folder of another repository (or not a repository, or inside one) is refused, and setup.sh never runs', async () => {
    installByHand(w);
    const other = localCopy(join(w.home, 'github', 'widget'), 'https://github.com/acme/other.git');
    const plain = join(w.home, 'plain');
    mkdirSync(plain);
    mkdirSync(join(other, 'sub'));
    const noOrigin = localCopy(join(w.home, 'github', 'bare'), null);
    const b = backend('Linux', pathFor(w));
    const cases: [string, string][] = [
      [other, 'origin 是 acme/other，不是 acme/widget'],
      [plain, '不是 git 仓库'],
      [join(other, 'sub'), '要选仓库最上层'],
      [noOrigin, '没有 origin'],
      ['github/widget', '不是完整路径'],
      [join(w.home, 'nope'), '不存在'],
    ];
    for (const [dir, says] of cases) {
      const c = await b.call('daemonCheckDir', { repo: REPO, dir });
      expect(c.result, dir).toBe('refused');
      expect(c.output, dir).toContain(says);
      const r = await b.call('daemonConnect', { repo: REPO, agent: 'claude', dir });
      expect(r.result, dir).toBe('refused');
      expect(r.output, dir).toContain(says);
    }
    expect(existsSync(conf('widget'))).toBe(false);
    expect(existsSync(join(other, 'cavil-loop.config'))).toBe(false);
    expect(existsSync(join(w.sd, 'calls'))).toBe(false);
  });

  it('the chosen agent\'s program is missing: the precheck says so and connecting runs no setup.sh', async () => {
    installByHand(w);
    const host = localCopy(join(w.home, 'github', 'widget'), 'https://github.com/acme/widget.git');
    const b = backend('Linux', pathFor(w, { agents: ['claude'] }));
    const p = await b.call('daemonPrecheck', { agent: 'codex' });
    expect(p).toMatchObject({ result: 'ok', agent: 'codex', ready: false, missing: ['codex'], gh_logged_in: true });
    const r = await connectAndWait(b, { repo: REPO, agent: 'codex', dir: host });
    expect(r.outcome).toMatchObject({ result: 'blocked' });
    expect(r.outcome.output).toContain('缺 codex');
    expect(r.output).not.toContain('cavil-loop setup');
    expect(existsSync(conf('widget'))).toBe(false);
    expect(existsSync(join(host, 'cavil-loop.config'))).toBe(false);
  });

  it('gh not signed in: not ready (setup.sh would stop there), nothing runs', async () => {
    installByHand(w);
    const host = localCopy(join(w.home, 'github', 'widget'), 'https://github.com/acme/widget.git');
    const b = backend('Linux', pathFor(w), { FAKE_GH_AUTH: '1' });
    expect(await b.call('daemonPrecheck', { agent: 'claude' })).toMatchObject({ ready: false, missing: [], gh_logged_in: false });
    const r = await connectAndWait(b, { repo: REPO, agent: 'claude', dir: host });
    expect(r.outcome.result).toBe('blocked');
    expect(r.outcome.output).toContain('gh 没有登录');
    expect(existsSync(conf('widget'))).toBe(false);
  });

  /** A whole project config as setup.sh writes one (from the daemon's own template), left in `host`. */
  function oldConfig(host: string, repo: string, agentLine: string) {
    const t = readFileSync(join(w.skill, 'cavil-loop.config.example'), 'utf8')
      .replace('myorg/myrepo', repo)
      .replace('$HOME/github/myproject', host)
      .replace(/^WORKER_AGENT="claude"$/m, agentLine);
    if (!t.includes(agentLine)) throw new Error('template changed: no WORKER_AGENT line');
    writeFileSync(join(host, 'cavil-loop.config'), t);
  }

  it('a config left in the folder that names another repository: refused at the check and at the start, nothing registered', async () => {
    installByHand(w);
    const host = localCopy(join(w.home, 'github', 'widget'), 'https://github.com/acme/widget.git');
    oldConfig(host, 'acme/other', 'WORKER_AGENT="claude"');
    const b = backend('Linux', pathFor(w));
    const c = await b.call('daemonCheckDir', { repo: REPO, dir: host });
    expect(c.result).toBe('refused');
    expect(c.output).toContain('里面的仓库是 acme/other，不是 acme/widget');
    const r = await connectAndWait(b, { repo: REPO, agent: 'claude', dir: host });
    expect(r.outcome.result).toBe('failed');
    expect(r.outcome.output).toContain('acme/other');
    expect(r.output).not.toContain('cavil-loop setup');
    expect(existsSync(conf('widget'))).toBe(false);
    const s = await b.call('daemonStatus');
    expect(s.status.projects).toEqual([]);
    expect(existsSync(join(w.sd, 'calls'))).toBe(false);
  });

  it('a folder registered for another repository already: not reported as connected, nothing runs again', async () => {
    installByHand(w);
    const host = localCopy(join(w.home, 'github', 'widget'), 'https://github.com/acme/widget.git');
    const path = pathFor(w);
    // registered by hand while its config said acme/other; the config was later edited to acme/widget
    oldConfig(host, 'acme/other', 'WORKER_AGENT="claude"');
    const { spawnSync } = await import('node:child_process');
    const by = spawnSync('bash', [join(w.skill, 'setup.sh'), '--yes', host], { env: { HOME: w.home, PATH: path, FAKE_UNAME: 'Linux', FAKE_SD: w.sd, FAKE_LD: w.ld } });
    expect(by.status).toBe(0);
    const b = backend('Linux', path);
    expect(project(await b.call('daemonStatus'), 'widget').repo).toBe('acme/other');
    oldConfig(host, 'acme/widget', 'WORKER_AGENT="claude"');
    // the status now reads acme/widget from the edited config: that is the daemon's own answer, so it counts as connected
    const r = await connectAndWait(b, { repo: REPO, agent: 'claude', dir: host });
    expect(r.outcome).toMatchObject({ result: 'connected', already: true });
    // but while the config still says acme/other, a connect of acme/widget is refused
    oldConfig(host, 'acme/other', 'WORKER_AGENT="claude"');
    const r2 = await connectAndWait(b, { repo: REPO, agent: 'claude', dir: host });
    expect(r2.outcome.result).toBe('failed');
    expect(r2.outcome.output).toContain('acme/other');
  });

  for (const line of ['export WORKER_AGENT="codex"', 'WORKER_AGENT=codex', 'WORKER_AGENT="${MINE:-codex}"']) {
    it(`a config's agent is what the daemon reads (${line}): the dialog is told codex; claude is refused, codex connects`, async () => {
      installByHand(w);
      const host = localCopy(join(w.home, 'github', 'widget'), 'https://github.com/acme/widget.git');
      oldConfig(host, 'acme/widget', line);
      const b = backend('Linux', pathFor(w, { agents: ['claude', 'codex'] }));
      expect((await b.call('daemonCheckDir', { repo: REPO, dir: host })).config).toEqual({ path: join(host, 'cavil-loop.config'), agent: 'codex' });
      const r = await connectAndWait(b, { repo: REPO, agent: 'claude', dir: host });
      expect(r.outcome.result).toBe('failed');
      expect(r.outcome.output).toContain('agent 是 codex');
      expect(existsSync(conf('widget'))).toBe(false);
      const ok = await connectAndWait(b, { repo: REPO, agent: 'codex', dir: host });
      expect(ok.outcome).toMatchObject({ result: 'connected', key: 'widget', already: false });
      // the daemon runs it with codex, the same as the dialog said
      const p = project(await b.call('daemonStatus'), 'widget');
      expect(p.repo).toBe(REPO);
      expect(p.agents.find((a: any) => a.role === 'worker').agent).toBe('codex');
    });
  }

  it('a config that names this repository and the chosen agent: connects as usual', async () => {
    installByHand(w);
    const host = localCopy(join(w.home, 'github', 'widget'), 'https://github.com/acme/widget.git');
    oldConfig(host, 'acme/widget', 'WORKER_AGENT="claude"');
    const b = backend('Linux', pathFor(w));
    expect((await b.call('daemonCheckDir', { repo: REPO, dir: host })).config).toEqual({ path: join(host, 'cavil-loop.config'), agent: 'claude' });
    const r = await connectAndWait(b, { repo: REPO, agent: 'claude', dir: host });
    expect(r.outcome).toMatchObject({ result: 'connected', key: 'widget' });
    expect(project(await b.call('daemonStatus'), 'widget')).toMatchObject({ repo: REPO, host });
  });

  it('a config the daemon cannot read: refused, nothing registered', async () => {
    installByHand(w);
    const host = localCopy(join(w.home, 'github', 'widget'), 'https://github.com/acme/widget.git');
    writeFileSync(join(host, 'cavil-loop.config'), 'REPO="acme/widget"\nreturn 7\n');
    const b = backend('Linux', pathFor(w));
    const c = await b.call('daemonCheckDir', { repo: REPO, dir: host });
    expect(c.result).toBe('refused');
    expect(c.output).toContain('daemon 读不出');
    const r = await connectAndWait(b, { repo: REPO, agent: 'claude', dir: host });
    expect(r.outcome.result).toBe('failed');
    expect(existsSync(conf('widget'))).toBe(false);
  });
});

describe('the opposite-dependency pair: the precheck agrees with setup.sh', () => {
  it('codex chosen, codex here and claude not: complete, and setup.sh connects it with codex', async () => {
    installByHand(w);
    const host = localCopy(join(w.home, 'github', 'widget'), 'https://github.com/acme/widget.git');
    const b = backend('Linux', pathFor(w, { agents: ['codex'] }));
    const p = await b.call('daemonPrecheck', { agent: 'codex' });
    expect(p).toMatchObject({ ready: true, missing: [], bin: 'codex' });
    const r = await connectAndWait(b, { repo: REPO, agent: 'codex', dir: host });
    expect(r.outcome).toMatchObject({ result: 'connected', key: 'widget' });
    expect(readFileSync(join(host, 'cavil-loop.config'), 'utf8')).toMatch(/^WORKER_AGENT="codex"/m);
    const s = await b.call('daemonStatus');
    expect(project(s, 'widget').deps).toMatchObject({ state: 'ok' });
  });

  it('codex chosen, only claude here: the precheck reports codex missing and nothing is started', async () => {
    installByHand(w);
    const host = localCopy(join(w.home, 'github', 'widget'), 'https://github.com/acme/widget.git');
    const path = pathFor(w, { agents: ['claude'] });
    const b = backend('Linux', path);
    expect(await b.call('daemonPrecheck', { agent: 'codex' })).toMatchObject({ ready: false, missing: ['codex'] });
    // setup.sh itself, run by hand with the same choice, agrees: it stops on the missing codex
    const { spawnSync } = await import('node:child_process');
    const by = spawnSync('bash', [join(w.skill, 'setup.sh'), '--yes', host], { env: { HOME: w.home, PATH: path, WORKER_AGENT: 'codex', FAKE_UNAME: 'Linux', FAKE_SD: w.sd, FAKE_LD: w.ld } });
    expect(by.status).toBe(1);
    expect(String(by.stdout)).toContain('缺少依赖：codex');
  });
});

describe('setup.sh failing (macOS, launchd)', () => {
  it('its own words are kept, the outcome is "failed", and nothing claims the project runs', async () => {
    installByHand(w);
    const host = localCopy(join(w.home, 'github', 'widget'), 'https://github.com/acme/widget.git');
    const b = backend('Darwin', pathFor(w), { FAKE_LD_BOOTSTRAP: 'fail' });
    const r = await connectAndWait(b, { repo: REPO, agent: 'claude', dir: host });
    expect(r.outcome.result).toBe('failed');
    expect(r.outcome.output).toContain('setup.sh 没有成功（退出码 5）');
    expect(r.output).toContain('Bootstrap failed: 5: Input/output error');
    // the job is not loaded (asked of the fake scheduler directly)
    expect(existsSync(join(w.ld, 'dev.luosky.cavil-loop.widget.path'))).toBe(false);
    const p = project(await b.call('daemonStatus'), 'widget');
    expect(p?.scheduler?.state).not.toBe('running');
  });
});

describe('end to end: install → connect → running → stop → disconnect', () => {
  for (const os of ['Linux', 'Darwin'] as Os[]) {
    it(`${os}: every step read back from the machine`, async () => {
      githubRepo(w, REPO);
      const parent = join(w.home, 'github');
      mkdirSync(parent);
      const b = backend(os, pathFor(w));
      // 1. install
      expect((await b.call('daemonStatus')).state).toBe('missing');
      expect((await b.call('daemonInstall')).result).toBe('installed');
      expect(existsSync(join(w.skill, 'setup.sh'))).toBe(true);
      expect((await b.call('daemonStatus')).state).toBe('ok');
      // 2. connect (a clone: nothing is on the machine yet)
      const r = await connectAndWait(b, { repo: REPO, agent: 'claude', cloneInto: parent });
      expect(r.outcome).toMatchObject({ result: 'connected', key: 'widget' });
      // 3. listed, running
      let s = await b.call('daemonStatus');
      expect(project(s, 'widget')).toMatchObject({ repo: REPO, scheduler: { state: 'running' } });
      if (os === 'Linux') expect(readFileSync(join(w.sd, 'cavil-loop-poll@widget.timer.active'), 'utf8').trim()).toBe('active');
      else expect(existsSync(join(w.ld, 'dev.luosky.cavil-loop.widget.path'))).toBe(true);
      // 4. stop
      expect(await b.call('daemonService', { key: 'widget', action: 'stop' })).toMatchObject({ result: 'ok', state: 'stopped' });
      s = await b.call('daemonStatus');
      expect(project(s, 'widget').scheduler.state).toBe('stopped');
      if (os === 'Linux') expect(readFileSync(join(w.sd, 'cavil-loop-poll@widget.timer.active'), 'utf8').trim()).toBe('inactive');
      else expect(existsSync(join(w.ld, 'dev.luosky.cavil-loop.widget.path'))).toBe(false);
      // 5. disconnect: the registration goes, the project's own config stays
      expect((await b.call('daemonDisconnect', { key: 'widget' })).result).toBe('disconnected');
      expect(existsSync(conf('widget'))).toBe(false);
      expect(existsSync(join(parent, 'widget', 'cavil-loop.config'))).toBe(true);
      expect((await b.call('daemonStatus')).status.projects).toEqual([]);
      expect((await b.call('daemonConnectInfo', { repo: REPO })).connected).toEqual([]);
    });
  }
});
