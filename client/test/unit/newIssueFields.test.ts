// GitHub#405: the new-issue dialog's fold for labels, milestone and iteration. Its head line says
// what the three are set to; the iteration / milestone text is the text of the option the picker
// holds. Expected texts are written from the rules (the name list is every ticked board's current
// iterations, each name once), not copied from the output; the option texts are checked against the
// real option list the dialog renders.

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  autoIterationText,
  currentIterationNames,
  foldSummary,
  iterationOptionLabel,
  iterationPickText,
  milestoneText,
} from '../../src/data/newIssueFields';
import { iterationChoices, type MilestoneRead } from '../../src/data/groupPreset';
import { IterationOptions } from '../../src/renderer/iterationOptions';
import { iter, project } from './helpers';

const TODAY = '2026-11-10';
const x = iter('X', '2026-11-09', 14); // current
const y = iter('Y', '2026-11-03', 14); // current too (11-03 … 11-16)
const later = iter('Later', '2026-11-23', 14);
const old = iter('Old', '2026-10-01', 7);

/** what the dialog shows as "当前迭代" for these ticked boards */
const autoFor = (...boards: ReturnType<typeof project>[]) => iterationPickText('auto', iterationChoices(boards, TODAY), null, currentIterationNames(boards, TODAY), TODAY);

describe('GitHub#405: "当前迭代" — the existing rule, case by case', () => {
  it('one board has X, another has no current iteration: X', () => {
    expect(autoFor(project('a', 'A', [x]), project('b', 'B', [later]))).toBe('当前迭代（X）');
  });
  it('no ticked board has a current iteration: 按各看板', () => {
    expect(autoFor(project('a', 'A', [later]), project('b', 'B', [old]))).toBe('当前迭代（按各看板）');
  });
  it('two boards, current iterations X and Y: 按各看板', () => {
    expect(autoFor(project('a', 'A', [x]), project('b', 'B', [y]))).toBe('当前迭代（按各看板）');
  });
  it('one board with two overlapping current iterations of different names: 按各看板', () => {
    expect(autoFor(project('a', 'A', [x, y]))).toBe('当前迭代（按各看板）');
  });
  it('one board with two overlapping current iterations of the same name: that name', () => {
    expect(autoFor(project('a', 'A', [x, { ...y, title: 'X', id: 'X-2' }]))).toBe('当前迭代（X）');
  });
  it('two boards on the same current name: that name; a board that cannot take an iteration adds nothing', () => {
    expect(autoFor(project('a', 'A', [x]), project('b', 'B', [{ ...x, id: 'b-x' }]))).toBe('当前迭代（X）');
    const locked = { ...project('c', 'C', [y]), viewerCanUpdate: false };
    expect(autoFor(project('a', 'A', [x]), locked)).toBe('当前迭代（X）');
    expect(autoIterationText([])).toBe('当前迭代（按各看板）');
  });
});


/** the option texts the dialog's picker renders for the offered iterations (and a kept one), by value */
function renderedOptions(choices: ReturnType<typeof iterationChoices>, kept: (typeof choices)[number] | null): Map<string, string> {
  const html = renderToStaticMarkup(createElement('select', null, createElement(IterationOptions, { iterations: choices, chosen: kept, today: TODAY, label: iterationOptionLabel })));
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) out.set(m[1].replace(/&amp;/g, '&'), m[2].replace(/&amp;/g, '&'));
  return out;
}

describe('GitHub#405: a picked iteration — the head line says what the picker option says', () => {
  const boards = [project('a', 'A', [x, later, old])];
  const choices = iterationChoices(boards, TODAY);
  const currents = currentIterationNames(boards, TODAY);

  it('every offered iteration: same text as its option (current ones carry the mark)', () => {
    const opts = renderedOptions(choices, null);
    expect(choices.length).toBe(2);
    for (const c of choices) expect(iterationPickText(c.id, choices, null, currents, TODAY)).toBe(opts.get(c.id));
    expect(iterationPickText(choices[0].id, choices, null, currents, TODAY)).toBe('X（2026-11-09 起）（当前）');
    expect(iterationPickText(choices[1].id, choices, null, currents, TODAY)).toBe('Later（2026-11-23 起）');
  });

  it('an ended iteration a group gave (kept, not offered): its title, as its option shows it', () => {
    const kept = { id: 'Old\u00002026-10-01', title: 'Old', startDate: '2026-10-01', duration: 0 };
    const opts = renderedOptions(choices, kept);
    expect(iterationPickText(kept.id, choices, kept, currents, TODAY)).toBe(opts.get(kept.id));
    expect(opts.get(kept.id)).toBe('Old');
  });

  it('不设迭代; a value that is no option says nothing', () => {
    expect(iterationPickText('none', choices, null, currents, TODAY)).toBe('不设迭代');
    expect(iterationPickText('gone', choices, null, currents, TODAY)).toBe('');
  });
});

describe('GitHub#405: milestone', () => {
  const ok: MilestoneRead = { state: 'ok', milestones: [] };
  it('reading / unreadable / none / picked', () => {
    expect(milestoneText({ state: 'loading' }, '')).toEqual({ text: '读取里程碑…', tone: 'muted' });
    expect(milestoneText({ state: 'error', error: 'HTTP 502' }, 'v1.2')).toEqual({ text: '里程碑读取失败', tone: 'error' });
    expect(milestoneText(ok, '')).toEqual({ text: '不设里程碑', tone: 'muted' });
    expect(milestoneText(ok, 'v1.2')).toEqual({ text: 'v1.2', tone: 'plain' });
  });
});

describe('GitHub#405: the head line', () => {
  const ms = { text: '不设里程碑', tone: 'muted' as const };
  it('nothing chosen: 未选标签 · 不设里程碑 · the iteration', () => {
    expect(foldSummary({ labels: [], labelsRead: 'ok', milestone: ms, iteration: '当前迭代（X）' })).toEqual({
      title: '标签、里程碑、迭代',
      parts: [
        { kind: 'text', field: 'labels', text: '未选标签', tone: 'muted' },
        { kind: 'text', field: 'milestone', text: '不设里程碑', tone: 'muted' },
        { kind: 'text', field: 'iteration', text: '当前迭代（X）', tone: 'plain' },
      ],
    });
  });
  it('labels: one / many (the first three named, then +N); chosen ones are named even while the list is read again', () => {
    expect(foldSummary({ labels: ['bug'], labelsRead: 'ok', milestone: ms, iteration: null }).parts[0]).toEqual({ kind: 'labels', names: ['bug'], more: 0 });
    expect(foldSummary({ labels: ['a', 'b', 'c', 'd', 'e'], labelsRead: 'ok', milestone: ms, iteration: null }).parts[0]).toEqual({ kind: 'labels', names: ['a', 'b', 'c'], more: 2 });
    expect(foldSummary({ labels: ['a', 'b', 'c'], labelsRead: 'ok', milestone: ms, iteration: null }).parts[0]).toEqual({ kind: 'labels', names: ['a', 'b', 'c'], more: 0 });
    expect(foldSummary({ labels: ['a'], labelsRead: 'loading', milestone: ms, iteration: null }).parts[0]).toEqual({ kind: 'labels', names: ['a'], more: 0 });
  });
  it('label list still being read / unreadable, nothing chosen: said, never "未选标签"', () => {
    expect(foldSummary({ labels: [], labelsRead: 'loading', milestone: ms, iteration: null }).parts[0]).toEqual({ kind: 'text', field: 'labels', text: '读取标签…', tone: 'muted' });
    expect(foldSummary({ labels: [], labelsRead: 'error', milestone: ms, iteration: null }).parts[0]).toEqual({ kind: 'text', field: 'labels', text: '标签读取失败', tone: 'error' });
  });
  it('no ticked board takes an iteration: no iteration part, the title says so', () => {
    const s = foldSummary({ labels: [], labelsRead: 'ok', milestone: ms, iteration: null });
    expect(s.title).toBe('标签、里程碑');
    expect(s.parts.map((p) => (p.kind === 'text' ? p.field : 'labels'))).toEqual(['labels', 'milestone']);
  });
});
