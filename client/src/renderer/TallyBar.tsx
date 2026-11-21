// GitHub#514: the view-bar numbers as one piece, drawn by the board's view bar and by Settings → 顶栏计数's
// live preview. Both hand it the entries of the same function (`viewBarTallies`), so the preview shows
// exactly the names, colours, order and counts the bar shows — never a copy of the rule.
//
// On the board a number is a button (a click puts its condition in the search box); in the preview it
// only shows (`onPick` absent): it is not focusable, does nothing on a click and leaves the search alone.
//
// GitHub#634: a number whose entry says `folded` is not drawn in the row but in the fold at its end — a
// "⋯ 折叠 N" button that opens a small panel listing them, each the same button as in the row. Folding only
// moves where a number is drawn: which one is lit and what a click does are worked out on the whole list by
// the caller, exactly as before. Keyboard focus follows the number: when the number that has focus moves
// between the row and the fold (its count changed), focus goes to where it went (the number in the row, or
// the fold button); when the fold empties, to the number that left it. The preview draws the folded numbers
// after a "折叠区" mark instead of behind a button.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseFilter, statesStated } from '../shared/filter';
import { t } from '../shared/i18n';
import { tallyName, UNLABELED_QUERY, type TallyEntry } from '../data/flowTally';
import { Verbatim, verbatimParts } from './Verbatim';

/** what a number counts, in words (the first line of its tooltip) */
export function tallyCountText(e: TallyEntry): string {
  if (e.source === 'flow')
    // GitHub#462: a row following the "等人处理" label counts closed items carrying it too
    return e.flow === 'human' ? t('带 {label} 标签的条目（开着的和已关闭的都算）有 {n} 个', { label: e.label, n: e.count }) : t('开着的条目里带 {label} 标签的有 {n} 个', { label: e.label, n: e.count });
  if (e.query === UNLABELED_QUERY) return t('开着的条目里一个标签都没有的有 {n} 个', { n: e.count });
  return statesStated(parseFilter(e.query!)) ? t('符合「{query}」的有 {n} 个', { query: e.query ?? '', n: e.count }) : t('开着的条目里符合「{query}」的有 {n} 个', { query: e.query ?? '', n: e.count });
}

/** GitHub#634: why a number is in the fold (the small text next to it there) */
export function foldReason(e: TallyEntry): string {
  return e.fold === 'always' ? t('总是折叠') : t('为 0 时折叠');
}

/** where the number with keyboard focus is: in the row, in the open fold, or the fold button itself */
type FocusAt = { at: 'row' | 'fold'; kind: string } | { at: 'toggle' } | null;

export function TallyBar({
  entries,
  lit = null,
  tip,
  onPick,
  testid = 'flow-tally',
  itemTestid = 'tally',
}: {
  entries: readonly TallyEntry[];
  /** the number the search box shows right now (board only) */
  lit?: string | null;
  /** the whole tooltip of a number; default: what it counts */
  tip?: (e: TallyEntry, on: boolean) => string;
  /** a click on a number (board only); absent = the numbers only show */
  onPick?: (e: TallyEntry) => void;
  testid?: string;
  /** the numbers' own test id (the preview's differ from the bar's, so a page never holds two of one) */
  itemTestid?: string;
}) {
  const preview = !onPick;
  const row = entries.filter((e) => !e.folded);
  const folded = entries.filter((e) => e.folded);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const focus = useRef<FocusAt>(null);
  const before = useRef<{ row: string[]; folded: string[] }>({ row: row.map((e) => e.kind), folded: folded.map((e) => e.kind) });
  const shownOpen = open && folded.length > 0;

  const button = (e: TallyEntry, at: 'row' | 'fold') => {
    const on = lit === e.kind;
    const named = tallyName(e);
    return (
      <button
        key={e.kind}
        type="button"
        className={`tally-item${on ? ' on' : ''}${e.count === 0 ? ' zero' : ''}${e.query === null ? ' unclickable' : ''}`}
        data-testid={itemTestid}
        data-kind={e.kind}
        data-color={e.color}
        data-at={at}
        data-order={entries.indexOf(e)}
        aria-pressed={preview ? undefined : on}
        disabled={preview || e.query === null}
        tabIndex={preview ? -1 : undefined}
        title={tip ? tip(e, on) : tallyCountText(e)}
        {...verbatimParts('user', [e.label, e.source === 'query' ? e.query : null, named.own ? e.name : null])}
        onFocus={() => (focus.current = { at, kind: e.kind })}
        onClick={
          onPick
            ? () => {
                onPick(e);
                if (at === 'fold') {
                  setOpen(false);
                  focusToggle();
                }
              }
            : undefined
        }
      >
        <i className={`dot c-${e.color}`} aria-hidden="true" />
        {named.own ? <Verbatim from="user">{named.text}</Verbatim> : named.text} <b data-testid="tally-count">{e.count}</b>
        {at === 'fold' && (
          <span className="tally-why" data-testid="tally-fold-why">
            {foldReason(e)}
          </span>
        )}
      </button>
    );
  };
  const find = (sel: string) => box.current?.querySelector<HTMLElement>(sel) ?? null;
  const focusToggle = () => queueMicrotask(() => find('[data-testid="tally-fold-toggle"]')?.focus());

  // GitHub#634: focus follows the number when its count moves it between the row and the fold
  const sig = `${row.map((e) => e.kind).join('\n')}\u0000${folded.map((e) => e.kind).join('\n')}`;
  useLayoutEffect(() => {
    const was = before.current;
    const nowRow = row.map((e) => e.kind);
    const nowFolded = folded.map((e) => e.kind);
    before.current = { row: nowRow, folded: nowFolded };
    if (folded.length === 0 && open) setOpen(false);
    const f = focus.current;
    const active = document.activeElement;
    // only while the focus is ours: on one of these buttons, or lost because the button holding it went away
    if (!f || (active && active !== document.body && !box.current?.contains(active))) return;
    const inRow = (k: string) => find(`[data-at="row"][data-kind="${CSS.escape(k)}"]`);
    if (f.at === 'fold' && nowRow.includes(f.kind)) {
      // the focused number left the fold for the row: focus goes with it, the fold closes
      setOpen(false);
      inRow(f.kind)?.focus();
    } else if (f.at === 'row' && nowFolded.includes(f.kind)) {
      // the focused number in the row went into the fold: the fold button takes the focus
      find('[data-testid="tally-fold-toggle"]')?.focus();
    } else if (f.at === 'toggle' && nowFolded.length === 0) {
      // the fold emptied under the focused button: the first number that left it
      const left = was.folded.find((k) => nowRow.includes(k));
      (left ? inRow(left) : null)?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // the open fold goes on a press elsewhere, Esc (focus back to its button), the window losing focus
  useEffect(() => {
    if (!shownOpen) return;
    const away = (ev: Event) => {
      if (ev.target instanceof Node && box.current?.querySelector('.tally-fold')?.contains(ev.target)) return;
      // the press takes the focus elsewhere: nothing of ours follows a number any more
      focus.current = null;
      setOpen(false);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      // only an Esc meant for the fold: focus on its button or in its panel, or on nothing while the fold is on
      // screen. An Esc with focus anywhere else (the search box, a detail page in front) is that place's own.
      const fold = box.current?.querySelector<HTMLElement>('.tally-fold') ?? null;
      const active = document.activeElement;
      const ours = active && active !== document.body ? Boolean(fold?.contains(active)) : Boolean(fold && fold.offsetParent !== null);
      if (!ours) return;
      ev.preventDefault();
      ev.stopPropagation();
      setOpen(false);
      focusToggle();
    };
    const gone = () => {
      focus.current = null;
      setOpen(false);
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', gone);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', gone);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownOpen]);

  const litFolded = folded.find((e) => e.kind === lit) ?? null;
  const foldTip = [
    ...(litFolded ? [t('正在看：{name}', { name: tallyName(litFolded).text })] : []),
    t('折叠区：{list}', { list: folded.map((e) => `${tallyName(e).text} ${e.count}`).join(t('、')) }),
  ].join('\n');

  return (
    <span
      className={`tally${preview ? ' preview' : ''}`}
      data-testid={testid}
      ref={box}
      onBlur={(ev) => {
        // focus left for somewhere else on purpose (not because the focused number was removed)
        const next = ev.relatedTarget;
        if (next instanceof Node && box.current?.contains(next)) return;
        if (ev.target instanceof Node && ev.target.isConnected) focus.current = null;
      }}
    >
      {row.map((e) => button(e, 'row'))}
      {folded.length > 0 &&
        (preview ? (
          <span className="tally-fold-preview" data-testid="tally-preview-fold">
            <span className="tally-fold-mark">{t('｜ 折叠区：')}</span>
            {folded.map((e) => button(e, 'fold'))}
          </span>
        ) : (
          <span
            className="tally-fold"
            onBlur={(ev) => {
              // focus moved on, out of the fold (Tab, a click elsewhere): the open panel closes behind it. A button
              // removed while focused (its number left the fold) is not a move: the focus rules above handle that.
              const next = ev.relatedTarget;
              if (next instanceof Node && ev.currentTarget.contains(next)) return;
              if (ev.target instanceof Node && ev.target.isConnected && next instanceof Node) setOpen(false);
            }}
          >
            <button
              type="button"
              className={`tally-fold-toggle${litFolded ? ' on' : ''}`}
              data-testid="tally-fold-toggle"
              data-count={folded.length}
              aria-expanded={shownOpen}
              aria-haspopup="true"
              title={foldTip}
              onFocus={() => (focus.current = { at: 'toggle' })}
              onClick={() => setOpen(!shownOpen)}
            >
              {t('⋯ 折叠')} <b>{folded.length}</b> <span aria-hidden="true">{shownOpen ? '▴' : '▾'}</span>
            </button>
            {/* kept in the page while closed (hidden), so a number keeps one button wherever it is drawn */}
            <span className="tally-fold-pop" data-testid="tally-fold-pop" role="group" aria-label={t('折叠区')} hidden={!shownOpen}>
              <span className="tally-fold-head">{t('折叠区')}</span>
              {folded.map((e) => button(e, 'fold'))}
            </span>
          </span>
        ))}
    </span>
  );
}
