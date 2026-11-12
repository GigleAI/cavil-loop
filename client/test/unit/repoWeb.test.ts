// GitHub#398: the address the "open this repository on GitHub" buttons open — one function for the
// board's swimlane heads, the table's repository sections and the table's repository list.

import { describe, expect, it } from 'vitest';
import { repoWebUrl } from '../../src/shared/repoWeb';

describe('repoWebUrl', () => {
  it('owner/name → the repository page on github.com, name kept as written', () => {
    expect(repoWebUrl('GigleAI/cavil-loop')).toBe('https://github.com/GigleAI/cavil-loop');
    expect(repoWebUrl('user-1/my.repo_2')).toBe('https://github.com/user-1/my.repo_2');
    expect(repoWebUrl('a/.github')).toBe('https://github.com/a/.github');
  });

  it('anything that is not exactly owner/name gets no address (so no button)', () => {
    for (const bad of ['', '无仓库', 'cavil-loop', 'GigleAI/', '/cavil-loop', 'GigleAI/cavil-loop/issues', 'GigleAI/cavil loop', 'GigleAI/a?b', 'GigleAI/a#b', 'https://github.com/GigleAI/cavil-loop', '-bad/repo', 'bad-/repo', 'o/..', 'o/.', ' GigleAI/cavil-loop', 'GigleAI/cavil-loop\n'])
      expect(repoWebUrl(bad), JSON.stringify(bad)).toBeNull();
    expect(repoWebUrl(null)).toBeNull();
    expect(repoWebUrl(undefined)).toBeNull();
  });
});
