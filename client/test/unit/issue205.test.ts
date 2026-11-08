// GitHub#205: the pure rules behind the client improvements — column widths in the
// view settings, which Projects a new issue starts ticked on, and what counts as
// "an image was pasted that the box cannot take".

import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, isValidView, normalizeView, validWidths } from '../../src/shared/viewSettings';
import { isImageOnlyPaste, newIssueOnWeb } from '../../src/renderer/pasteImage';

describe('table column widths', () => {
  it('kept per column; only known columns, finite, 60–2000 px', () => {
    expect(validWidths({})).toBe(true);
    expect(validWidths({ title: 400, labels: 60, status: 2000 })).toBe(true);
    for (const bad of [{ title: 59 }, { title: 2001 }, { title: Number.NaN }, { title: '300' }, { nope: 100 }, null, [], 'x'])
      expect(validWidths(bad), JSON.stringify(bad)).toBe(false);
    expect(isValidView({ ...DEFAULT_VIEW, table: { ...DEFAULT_VIEW.table, widths: { title: 420 } } })).toBe(true);
    expect(isValidView({ ...DEFAULT_VIEW, table: { ...DEFAULT_VIEW.table, widths: { title: 10 } } })).toBe(false);
  });

  it('a view saved before widths existed reads as "no widths"; a broken saved value falls back to none, the rest is kept', () => {
    const { widths: _w, ...old } = DEFAULT_VIEW.table;
    expect(normalizeView({ ...DEFAULT_VIEW, table: old }).table.widths).toEqual({});
    const v = normalizeView({ ...DEFAULT_VIEW, layout: 'table', table: { ...DEFAULT_VIEW.table, groupBy: 'status', widths: { title: -1 } } });
    expect(v.table.widths).toEqual({});
    expect(v.table.groupBy).toBe('status');
    expect(v.layout).toBe('table');
    expect(normalizeView({ ...DEFAULT_VIEW, table: { ...DEFAULT_VIEW.table, widths: { labels: 300 } } }).table.widths).toEqual({ labels: 300 });
  });
});

// which Projects a new issue starts ticked on: replaced by GitHub#231, see issue231.test.ts

describe('pasting an image', () => {
  const clip = (types: string[], files: string[]) => ({ types, items: files.map((type) => ({ kind: 'file', type })) as unknown as DataTransferItemList });
  it('an image and no text (a screenshot) → the box would get nothing: say so', () => {
    expect(isImageOnlyPaste(clip(['Files'], ['image/png']))).toBe(true);
    expect(isImageOnlyPaste(clip(['Files', 'text/html'], ['image/jpeg']))).toBe(true);
  });
  it('text (with or without an image), a non-image file, nothing → left to the box', () => {
    expect(isImageOnlyPaste(clip(['text/plain'], []))).toBe(false);
    expect(isImageOnlyPaste(clip(['text/plain', 'Files'], ['image/png']))).toBe(false);
    expect(isImageOnlyPaste(clip(['Files'], ['application/pdf']))).toBe(false);
    expect(isImageOnlyPaste(null)).toBe(false);
  });
  it('the web page to carry on writing a new issue keeps what was typed', () => {
    expect(newIssueOnWeb('https://github.com', 'GigleAI/cavil-loop', '标题 & x', '正文\n第二行', ['bug', 'pending/agent'])).toBe(
      'https://github.com/GigleAI/cavil-loop/issues/new?title=%E6%A0%87%E9%A2%98+%26+x&body=%E6%AD%A3%E6%96%87%0A%E7%AC%AC%E4%BA%8C%E8%A1%8C&labels=bug%2Cpending%2Fagent',
    );
    expect(newIssueOnWeb('https://github.com', 'o/r', '', '', [])).toBe('https://github.com/o/r/issues/new');
  });
});
