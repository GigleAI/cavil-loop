// Every supported way of writing a filter, on small synthetic boards, plus
// what happens to words this client does not support.

import { describe, expect, it } from 'vitest';
import { applyFilter, parseFilter, type FilterContext } from '../../src/shared/filter';
import { DEFAULT_QUERY } from '../../src/shared/viewSettings';
import type { Item } from '../../src/shared/types';
import { item, iter, member, project } from './helpers';

const IT1 = iter('Sprint 1', '2026-10-20', 7);
const IT2 = iter('Sprint 2', '2026-10-27', 7);
const IT3 = iter('Sprint 3', '2026-11-03', 7); // current on 2026-11-05
const IT4 = iter('Sprint 4', '2026-11-10', 7);
const A = project('project:org/x/1', 'Alpha', [IT1, IT2, IT3, IT4], ['Todo', 'In progress', 'Done']);
const B = project('project:org/x/2', 'Beta board', [iter('Sprint 3', '2026-11-03', 14)], ['Todo', 'Done']);
const TODAY = '2026-11-05';

const L = (...names: string[]) => names.map((name) => ({ name, color: 'ededed' }));

const ITEMS: Item[] = [
  item('x/app', 1, { title: 'Login page 登录页面改版', labels: L('bug', 'pending/human'), assignees: ['alice'], author: 'alice', state: 'open' }, [member(A, IT3, 'In progress')]),
  item('x/app', 2, { title: 'Crash on start', kind: 'pr', state: 'merged', labels: L('bug'), author: 'bob', milestone: { title: 'v1 beta', dueOn: null } }, [member(A, IT2, 'Done')]),
  item('x/app', 3, { title: 'Table view 表格视图', state: 'closed', labels: L('enhancement'), assignees: ['bob', 'carol'], author: 'carol' }, [member(A, IT4, 'Todo'), member(B, B.iterations[0], 'Done')]),
  item('x/lib', 4, { title: 'Docs: search syntax', kind: 'pr', state: 'open', author: 'alice', milestone: { title: 'v1', dueOn: '2026-12-01T00:00:00Z' } }, [member(A, null, null)]),
  item('x/lib', 5, { title: 'Only in the repository', labels: L('pending/human') }, []),
];

const ctx: FilterContext = { viewer: 'alice', today: TODAY, projects: [A, B] };
const nums = (q: string, c: FilterContext = ctx) => applyFilter(ITEMS, parseFilter(q), c).map((i) => i.number);

describe('filter syntax', () => {
  it('GitHub#298: the default search text hides status Done (any case) and the Done label, keeps the rest, needs no yellow bar', () => {
    expect(DEFAULT_QUERY).toBe('-Status:done -label:Done');
    expect(parseFilter(DEFAULT_QUERY).unsupported).toEqual([]);
    const done: Item[] = [
      item('x/d', 10, { title: 'status Done' }, [member(A, null, 'Done')]),
      item('x/d', 11, { title: 'label Done', labels: L('Done') }, [member(A, null, 'Todo')]),
      item('x/d', 12, { title: 'label done lower-case', labels: L('done') }, []),
      item('x/d', 13, { title: 'no status, no label' }, [member(A, null, null)]),
      item('x/d', 14, { title: 'repository only' }, []),
      item('x/d', 15, { title: 'Done in one Project only' }, [member(A, null, 'Todo'), member(B, null, 'Done')]),
    ];
    const kept = applyFilter([...ITEMS, ...done], parseFilter(DEFAULT_QUERY), ctx).map((i) => i.number);
    // 2 is Done on Alpha, 3 is Done on Beta; 10 / 15 Done somewhere, 11 / 12 carry the label (names compare case-insensitively)
    expect(kept).toEqual([1, 4, 5, 13, 14]);
  });

  it('empty query keeps everything', () => {
    expect(nums('')).toEqual([1, 2, 3, 4, 5]);
    expect(nums('   ')).toEqual([1, 2, 3, 4, 5]);
  });

  it('free text: title, any position, case-insensitive; Chinese in the middle of a run', () => {
    expect(nums('crash')).toEqual([2]);
    expect(nums('CRASH')).toEqual([2]);
    expect(nums('页面')).toEqual([1]); // middle of 登录页面改版
    expect(nums('视图')).toEqual([3]);
    expect(nums('view 表格')).toEqual([3]); // several words: all must hit
    expect(nums('view crash')).toEqual([]);
  });

  it('free text: number (with or without #) and label name', () => {
    expect(nums('4')).toEqual([4]);
    expect(nums('#3')).toEqual([3]);
    expect(nums('enhance')).toEqual([3]);
    expect(nums('pending')).toEqual([1, 5]);
  });

  it('label: exact name, case-insensitive; comma = either; repeated = both; - negates', () => {
    expect(nums('label:bug')).toEqual([1, 2]);
    expect(nums('label:BUG')).toEqual([1, 2]);
    expect(nums('label:bu')).toEqual([]); // not a substring match
    expect(nums('label:enhancement,pending/human')).toEqual([1, 3, 5]);
    expect(nums('label:bug label:pending/human')).toEqual([1]);
    expect(nums('-label:bug')).toEqual([3, 4, 5]);
    expect(nums('-label:bug,enhancement')).toEqual([4, 5]);
    expect(nums('label:"pending/human"')).toEqual([1, 5]);
  });

  it('status: per Project; any Project with that status matches; quotes for spaces', () => {
    expect(nums('status:"In progress"')).toEqual([1]);
    expect(nums('status:done')).toEqual([2, 3]); // #3: Done in Beta, Todo in Alpha
    expect(nums('-status:Done')).toEqual([1, 4, 5]);
    expect(nums('status:Todo,"In progress"')).toEqual([1, 3]);
    expect(nums('no:status')).toEqual([4, 5]);
    expect(nums('has:status')).toEqual([1, 2, 3]);
  });

  it('iteration: title, @current / @next / @previous per Project, no: / has:', () => {
    expect(nums('iteration:"Sprint 2"')).toEqual([2]);
    expect(nums('iteration:"sprint 3","Sprint 4"')).toEqual([1, 3]);
    expect(nums('iteration:@current')).toEqual([1, 3]); // #3 is current in Beta
    expect(nums('iteration:@next')).toEqual([3]);
    expect(nums('iteration:@previous')).toEqual([2]);
    expect(nums('-iteration:@current')).toEqual([2, 4, 5]);
    expect(nums('no:iteration')).toEqual([4, 5]);
    expect(nums('has:iteration')).toEqual([1, 2, 3]);
    // between two iterations nothing is current, so the relative ones match nothing
    expect(nums('iteration:@current', { ...ctx, today: '2026-12-31' })).toEqual([]);
    expect(nums('iteration:@previous', { ...ctx, today: '2026-12-31' })).toEqual([]);
  });

  it('milestone: exact title with quotes; no:milestone', () => {
    expect(nums('milestone:v1')).toEqual([4]);
    expect(nums('milestone:"v1 beta"')).toEqual([2]);
    expect(nums('no:milestone')).toEqual([1, 3, 5]);
    expect(nums('-no:milestone')).toEqual([2, 4]);
  });

  it('assignee: / author: with @me; no:assignee', () => {
    expect(nums('assignee:bob')).toEqual([3]);
    expect(nums('assignee:@me')).toEqual([1]);
    expect(nums('assignee:@me', { ...ctx, viewer: null })).toEqual([]);
    expect(nums('assignee:alice,carol')).toEqual([1, 3]);
    expect(nums('no:assignee')).toEqual([2, 4, 5]);
    expect(nums('author:alice')).toEqual([1, 4]);
    expect(nums('author:@me')).toEqual([1, 4]);
    expect(nums('-author:alice')).toEqual([2, 3, 5]);
  });

  it('repo: full owner/name, case-insensitive', () => {
    expect(nums('repo:x/lib')).toEqual([4, 5]);
    expect(nums('repo:X/LIB')).toEqual([4, 5]);
    expect(nums('repo:lib')).toEqual([]); // GitHub wants owner/name too (recorded: repo:cavil-loop → 0)
    expect(nums('-repo:x/lib')).toEqual([1, 2, 3]);
  });

  it('project: (this client only) by title, number or URL; items only in a repository match no project', () => {
    expect(nums('project:"Beta board"')).toEqual([3]);
    expect(nums('project:2')).toEqual([3]);
    expect(nums('project:alpha')).toEqual([1, 2, 3, 4]);
    expect(nums('project:https://github.com/orgs/x/projects/project:org/x/2')).toEqual([3]);
    expect(nums('-project:alpha')).toEqual([5]);
  });

  it('is: open / closed (merged counts as closed, as on GitHub) / merged / issue / pr', () => {
    expect(nums('is:open')).toEqual([1, 4, 5]);
    expect(nums('is:closed')).toEqual([2, 3]);
    expect(nums('is:merged')).toEqual([2]);
    expect(nums('is:issue')).toEqual([1, 3, 5]);
    expect(nums('is:pr')).toEqual([2, 4]);
    expect(nums('-is:pr')).toEqual([1, 3, 5]);
    expect(nums('is:open,merged')).toEqual([1, 2, 4, 5]);
    expect(nums('is:open is:pr')).toEqual([4]);
  });

  it('combinations', () => {
    expect(nums('-label:Done -status:Done is:open')).toEqual([1, 4, 5]);
    expect(nums('label:pending/human is:open 登录')).toEqual([1]);
  });
});

describe('words this client does not support: named, ignored, never "0 results"', () => {
  const cases: [string, string][] = [
    ['updated:>2026-01-01', 'date comparison'],
    ['created:2026-10-01..2026-10-31', 'date range'],
    ['reason:completed', 'close reason'],
    ['priority:High', 'custom field'],
    ['sort:updated-desc', 'sort'],
    ['body:crash', 'body text'],
    ['in:comments', 'comment text'],
    ['-crash', 'negated free text'],
    ['is:draft', 'unknown is: value'],
    ['no:priority', 'unknown no: value'],
    ['iteration:@current+1', 'iteration arithmetic'],
    ['iteration:>"Sprint 2"', 'iteration comparison'],
    ['assignee:@copilot', 'unknown @ token'],
    ['label:', 'empty value'],
    ['优先级:高', 'Chinese custom field'],
    ['-优先级:高', 'negated Chinese custom field'],
    ['状态:完成,进行中', 'Chinese field name with several values'],
    ['"Start date":2026-11-01', 'quoted field name with a space'],
    ['-"Target date":>@today', 'negated quoted field name'],
  ];
  for (const [token, why] of cases) {
    it(`${why}: ${token}`, () => {
      const p = parseFilter(`label:bug ${token}`);
      expect(p.unsupported).toEqual([token]);
      // the supported part still filters, the unsupported word does not narrow anything
      expect(applyFilter(ITEMS, p, ctx).map((i) => i.number)).toEqual(nums('label:bug'));
      // alone, it filters nothing out (not "0 results")
      expect(applyFilter(ITEMS, parseFilter(token), ctx)).toHaveLength(ITEMS.length);
    });
  }

  it('several unsupported words are all listed, in order', () => {
    expect(parseFilter('updated:>x foo reason:y').unsupported).toEqual(['updated:>x', 'reason:y']);
  });

  it('a quoted word with a colon in it is plain text, not a field', () => {
    const items = [...ITEMS, item('x/app', 9, { title: 'Error code a:b in log' })];
    const p = parseFilter('"a:b"');
    expect(p.unsupported).toEqual([]);
    expect(applyFilter(items, p, ctx).map((i) => i.number)).toEqual([9]);
  });

  it('a Chinese custom field next to supported words: the supported part still filters (as in an imported view)', () => {
    const p = parseFilter('优先级:高 -label:bug is:open');
    expect(p.unsupported).toEqual(['优先级:高']);
    expect(applyFilter(ITEMS, p, ctx).map((i) => i.number)).toEqual(nums('-label:bug is:open'));
    expect(nums('-label:bug is:open').length).toBeGreaterThan(0);
  });

  it('qualifier names are case-insensitive', () => {
    expect(parseFilter('Label:bug STATUS:Done').unsupported).toEqual([]);
    expect(nums('Label:bug')).toEqual([1, 2]);
  });
});
