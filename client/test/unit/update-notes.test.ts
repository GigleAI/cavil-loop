// What the versions in between changed (GitHub#348): `cavil_core::update::notes` (Rust, driven
// through the test harness) on GitHub's real release list, and the publisher's side
// (scripts/dev-release.mjs) writing the release page the app then reads.
//
// The recorded list (test/fixtures/update-notes/releases-recorded.json) is GitHub's answer for this
// repository at the time in its `recorded_at`, values untouched (client tags only, the fields the
// app reads). At that moment 0.5.1-dev.444's page had just been cleaned away (only the newest ten
// development builds are kept): it was still listed 12 minutes earlier, when the proposal on
// GitHub#348 was written. `WITH_444` puts that one entry back, from what was read then (tag, time,
// first line; the second paragraph is the same sentence every development build carries).

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore } from '../support/credentials';
import { HarnessBackend } from '../support/harness';
import { NOTES_HEADING, addedNotes, buildNotes, composeBody, previousBuildCommit, untoldCommits } from '../../scripts/dev-release.mjs';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtures = join(root, 'test', 'fixtures', 'update-notes');
const RECORDED: any[] = JSON.parse(readFileSync(join(fixtures, 'releases-recorded.json'), 'utf8')).releases;
const TAIL = '只有在客户端设置里把「更新渠道」选成「开发版」的 App 会自动装它；可能不稳定。正式版见不带 -dev 的 client/v… 发版。';
const R444 = {
  tag_name: 'client/v0.5.1-dev.444',
  draft: false,
  prerelease: true,
  published_at: '2026-11-09T12:06:26Z',
  target_commitish: '51f4b8f406d36d964f446278812d5b414db00f3a',
  body: `开发版 0.5.1-dev.444，构建自 main 的 51f4b8f406d36d964f446278812d5b414db00f3a：docs: show the logo at the top of both READMEs, add a social preview card (#310) (#312)\n\n${TAIL}`,
  assets: [],
};
/** the list as it was while 444 was still there and 462 was the newest */
const WITH_444 = [...RECORDED.filter((r) => r.tag_name !== 'client/v0.5.1-dev.465'), R444];

const open: HarnessBackend[] = [];
afterEach(async () => {
  for (const b of open.splice(0)) await b.close();
});
function harness() {
  const dir = tempDir();
  const b = new HarnessBackend({ db: join(dir, 'cache.sqlite'), endpoints: { api: 'http://127.0.0.1:9/api', web: 'http://127.0.0.1:9/web' }, credentials: new FileStore(join(dir, 'cred')) });
  open.push(b);
  return b;
}
const notes = async (list: unknown[], current: string, to: string, channel = 'dev') => (await harness().call('test.update.notes', { pages: [list], current, to, channel })) as any;
const titles = (n: any) => n.entries.map((e: any) => [e.version, e.items.map((i: any) => i.title)]);

const rel = (v: string, body: string, o: Record<string, unknown> = {}) => ({ tag_name: `client/v${v}`, draft: false, prerelease: v.includes('-'), published_at: '2026-11-01T00:00:00Z', body, assets: [], ...o });
const devBody = (v: string, title: string) => `开发版 ${v}，构建自 main 的 ${'a'.repeat(40)}：${title}\n\n${TAIL}`;

describe('GitHub#348: what the versions in between changed, from the real release list', () => {
  it('0.5.1-dev.444 → 0.5.1-dev.462 while 444 was still listed: exactly the nine versions, newest first, each with its own commit title, complete', async () => {
    const n = await notes(WITH_444, '0.5.1-dev.444', '0.5.1-dev.462');
    expect(n).toMatchObject({ from: '0.5.1-dev.444', to: '0.5.1-dev.462', complete: true, more: 0 });
    expect(titles(n)).toEqual([
      ['0.5.1-dev.462', ["feat(client): a restart comes back at the window's size and place (#333) (#334)"]],
      ['0.5.1-dev.456', ["feat(client): read a notified item's detail ahead of the click (#328) (#331)"]],
      ['0.5.1-dev.455', ['fix(client): show full-read and last-check times apart; no timed round right behind a slow one (#324) (#330)']],
      ['0.5.1-dev.454', ["feat(client): the board's red result bar can be closed and goes once its change is over (#323) (#327)"]],
      ['0.5.1-dev.453', ['feat(client): reply card takes a click anywhere into the box; R works from inside the discussion (#322) (#325)']],
      ['0.5.1-dev.452', ["fix(client): the release gate's test copy sees the rest of the repository (#309) (#326)"]],
      ['0.5.1-dev.451', ['feat(client): update a daemon from before the status script from settings (#320) (#321)']],
      ['0.5.1-dev.449', ['feat(client): connect a repository to the local daemon from the source list (#315) (#319)']],
      ['0.5.1-dev.448', ['feat(client): settings "本机 daemon" — check, install, projects, stop / start / disconnect, update (#314) (#318)']],
    ]);
    // every title is the one in that very release's own page
    for (const e of n.entries) {
      const body = WITH_444.find((r) => r.tag_name === `client/v${e.version}`).body as string;
      expect(body.split('\n')[0].endsWith(`：${e.items[0].title}`), e.version).toBe(true);
      expect(e.items[0].more).toBeNull();
      expect(e.at).toBe(WITH_444.find((r) => r.tag_name === `client/v${e.version}`).published_at);
    }
  });

  it('the list as recorded (444 cleaned away, 465 out): the same nine up to 462 but "may be incomplete"; up to 465 is ten', async () => {
    const n = await notes(RECORDED, '0.5.1-dev.444', '0.5.1-dev.462');
    expect(n.entries.map((e: any) => e.version)).toEqual(['462', '456', '455', '454', '453', '452', '451', '449', '448'].map((x) => `0.5.1-dev.${x}`));
    expect(n.complete).toBe(false);
    const all = await notes(RECORDED, '0.5.1-dev.444', '0.5.1-dev.465');
    expect(all.entries).toHaveLength(10);
    expect(all.entries[0].version).toBe('0.5.1-dev.465');
    expect(all.complete).toBe(false);
    // a running version whose page is still there: complete, and it is not listed itself
    const from448 = await notes(RECORDED, '0.5.1-dev.448', '0.5.1-dev.465');
    expect(from448.complete).toBe(true);
    expect(from448.entries).toHaveLength(9);
    expect(from448.entries.at(-1).version).toBe('0.5.1-dev.449');
  });

  it('only the chosen channel: the release channel lists no development build; nothing in range → nothing to list', async () => {
    const list = [rel('0.5.1', '### 这一版（0.5）\n\n- **甲**：一\n'), ...RECORDED, rel('0.5.0', '')];
    const stable = await notes(list, '0.5.0', '0.5.1', 'stable');
    expect(titles(stable)).toEqual([['0.5.1', ['甲']]]);
    const dev = await notes(list, '0.5.0', '0.5.1', 'dev');
    expect(dev.entries).toHaveLength(11);
    expect(dev.entries[0].version).toBe('0.5.1');
    expect(dev.entries[1].version).toBe('0.5.1-dev.465');
    expect(await notes(RECORDED, '0.5.1-dev.465', '0.5.1-dev.465')).toBeNull();
    expect(await notes(RECORDED, '0.5.1-dev.444', 'not-a-version')).toBeNull();
    expect(await notes(RECORDED, 'not-a-version', '0.5.1-dev.465')).toBeNull();
    // drafts, a development version not marked pre-release and other tags are not versions this app installs
    const odd = [rel('0.5.1-dev.3', devBody('0.5.1-dev.3', 'c')), rel('0.5.1-dev.2', devBody('0.5.1-dev.2', 'b'), { draft: true }), rel('0.5.1-dev.1', devBody('0.5.1-dev.1', 'a'), { prerelease: false }), { ...rel('9.9.9', 'x'), tag_name: 'release/v9.9.9' }];
    expect(titles(await notes(odd, '0.5.0', '0.5.1-dev.3'))).toEqual([['0.5.1-dev.3', ['c']]]);
  });
});

describe('GitHub#348: reading one release page', () => {
  it('notes under the heading: bold title (with the bracket behind it) and the description apart, plain text; a line without bold is a title alone', async () => {
    const body = `${devBody('0.5.1-dev.2', 'feat(client): x (#1)')}\n\n${NOTES_HEADING}\n\n- **标题一**（GitHub#12）：说明里有 \`代码\` 和 **粗体**。\n- **只有标题**\n- 没有粗体的一行\n\n### 别的小节\n\n- 不算\n`;
    const n = await notes([rel('0.5.1-dev.2', body), rel('0.5.1-dev.1', '')], '0.5.1-dev.1', '0.5.1-dev.2');
    expect(n.entries[0].items).toEqual([
      { title: '标题一（GitHub#12）', more: '说明里有 代码 和 粗体。' },
      { title: '只有标题', more: null },
      { title: '没有粗体的一行', more: null },
    ]);
  });

  it('a page that says nothing readable is still listed, with no items — an empty body, no first line in the known shape, a heading with nothing under it', async () => {
    const list = [
      rel('0.5.1-dev.5', `${NOTES_HEADING}\n\n（没有条目）\n`),
      rel('0.5.1-dev.4', 'something else entirely'),
      rel('0.5.1-dev.3', ''),
      { ...rel('0.5.1-dev.2', ''), body: null, published_at: null },
      rel('0.5.1-dev.1', ''),
    ];
    const n = await notes(list, '0.5.1-dev.1', '0.5.1-dev.5');
    expect(n.entries.map((e: any) => [e.version, e.items.length, e.at])).toEqual([
      ['0.5.1-dev.5', 0, '2026-11-01T00:00:00Z'],
      ['0.5.1-dev.4', 0, '2026-11-01T00:00:00Z'],
      ['0.5.1-dev.3', 0, '2026-11-01T00:00:00Z'],
      ['0.5.1-dev.2', 0, null],
    ]);
    // a heading with nothing under it falls back to the commit title when there is one
    const fb = await notes([rel('0.5.1-dev.2', `${devBody('0.5.1-dev.2', 'fix: y (#2)')}\n\n${NOTES_HEADING}\n`), rel('0.5.1-dev.1', '')], '0.5.1-dev.1', '0.5.1-dev.2');
    expect(titles(fb)).toEqual([['0.5.1-dev.2', ['fix: y (#2)']]]);
  });

  it('tagged releases carry the whole notes of their series: a line is listed once, under the oldest version that has it, and not at all when the running version already had it', async () => {
    const page = (lines: string[]) => `## Cavil Loop 客户端\n\n介绍\n\n### 这一版（0.5）\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\n### 上一版（0.4）\n\n- **旧的**：不算\n`;
    const list = [rel('0.5.2', page(['**丙**：三', '**乙**：二', '**甲**：一'])), rel('0.5.1', page(['**乙**：二', '**甲**：一'])), rel('0.5.0', page(['**甲**：一']))];
    expect(titles(await notes(list, '0.5.0', '0.5.2', 'stable'))).toEqual([
      ['0.5.2', ['丙']],
      ['0.5.1', ['乙']],
    ]);
    // the running version's page is gone: everything in the current part is listed, and it says "may be incomplete"
    const n = await notes(list.slice(0, 2), '0.5.0', '0.5.2', 'stable');
    expect(titles(n)).toEqual([
      ['0.5.2', ['丙']],
      ['0.5.1', ['乙', '甲']],
    ]);
    expect(n.complete).toBe(false);
  });

  it('limits: 30 versions (the newest), 20 items a version, 2000 characters a text — what was left out is counted', async () => {
    const many = Array.from({ length: 35 }, (_, i) => rel(`0.5.1-dev.${i + 2}`, devBody(`0.5.1-dev.${i + 2}`, `t${i + 2}`)));
    const n = await notes([...many, rel('0.5.1-dev.1', '')], '0.5.1-dev.1', '0.5.1-dev.36');
    expect(n.entries).toHaveLength(30);
    expect(n.more).toBe(5);
    expect(n.entries[0].version).toBe('0.5.1-dev.36');
    expect(n.entries.at(-1).version).toBe('0.5.1-dev.7');
    const long = `${NOTES_HEADING}\n\n${Array.from({ length: 23 }, (_, i) => `- **条目${i}**：${'长'.repeat(i === 0 ? 2500 : 3)}`).join('\n')}\n`;
    const one = (await notes([rel('0.5.1-dev.2', long), rel('0.5.1-dev.1', '')], '0.5.1-dev.1', '0.5.1-dev.2')).entries[0];
    expect(one.items).toHaveLength(20);
    expect(one.more).toBe(3);
    expect([...one.items[0].more]).toHaveLength(2001);
    expect(one.items[0].more.endsWith('…')).toBe(true);
    expect(one.items[1].more).toBe('长长长');
  });
});

// ---- the publisher: what a development build's release page carries ---------------------

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();

/** a real repository with client/RELEASE_NOTES.md over three commits → [client dir, sha1, sha2, sha3] */
function notesRepo() {
  const repo = tempDir();
  const client = join(repo, 'client');
  mkdirSync(client);
  git(repo, 'init', '-q', '-b', 'main');
  const write = (lines: string[]) => writeFileSync(join(client, 'RELEASE_NOTES.md'), `## Cavil Loop 客户端\n\n### 这一版（0.5）\n\n${lines.join('\n')}\n\n### 上一版（0.4）\n\n- **旧的**：不动\n`);
  const commit = (m: string) => (git(repo, 'add', '-A'), git(repo, 'commit', '-q', '-m', m), git(repo, 'rev-parse', 'HEAD'));
  write(['- **甲**（GitHub#1）：一']);
  const a = commit('one');
  write(['- **乙**（GitHub#2）：二，带 `代码`', '- **甲**（GitHub#1）：一']);
  const b = commit('two');
  writeFileSync(join(client, 'other.txt'), 'x');
  const c = commit('three: no notes');
  return { client, a, b, c };
}

describe('GitHub#348: the development build publisher adds what the build changed to its release page', () => {
  it('the lines RELEASE_NOTES.md gained since the previous published build, read from a real repository; nothing gained → none; a commit that is not there → cannot tell', () => {
    const r = notesRepo();
    expect(addedNotes(r.a, r.b, r.client)).toEqual(['- **乙**（GitHub#2）：二，带 `代码`']);
    expect(addedNotes(r.a, r.c, r.client)).toEqual(['- **乙**（GitHub#2）：二，带 `代码`']);
    expect(addedNotes(r.b, r.c, r.client)).toEqual([]);
    expect(addedNotes('f'.repeat(40), r.c, r.client)).toBeNull();
  });

  it('the previous build is the highest published development build below this one, by its recorded commit', () => {
    const list = [
      { tag_name: 'client/v0.5.1-dev.9', draft: false, prerelease: true, target_commitish: '9'.repeat(40) },
      { tag_name: 'client/v0.5.1-dev.10', draft: false, prerelease: true, target_commitish: 'a'.repeat(40) },
      { tag_name: 'client/v0.5.1-dev.12', draft: false, prerelease: true, target_commitish: 'c'.repeat(40) },
      { tag_name: 'client/v0.5.1-dev.11', draft: true, prerelease: true, target_commitish: 'b'.repeat(40) },
      { tag_name: 'client/v0.5.0', draft: false, prerelease: false, target_commitish: 'd'.repeat(40) },
    ];
    expect(previousBuildCommit(list, '0.5.1-dev.12')).toBe('a'.repeat(40));
    expect(previousBuildCommit(list, '0.5.1-dev.10')).toBe('9'.repeat(40));
    expect(previousBuildCommit(list, '0.5.1-dev.9')).toBeNull();
    expect(previousBuildCommit([{ ...list[0], target_commitish: 'main' }], '0.5.1-dev.10')).toBeNull();
  });

  it('one page, two readers: the body the publisher writes is the fixture byte for byte, and the app reads that fixture into the same items', async () => {
    const r = notesRepo();
    const first = `开发版 0.5.1-dev.2，构建自 main 的 ${'b'.repeat(40)}：feat(client): two (#2)\n\n${TAIL}\n`;
    const body = composeBody(first, addedNotes(r.a, r.b, r.client));
    const fixture = readFileSync(join(fixtures, 'dev-body.md'), 'utf8');
    expect(body).toBe(fixture);
    // nothing added: the page is what it was given, and the app shows the commit title
    expect(composeBody(first, [])).toBe(first);
    expect(composeBody(first, null)).toBe(first);
    const n = await notes([rel('0.5.1-dev.2', fixture), rel('0.5.1-dev.1', first)], '0.5.1-dev.1', '0.5.1-dev.2');
    expect(n.entries[0].items).toEqual([{ title: '乙（GitHub#2）', more: '二，带 代码' }]);
    const plain = await notes([rel('0.5.1-dev.2', first), rel('0.5.1-dev.1', '')], '0.5.1-dev.1', '0.5.1-dev.2');
    expect(titles(plain)).toEqual([['0.5.1-dev.2', ['feat(client): two (#2)']]]);
  });
});

// GitHub#427: a commit whose own build was never published, and that wrote no note line, is listed
// by its title on the next published build's page. Producer and app on the same body.
describe('GitHub#427: app changes with no note line, from builds that were never published', () => {
  /** base → x (app change + note) → y (app change, no note, never built) → z (test-only, no note) → head (app change + note) */
  function repo() {
    const repo = tempDir();
    const client = join(repo, 'client');
    mkdirSync(join(client, 'src'), { recursive: true });
    mkdirSync(join(client, 'test'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    const lines: string[] = [];
    const commit = (m: string, file: string, note?: string) => {
      if (note) lines.unshift(note);
      writeFileSync(join(client, 'RELEASE_NOTES.md'), `### 这一版（0.5）\n\n${lines.join('\n')}\n`);
      writeFileSync(join(client, file), m);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', m);
      return git(repo, 'rev-parse', 'HEAD');
    };
    const base = commit('base', 'src/a.ts', '- **旧的**：已在上一版');
    const x = commit('feat(client): x (#10)', 'src/x.ts', '- **新功能 X**（GitHub#10）：说明');
    const y = commit('feat(client): pick a Project from GitHub (#414)', 'src/y.ts');
    const z = commit('test(client): only tests (#12)', 'test/z.ts');
    const head = commit('feat(client): head (#13)', 'src/h.ts', '- **新功能 H**（GitHub#13）：说明');
    return { client, base, x, y, z, head };
  }

  it('the untold commits are exactly the app changes with no note line; every commit with a note → the same lines as before this change', () => {
    const r = repo();
    expect(untoldCommits(r.base, r.head, r.client)).toEqual([{ sha: r.y, title: 'feat(client): pick a Project from GitHub (#414)' }]);
    expect(buildNotes(r.base, r.head, r.client)).toEqual({
      lines: ['- **新功能 H**（GitHub#13）：说明', '- **新功能 X**（GitHub#10）：说明', '- feat(client): pick a Project from GitHub (#414)'],
      notes: 2,
      titles: 1,
    });
    // a range where every app change wrote a note: what the publisher wrote before GitHub#427 (the note lines alone)
    expect(buildNotes(r.base, r.x, r.client)!.lines).toEqual(addedNotes(r.base, r.x, r.client));
    expect(buildNotes(r.y, r.z, r.client)).toEqual({ lines: [], notes: 0, titles: 0 });
    // history that cannot be read → nothing at all, never half of it
    expect(untoldCommits('f'.repeat(40), r.head, r.client)).toBeNull();
    expect(buildNotes('f'.repeat(40), r.head, r.client)).toBeNull();
  });

  it('the app lists the untold commit under the build that carried it, once', async () => {
    const r = repo();
    const first = `开发版 0.5.1-dev.3，构建自 main 的 ${r.head}：feat(client): head (#13)\n\n${TAIL}\n`;
    const body = composeBody(first, buildNotes(r.base, r.head, r.client)!.lines);
    const n = await notes([rel('0.5.1-dev.3', body), rel('0.5.1-dev.1', '')], '0.5.1-dev.1', '0.5.1-dev.3');
    expect(n.entries[0].items).toEqual([
      { title: '新功能 H（GitHub#13）', more: '说明' },
      { title: '新功能 X（GitHub#10）', more: '说明' },
      { title: 'feat(client): pick a Project from GitHub (#414)', more: null },
    ]);
  });
});
