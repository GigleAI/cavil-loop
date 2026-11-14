// GitHub#474 (PR #537 review round 1): a failure quoted inside a sentence of the client's keeps the
// outside words (GitHub's reply, the network's / system's message) as holes shown as written — never
// filled into a template, where "{human}" inside them would be taken for a hole. Three pieces:
// GitHubError.worded (built in the same call as its message), errorWords, nestSaid / sayFailure.

import { afterEach, describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, errorWords, refusalOf, sayFailure } from '../../src/data/github';
import { nestSaid, saidText, setLang, zhKey, type Said } from '../../src/shared/i18n';

afterEach(() => setLang('zh'));

const NASTY = '服务器开小差了 {human} {blocked} {why}';

function answer(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), { status, headers: { 'content-type': 'application/json' } });
}

/** what the window shows: the template's holes filled from the parts — the same rule SaidText draws by */
const shown = (s: Said) => saidText(s);
/** the outside parts, by text */
const outside = (s: Said) => s.parts.map((p) => `${p.from}:${p.text}`);

describe('GitHubError carries its message worded with holes', () => {
  for (const lang of ['zh', 'en'] as const)
    it(`${lang}: a refused answer — GitHub's words a hole, the sentence the same as the message`, async () => {
      setLang(lang);
      const e = await refusalOf(answer(502, NASTY));
      expect(e.worded).toBeDefined();
      expect(shown(e.worded!)).toBe(e.message);
      expect(outside(e.worded!)).toEqual([`github:${NASTY}`]);
      // GitHub's words are not in the template: nothing of theirs can be read as a hole
      expect(e.worded!.template).not.toContain('服务器');
      expect(e.message).toContain(NASTY);
      expect(e.worded!.template).toBe(lang === 'en' ? 'GitHub answered HTTP 502: {detail}' : 'GitHub 返回 HTTP 502：{detail}');
    });

  it('a refused answer without words: the client\'s own sentence, no holes', async () => {
    const e = await refusalOf(answer(500, ''));
    expect(errorWords(e)).toEqual({ template: e.message, parts: [] });
  });

  it("an error the client worded alone is all its own words; anything else is the system's, as written", () => {
    expect(errorWords(new GitHubError('http', '评论分页超过 5 页，已停止'))).toEqual({ template: '评论分页超过 5 页，已停止', parts: [] });
    expect(errorWords(new Error(NASTY))).toEqual({ template: '{why}', parts: [{ name: 'why', text: NASTY, from: 'system' }] });
  });
});

describe('nestSaid / sayFailure', () => {
  it("nests the inner template, renames the inner holes, and never reads outside words as holes", () => {
    const inner: Said = { template: 'A {why} B {gone}', parts: [{ name: 'why', text: '{human}', from: 'github' }] };
    const s = nestSaid('[{why}] {human}', 'why', inner, [{ name: 'human', text: '等人/处理', from: 'user' }]);
    expect(s.template).toBe('[A {why_why} B {why__0}] {human}');
    // the GitHub part "{human}" stays as written; the person's label fills the outer {human} only
    expect(shown(s)).toBe('[A {human} B {gone}] 等人/处理');
    expect(outside(s)).toEqual(['user:等人/处理', 'github:{human}', 'github:{gone}']);
  });

  it('PR #537 review round 2: a message that quoted outside text without holes — a "{human}" in it is kept as written, never filled', () => {
    const inner: Said = { template: 'refused https://x.example/{human}?{blocked}', parts: [] };
    const s = nestSaid('({why}) {human} {blocked}', 'why', inner, [
      { name: 'human', text: '等人/处理', from: 'user' },
      { name: 'blocked', text: 'pending/blocked', from: 'user' },
    ]);
    expect(shown(s)).toBe('(refused https://x.example/{human}?{blocked}) 等人/处理 pending/blocked');
    expect(outside(s)).toContain('github:{human}');
  });

  for (const lang of ['zh', 'en'] as const)
    it(`${lang}: reading a repository's labels failed — reads as the old flat sentence, the repository and GitHub's words as holes`, async () => {
      setLang(lang);
      const e = await refusalOf(answer(502, NASTY));
      const s = sayFailure(zhKey('读取 {repo} 的标签 / 里程碑失败：{why}'), 'why', e, { repo: { text: 'GigleAI/cavil-loop', from: 'github' } });
      const flat = lang === 'zh' ? `读取 GigleAI/cavil-loop 的标签 / 里程碑失败：${e.message}` : `Reading the labels / milestones of GigleAI/cavil-loop failed: ${e.message}`;
      expect(shown(s)).toBe(flat);
      expect(outside(s).sort()).toEqual([`github:${NASTY}`, 'github:GigleAI/cavil-loop'].sort());
      // nothing of GitHub's or of the repository's is in the template
      expect(s.template).not.toContain('服务器');
      expect(s.template).not.toContain('GigleAI');
    });
});

// PR #537 review round 2: every way the real client's list read fails (the one the labels are read
// with), quoted inside the "wait for…" sentence — the outside words as written, marked, never re-read
describe('GitHubClient.restList: each failure, quoted inside another sentence', () => {
  const API = 'https://api.github.com';
  const OUTER = zhKey('读不到这个仓库的标签（{why}），不能确认「{blocked}」「{human}」两个标签都在');
  const labels = { blocked: { text: 'pending/blocked', from: 'user' as const }, human: { text: '等人/处理', from: 'user' as const } };
  // (a header holds no raw Chinese: the runtime refuses it, so the link is ASCII)
  const AWAY = 'https://evil.example/next/{human}?x={blocked}';
  const cases: { name: string; fetch: () => Promise<Response>; outsideText: string; sent: number }[] = [
    {
      name: 'a next-page link to another host (refused, never followed)',
      fetch: async () => new Response('[]', { status: 200, headers: { link: `<${AWAY}>; rel="next"` } }),
      outsideText: AWAY,
      sent: 1,
    },
    { name: 'an answer that is not a list', fetch: async () => new Response('{"message":"x"}', { status: 200 }), outsideText: '/repos/GigleAI/cavil-loop/labels?per_page=100', sent: 1 },
    { name: 'a broken answer', fetch: async () => new Response('{不是 JSON {human}', { status: 200 }), outsideText: '', sent: 1 },
    {
      name: 'GitHub cannot be reached',
      fetch: async () => {
        throw new Error('连接被重置 {human}');
      },
      outsideText: '连接被重置 {human}',
      sent: 1,
    },
    { name: 'a refused answer', fetch: async () => new Response(JSON.stringify({ message: '服务器开小差了 {human}' }), { status: 502 }), outsideText: '服务器开小差了 {human}', sent: 1 },
  ];
  for (const lang of ['zh', 'en'] as const)
    for (const c of cases)
      it(`${lang}: ${c.name}`, async () => {
        setLang(lang);
        const urls: string[] = [];
        const client = new GitHubClient({ api: API, web: 'https://github.com' }, 't', async (u: RequestInfo | URL) => {
          urls.push(String(u));
          return c.fetch();
        });
        const e = await client.restList('/repos/GigleAI/cavil-loop/labels?per_page=100').then(
          () => null,
          (x: unknown) => x,
        );
        expect(e).toBeInstanceOf(GitHubError);
        // only the API host was ever asked
        expect(urls.length).toBe(c.sent);
        expect(urls.every((u) => u.startsWith(API))).toBe(true);
        const err = e as GitHubError;
        // the error words itself: its message is its worded form flattened, every outside word a part
        expect(err.worded, 'the error carries its outside words apart').toBeDefined();
        expect(shown(err.worded!)).toBe(err.message);
        const s = sayFailure(OUTER, 'why', err, labels);
        const text = shown(s);
        // the outside words, whole, unchanged, in a marked part — "{human}" in them never became the label
        if (c.outsideText) {
          expect(text).toContain(c.outsideText);
          expect(s.parts.some((p) => p.text.includes(c.outsideText) && p.from !== 'user')).toBe(true);
        }
        // no Chinese of anyone else's is left in the template in English: the client's own words only
        if (lang === 'en') expect(/[一-鿿]/.test(s.template), s.template).toBe(false);
        // the person's labels fill only the sentence's own two holes
        expect(text.split('等人/处理').length - 1).toBe(1);
      });
});
