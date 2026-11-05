import { describe, expect, it } from 'vitest';
import { parseSource } from '../../src/shared/sources';

describe('parseSource', () => {
  it('reads org and user Project URLs, with or without a view', () => {
    expect(parseSource('https://github.com/orgs/GigleAI/projects/11')).toMatchObject({
      kind: 'project',
      ownerType: 'org',
      owner: 'GigleAI',
      number: 11,
      key: 'project:org/gigleai/11',
    });
    expect(parseSource('https://github.com/orgs/GigleAI/projects/11/views/2?filterQuery=x')).toMatchObject({ key: 'project:org/gigleai/11', view: 2 });
    // the view to import is remembered; without /views/N there is none (the first view is imported)
    expect(parseSource('https://github.com/orgs/GigleAI/projects/11')).not.toHaveProperty('view');
    expect(parseSource('https://github.com/orgs/GigleAI/projects/11/views/abc')).not.toHaveProperty('view');
    expect(parseSource('https://github.com/users/luosky/projects/3')).toMatchObject({ ownerType: 'user', number: 3 });
  });

  it('reads owner/repo and repository URLs', () => {
    expect(parseSource('GigleAI/cavil-loop')).toMatchObject({ kind: 'repo', key: 'repo:gigleai/cavil-loop' });
    expect(parseSource(' https://github.com/GigleAI/cavil-loop/issues ')).toMatchObject({ kind: 'repo', owner: 'GigleAI', name: 'cavil-loop' });
  });

  it('refuses everything else', () => {
    for (const bad of ['', 'cavil-loop', 'a/b/c', 'https://gitlab.com/a/b', 'https://github.com/orgs/x/projects/abc', 'https://github.com/orgs/x']) {
      expect(parseSource(bad), bad).toBeNull();
    }
  });
});
