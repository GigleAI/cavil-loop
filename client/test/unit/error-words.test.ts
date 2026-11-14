// GitHub#474 (PR #537 review round 1): a failure quoted inside a sentence of the client's keeps the
// outside words (GitHub's reply, the network's / system's message) as holes shown as written — never
// filled into a template, where "{human}" inside them would be taken for a hole. Three pieces:
// GitHubError.worded (built in the same call as its message), errorWords, nestSaid / sayFailure.

import { afterEach, describe, expect, it } from 'vitest';
import { GitHubError, errorWords, refusalOf, sayFailure } from '../../src/data/github';
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
    expect(s.template).toBe('[A {why_why} B {gone}] {human}');
    // the GitHub part "{human}" stays as written; the person's label fills the outer {human} only
    expect(shown(s)).toBe('[A {human} B {gone}] 等人/处理');
    expect(outside(s)).toEqual(['user:等人/处理', 'github:{human}']);
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
