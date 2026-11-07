// "Has this start's first complete read of the source been answered?" — the condition the
// background tests (test/tauri/background.spec.ts) wait on before they put a label on GitHub
// (GitHub#186; since #251 there is no start-up summary to wait for). Fixed request logs in the
// shape the fake GitHub keeps them, so every ordering is staged exactly; the real app's suites run
// the same function on the real log.

import { describe, expect, it } from 'vitest';
import { firstReadDone } from '../tauri/first-round';

const REPO = 'gigleai/cavil-loop';
const open = (status = 200, page = '') => ({ method: 'GET', path: `/api/repos/${REPO}/issues?state=open&per_page=100${page}`, status });
const recent = (status = 200) => ({ method: 'GET', path: `/api/repos/${REPO}/issues?state=all&since=2026-10-24T00%3A00%3A00.000Z&per_page=100`, status });
const other = { method: 'GET', path: '/api/user', status: 200 };

describe('first complete read of this start', () => {
  it('nothing read yet, or only other requests: not done', () => {
    expect(firstReadDone([], 0, REPO)).toBe(false);
    expect(firstReadDone([other, other], 0, REPO)).toBe(false);
  });

  it('one of the two lists answered: not done (the other may still carry a label put on now)', () => {
    expect(firstReadDone([open()], 0, REPO)).toBe(false);
    expect(firstReadDone([recent()], 0, REPO)).toBe(false);
  });

  it('a list asked for but not answered yet (status 0), or answered with an error: not done', () => {
    expect(firstReadDone([open(0), recent()], 0, REPO)).toBe(false);
    expect(firstReadDone([open(), recent(502)], 0, REPO)).toBe(false);
  });

  it('both lists answered: done, in either order and with other requests between', () => {
    expect(firstReadDone([other, open(), other, recent()], 0, REPO)).toBe(true);
    expect(firstReadDone([recent(), open()], 0, REPO)).toBe(true);
  });

  it('a later page alone does not stand for a list', () => {
    expect(firstReadDone([open(200, '&page=2'), recent()], 0, REPO)).toBe(false);
  });

  it("an earlier start's reads do not count for this start", () => {
    const first = [open(), recent(), other];
    expect(firstReadDone(first, 0, REPO)).toBe(true);
    expect(firstReadDone(first, first.length, REPO)).toBe(false);
    expect(firstReadDone([...first, open()], first.length, REPO)).toBe(false);
    expect(firstReadDone([...first, open(), recent()], first.length, REPO)).toBe(true);
  });

  it('another repository is not this source', () => {
    const elsewhere = (p: string) => ({ method: 'GET', path: p, status: 200 });
    expect(firstReadDone([elsewhere('/api/repos/other/repo/issues?state=open'), elsewhere('/api/repos/other/repo/issues?state=all&since=x')], 0, REPO)).toBe(false);
  });
});
