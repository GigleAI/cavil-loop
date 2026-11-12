// GitHub#434: the rules of "等前置…" (src/shared/blocked.ts). The registration a daemon counts is read
// by two implementations — the client's (TypeScript) and the daemon's (jq inside scripts/_lib.sh,
// blocked_decide) — so they are run on the same comments and events and must agree (L3). The jq
// programs are taken out of _lib.sh as they are, not copied.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BLOCKED_LABELS,
  applyDone,
  confirmBlock,
  entryState,
  factsDiffer,
  factsOf,
  fingerprint,
  flowLabelsOf,
  latestRefs,
  lostRefs,
  markComment,
  planBlocked,
  planLines,
  refKey,
  repauseAllowed,
  roundMarks,
  roundOf,
  type BlockedRead,
  type Facts,
  type MarkComment,
  type RestEvent,
} from '../../src/shared/blocked';

const here = dirname(fileURLToPath(import.meta.url));
const LIB = readFileSync(join(here, '..', '..', '..', 'scripts', '_lib.sh'), 'utf8');
const SELF = 'gigleai/cavil-loop';
const NAMES = { human: 'pending/human', agent: 'pending/agent', running: 'doing/agent' };
const BL = DEFAULT_BLOCKED_LABELS;

/** the single-quoted jq program that follows `marker` in _lib.sh, up to `end` */
function daemonJq(marker: string, end: string): string {
  const at = LIB.indexOf(marker);
  if (at < 0) throw new Error(`not in _lib.sh: ${marker}`);
  const open = LIB.indexOf("'\n", at);
  const close = LIB.indexOf(end, open + 2);
  if (close < 0) throw new Error(`end not found after ${marker}`);
  return LIB.slice(open + 1, close);
}
// GitHub#429 moved the daemon's pick into its own function (blocked_mark_pick); its jq ends the function
const MARK_JQ = daemonJq('blocked_mark_pick() {', "'\n}");
const ROUND_JQ = daemonJq('if ! ep=$(printf', "' 2>/dev/null)");

/** a comment as GitHub's REST list gives it (what the daemon reads) */
interface RestComment {
  id: number;
  body: string;
  created_at: string;
  author_association: string;
}
const asMark = (c: RestComment): MarkComment => ({ id: c.id, body: c.body, createdAt: c.created_at, authorAssociation: c.author_association });

function jq(program: string, args: Record<string, string>, input: unknown): any {
  const argv = ['-c', ...Object.entries(args).flatMap(([k, v]) => ['--arg', k, v]), program];
  return JSON.parse(execFileSync('jq', argv, { input: JSON.stringify(input) }).toString());
}

/** what the daemon reads: the round, then the newest registration (its `set` uses r = '' for this repository) */
function daemonRead(events: RestEvent[], comments: RestComment[]) {
  const ep = jq(ROUND_JQ, { L: 'pending/blocked' }, [events]);
  const mark = jq(MARK_JQ, { M: '<!-- agent-blocked-by:', me: 'the-loop-account-nobody-uses', self: SELF, since: ep.since }, [comments]);
  return { ep, mark };
}

const at = (s: number) => `2026-11-12T09:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}Z`;
const ev = (id: number, event: string, label: string, s: number): RestEvent => ({ id, event, label: { name: label }, created_at: at(s) });
const cm = (id: number, s: number, body: string, assoc = 'COLLABORATOR'): RestComment => ({ id, created_at: at(s), body, author_association: assoc });

const EVENTS: RestEvent[] = [ev(1, 'labeled', 'pending/blocked', 10), ev(2, 'labeled', 'pending/human', 11), ev(3, 'unlabeled', 'pending/blocked', 20), ev(4, 'labeled', 'pending/blocked', 30)];
const COMMENTS: RestComment[] = [
  cm(100, 5, '<!-- agent-blocked-by: #1 resume=pending/agent -->'),
  // the same second the waiting label came off: the previous wait (code review round 1 of #157)
  cm(101, 20, '<!-- agent-blocked-by: #2 resume=pending/agent -->'),
  cm(102, 25, 'no mark here #77'),
  // an outside account: not counted
  cm(103, 26, '<!-- agent-blocked-by: #3 -->', 'NONE'),
  // the daemon's own conclusion quotes a mark: never a registration
  cm(104, 27, '<!-- agent-blocked-resolved #4 v=resume -->\n<!-- agent-blocked-by: #4 -->', 'MEMBER'),
  cm(106, 40, 'first\n<!-- agent-blocked-by: #5 Other-Org/Repo.x#6 abc#7 GigleAI/Cavil-Loop#8 resume=pending/agent/01 -->', 'OWNER'),
  // same second, lower id: sorted before 106
  cm(105, 40, '<!-- agent-blocked-by: #9 -->', 'MEMBER'),
  // two marks in one comment: the last one is read
  cm(107, 41, '<!-- agent-blocked-by: #10 resume=x -->\n<!-- agent-blocked-by: #11 #12 resume=pending/agent -->'),
];

function toDaemonSet(read: { repo: string; number: number }[]) {
  // jq's `unique` orders objects by their sorted keys: n, then r
  return read.map((r) => ({ r: r.repo === SELF ? '' : r.repo, n: r.number })).sort((a, b) => (a.n === b.n ? (a.r < b.r ? -1 : a.r > b.r ? 1 : 0) : a.n - b.n));
}

describe('the registration the daemon counts — client and daemon on the same input', () => {
  it('the current wait (round) matches the daemon reading the same events', () => {
    for (let k = 0; k <= EVENTS.length; k++) {
      const events = EVENTS.slice(0, k);
      const mine = roundOf(events, 'pending/blocked');
      const { ep } = daemonRead(events, []);
      expect({ last: mine.last, id: mine.id, since: mine.since }).toEqual({ last: ep.last, id: ep.id, since: ep.since });
    }
  });

  it('the newest registration of the wait matches, for every prefix of the comments and every round', () => {
    let compared = 0;
    for (let e = 0; e <= EVENTS.length; e++)
      for (let k = 0; k <= COMMENTS.length; k++) {
        const events = EVENTS.slice(0, e);
        const comments = COMMENTS.slice(0, k);
        const marks = roundMarks(comments.map(asMark), roundOf(events, 'pending/blocked'), SELF);
        const { mark } = daemonRead(events, comments);
        const latest = marks.length ? marks[marks.length - 1] : null;
        expect({ set: latest ? toDaemonSet(latest.refs) : [], resume: latest ? latest.resume : '' }, `events ${e} comments ${k}`).toEqual(mark);
        compared++;
      }
    expect(compared).toBe((EVENTS.length + 1) * (COMMENTS.length + 1));
  });

  it('reads the hard cases the way the daemon does (positive check of the fixture itself)', () => {
    const marks = roundMarks(COMMENTS.map(asMark), roundOf(EVENTS, 'pending/blocked'), SELF);
    expect(marks.map((m) => m.id)).toEqual([105, 106, 107]);
    expect(marks[1].refs.map(refKey).sort()).toEqual(['gigleai/cavil-loop#5', 'gigleai/cavil-loop#8', 'other-org/repo.x#6']);
    expect(marks[1].resume).toBe('pending/agent/01');
    expect(marks[2].refs.map((r) => r.number)).toEqual([11, 12]);
  });

  it('the comment this client writes is read by the daemon as exactly the prerequisites and resume label it was given', () => {
    const refs = [
      { repo: SELF, number: 12 },
      { repo: 'other/x', number: 3 },
      { repo: SELF, number: 340 },
    ];
    const body = markComment(refs, 'GigleAI/cavil-loop', 'pending/agent', 'op-1-abc');
    const { mark } = daemonRead([], [cm(1, 1, body)]);
    expect(mark).toEqual({ set: toDaemonSet(refs), resume: 'pending/agent' });
    // and it carries the hidden operation id
    expect(body).toContain('<!-- cavil-blocked-op:op-1-abc -->');
  });
});

describe('which items may enter', () => {
  const st = (labels: string[]) => entryState(labels, NAMES, BL);
  it('waiting for a person / already waiting / both / no flow label', () => {
    expect(st(['pending/human', 'bug'])).toEqual({ kind: 'human' });
    expect(st(['pending/blocked'])).toEqual({ kind: 'waiting' });
    expect(st(['Pending/Blocked', 'pending/human', 'autopilot'])).toEqual({ kind: 'paused' });
    expect(st(['bug', 'autopilot', 'priority/high'])).toEqual({ kind: 'none' });
  });
  it('every default flow label of the daemon template, and suffixed dispatch labels, keep it out', () => {
    // cavil-loop.config.example: the labels the daemon stops at (blocked_stop_labels) besides human / blocked
    const example = readFileSync(join(here, '..', '..', '..', 'cavil-loop.config.example'), 'utf8');
    const defaults = [...example.matchAll(/^LABEL_[A-Z_]+="([^"]+)"/gm)].map((m) => m[1]).filter((l) => !['pending/human', 'pending/blocked', 'autopilot'].includes(l));
    expect(defaults).toEqual(expect.arrayContaining(['pending/agent', 'doing/agent', 'pending/merge']));
    for (const l of [...defaults, 'pending/review', 'pending/PR', 'Done', 'pending/agent/01', 'pending/requester-bot']) expect(st(['pending/human', l]), l).toEqual({ kind: 'other', label: l });
  });
  it('a custom flow label counts once it is in the setting; the agent / running labels count whatever their names', () => {
    expect(entryState(['waiting-review'], NAMES, BL)).toEqual({ kind: 'none' });
    expect(entryState(['waiting-review'], NAMES, { ...BL, flow: 'pending/*, waiting-*' })).toEqual({ kind: 'other', label: 'waiting-review' });
    expect(entryState(['go'], { ...NAMES, agent: 'go' }, BL)).toEqual({ kind: 'other', label: 'go' });
  });
  it('the labels an operation compares are the flow ones only', () => {
    expect(flowLabelsOf(['bug', 'pending/human', 'Pending/Blocked', 'doing/agent'], NAMES, BL)).toEqual(['doing/agent', 'pending/blocked', 'pending/human']);
  });
});

const read = (over: Partial<BlockedRead> = {}): BlockedRead => ({ state: 'open', isPr: false, labels: ['pending/human'], round: { last: '', id: null, since: '' }, marks: [], native: [], ...over });
const issue = (n: number) => ({ repo: SELF, number: n, kind: 'issue' as const, id: 1000 + n, title: `t${n}` });
const pr = (n: number) => ({ repo: SELF, number: n, kind: 'pr' as const, id: 2000 + n, title: `p${n}` });

describe('the plan', () => {
  it('issue waits for issues: native relations only, no comment, no pause', () => {
    const p = planBlocked({ itemIsPr: false, selfRepo: SELF, entry: { kind: 'human' }, latest: [], native: [], picks: [issue(1), issue(2)], restore: [] });
    expect(p.steps.map((s) => s.name)).toEqual(['relation', 'relation', 'addBlocked', 'unpause']);
    expect(p.markRefs).toEqual([]);
  });
  it('a PR prerequisite: comment with the current registration kept, paused first when the item was not waiting for a person', () => {
    const p = planBlocked({ itemIsPr: false, selfRepo: SELF, entry: { kind: 'waiting' }, latest: [{ repo: SELF, number: 5 }], native: [], picks: [pr(7), issue(8)], restore: [] });
    expect(p.steps.map((s) => s.name)).toEqual(['pause', 'relation', 'comment', 'check', 'unpause']);
    expect(p.markRefs.map(refKey)).toEqual([`${SELF}#5`, `${SELF}#7`]);
  });
  it('the item is a PR: everything goes through the comment', () => {
    const p = planBlocked({ itemIsPr: true, selfRepo: SELF, entry: { kind: 'none' }, latest: [], native: [], picks: [issue(8)], restore: [] });
    expect(p.steps.map((s) => s.name)).toEqual(['pause', 'comment', 'check', 'addBlocked', 'unpause']);
  });
  it('restoring what an overwritten registration lost (paused item) writes a comment, keeps the labels already there', () => {
    const p = planBlocked({ itemIsPr: false, selfRepo: SELF, entry: { kind: 'paused' }, latest: [{ repo: SELF, number: 5 }], native: [], picks: [], restore: [{ repo: SELF, number: 6 }] });
    expect(p.steps.map((s) => s.name)).toEqual(['comment', 'check', 'unpause']);
    expect(planLines(p, SELF, { human: 'pending/human', blocked: 'pending/blocked' })[0]).toContain('#5、#6');
  });
  it('an issue already native is not added again', () => {
    const p = planBlocked({ itemIsPr: false, selfRepo: SELF, entry: { kind: 'none' }, latest: [], native: [{ repo: SELF, number: 1 }], picks: [issue(1), issue(2)], restore: [] });
    expect(p.steps.map((s) => `${s.name}${s.target ? ' ' + s.target : ''}`)).toEqual([`relation ${SELF}#2`, 'addBlocked']);
  });
  it('lost prerequisites: in an earlier registration of the wait, not in the newest, not native', () => {
    const r = read({ marks: [{ id: 1, createdAt: 'a', refs: [{ repo: SELF, number: 1 }, { repo: SELF, number: 2 }], resume: '' }, { id: 2, createdAt: 'b', refs: [{ repo: SELF, number: 1 }], resume: '' }], native: [{ repo: SELF, number: 3 }] });
    expect(lostRefs(r).map(refKey)).toEqual([`${SELF}#2`]);
    expect(latestRefs(r).map(refKey)).toEqual([`${SELF}#1`]);
    expect(lostRefs(read())).toEqual([]);
  });
});

describe('the permit before every write', () => {
  const basis: Facts = factsOf(read(), NAMES, BL);
  const ctx = { human: 'pending/human', blocked: 'pending/blocked' };
  it('nothing changed: no difference; the fingerprint is stable', () => {
    expect(factsDiffer(basis, factsOf(read(), NAMES, BL), null)).toBeNull();
    expect(fingerprint(basis)).toBe(fingerprint(factsOf(read({ labels: ['pending/human', 'bug'] }), NAMES, BL)));
  });
  it("the operation's own steps are expected; anybody else's change is not", () => {
    let f = applyDone(basis, { name: 'relation', target: `${SELF}#2` }, ctx);
    f = applyDone(f, { name: 'comment' }, { ...ctx, commentId: 77, mark: { refs: [], resume: '' } });
    const after = read({ native: [{ repo: SELF, number: 2 }], marks: [{ id: 77, createdAt: 'x', refs: [], resume: '' }] });
    expect(factsDiffer(f, factsOf(after, NAMES, BL), null)).toBeNull();
    // the waiting label going on starts a wait whose id is not known in advance
    const g = applyDone(f, { name: 'addBlocked' }, ctx);
    const on = read({ ...after, labels: ['pending/human', 'pending/blocked'], round: { last: 'labeled', id: 9, since: '' } });
    expect(factsDiffer(g, factsOf(on, NAMES, BL), null)).toBeNull();
    // somebody else's registration, another flow label, closing, a new wait — each stops it
    expect(factsDiffer(f, factsOf({ ...after, marks: [...after.marks, { id: 78, createdAt: 'y', refs: [], resume: '' }] }, NAMES, BL), null)).toMatch(/有新增或被改动/);
    expect(factsDiffer(f, factsOf({ ...after, labels: ['pending/human', 'doing/agent'] }, NAMES, BL), null)).toMatch(/多了「doing\/agent」/);
    expect(factsDiffer(f, factsOf({ ...after, state: 'closed' }, NAMES, BL), null)).toMatch(/关闭/);
    expect(factsDiffer(f, factsOf({ ...after, round: { last: 'unlabeled', id: null, since: 'z' } }, NAMES, BL), null)).toMatch(/换了一轮/);
    expect(factsDiffer(g, factsOf({ ...on, round: { last: 'labeled', id: null, since: '' } }, NAMES, BL), null)).toMatch(/换了一轮/);
  });
  it('putting the pause back: only when the one change is other registrations, and the label is gone', () => {
    // expected after: pause, comment 77 — the other client's comment 78 arrived and it took the pause off
    const waiting = read({ labels: ['pending/blocked'], round: { last: 'labeled', id: 4, since: '' } });
    const b = factsOf(waiting, NAMES, BL);
    const exp = applyDone(applyDone(b, { name: 'pause' }, ctx), { name: 'comment' }, { ...ctx, commentId: 77, mark: { refs: [], resume: '' } });
    const mk = (id: number) => ({ id, createdAt: String(id), refs: [], resume: '' });
    const crossed = read({ ...waiting, marks: [mk(77), mk(78)] });
    expect(repauseAllowed(exp, factsOf(crossed, NAMES, BL), 4, 'pending/human')).toEqual({ ok: true });
    // anything else: no write
    expect(repauseAllowed(exp, factsOf({ ...crossed, state: 'closed' }, NAMES, BL), 4, 'pending/human').ok).toBe(false);
    expect(repauseAllowed(exp, factsOf({ ...crossed, labels: ['pending/blocked', 'doing/agent'] }, NAMES, BL), 4, 'pending/human').ok).toBe(false);
    expect(repauseAllowed(exp, factsOf({ ...crossed, round: { last: 'labeled', id: 5, since: 'q' } }, NAMES, BL), 4, 'pending/human').ok).toBe(false);
    expect(repauseAllowed(exp, factsOf({ ...crossed, labels: ['pending/blocked', 'pending/human'] }, NAMES, BL), 4, 'pending/human').ok).toBe(false);
    expect(repauseAllowed(exp, factsOf({ ...waiting, marks: [mk(77)] }, NAMES, BL), 4, 'pending/human').ok).toBe(false);
    expect(repauseAllowed(exp, factsOf({ ...waiting, marks: [mk(78)] }, NAMES, BL), 4, 'pending/human').ok).toBe(false);
  });
});

describe('PR #441 code review round 1', () => {
  const ctx = { human: 'pending/human', blocked: 'pending/blocked' };
  const mark = (id: number, ns: number[], resume = 'pending/agent') => ({ id, createdAt: String(id), refs: ns.map((n) => ({ repo: SELF, number: n })), resume });
  it('a registration edited in place (same id, more prerequisites) is a change; the same content is not', () => {
    const waiting = read({ labels: ['pending/blocked'], round: { last: 'labeled', id: 4, since: '' }, marks: [mark(1, [12])] });
    const basis = factsOf(waiting, NAMES, BL);
    const exp = applyDone(basis, { name: 'pause' }, ctx);
    const paused = { ...waiting, labels: ['pending/blocked', 'pending/human'] };
    expect(factsDiffer(exp, factsOf(paused, NAMES, BL), 4)).toBeNull();
    expect(factsDiffer(exp, factsOf({ ...paused, marks: [mark(1, [12, 17])] }, NAMES, BL), 4)).toMatch(/被改动/);
    expect(factsDiffer(exp, factsOf({ ...paused, marks: [mark(1, [12], 'pending/agent/01')] }, NAMES, BL), 4)).toMatch(/被改动/);
    // the dialog's fingerprint sees it too
    expect(fingerprint(factsOf({ ...waiting, marks: [mark(1, [12, 17])] }, NAMES, BL))).not.toBe(fingerprint(basis));
    // this operation's own registration is expected with exactly what it wrote
    const mine = applyDone(exp, { name: 'comment' }, { ...ctx, commentId: 2, mark: { refs: [{ repo: SELF, number: 12 }, { repo: SELF, number: 16 }], resume: 'pending/agent' } });
    expect(factsDiffer(mine, factsOf({ ...paused, marks: [mark(1, [12]), mark(2, [16, 12])] }, NAMES, BL), 4)).toBeNull();
    expect(factsDiffer(mine, factsOf({ ...paused, marks: [mark(1, [12]), mark(2, [16])] }, NAMES, BL), 4)).toMatch(/被改动/);
  });
  it('confirming with nothing new: allowed to finish a registration stopped half way, never to wait on nothing', () => {
    const plan = (entry: Parameters<typeof planBlocked>[0]['entry'], latest: number[], native: number[] = []) =>
      planBlocked({ itemIsPr: false, selfRepo: SELF, entry, latest: latest.map((n) => ({ repo: SELF, number: n })), native: native.map((n) => ({ repo: SELF, number: n })), picks: [], restore: [] });
    // paused with a full registration: only the pause comes off
    const p1 = plan({ kind: 'paused' }, [12]);
    expect(p1.steps.map((s) => s.name)).toEqual(['unpause']);
    expect(confirmBlock({ picks: 0, restore: 0, current: 1, plan: p1 })).toBeNull();
    // stopped after the native relation, before the waiting label
    const p2 = plan({ kind: 'human' }, [], [11]);
    expect(p2.steps.map((s) => s.name)).toEqual(['addBlocked', 'unpause']);
    expect(confirmBlock({ picks: 0, restore: 0, current: 1, plan: p2 })).toBeNull();
    // already waiting, nothing new: nothing to do
    expect(confirmBlock({ picks: 0, restore: 0, current: 1, plan: plan({ kind: 'waiting' }, [12]) })).toMatch(/没有要补做/);
    // waiting for a person with no prerequisite at all: not put on the waiting label
    expect(confirmBlock({ picks: 0, restore: 0, current: 0, plan: plan({ kind: 'human' }, []) })).toMatch(/还没有选前置/);
    // something picked: as before
    expect(confirmBlock({ picks: 1, restore: 0, current: 0, plan: p2 })).toBeNull();
  });
});
