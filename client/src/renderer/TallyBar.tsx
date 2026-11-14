// GitHub#514: the view-bar numbers as one piece, drawn by the board's view bar and by Settings → 顶栏计数's
// live preview. Both hand it the entries of the same function (`viewBarTallies`), so the preview shows
// exactly the names, colours, order and counts the bar shows — never a copy of the rule.
//
// On the board a number is a button (a click puts its condition in the search box); in the preview it
// only shows (`onPick` absent): it is not focusable, does nothing on a click and leaves the search alone.

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
  return (
    <span className={`tally${preview ? ' preview' : ''}`} data-testid={testid}>
      {entries.map((e) => {
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
            aria-pressed={preview ? undefined : on}
            disabled={preview || e.query === null}
            tabIndex={preview ? -1 : undefined}
            title={tip ? tip(e, on) : tallyCountText(e)}
            {...verbatimParts('user', [e.label, e.source === 'query' ? e.query : null, named.own ? e.name : null])}
            onClick={onPick ? () => onPick(e) : undefined}
          >
            <i className={`dot c-${e.color}`} aria-hidden="true" />
            {named.own ? <Verbatim from="user">{named.text}</Verbatim> : named.text} <b data-testid="tally-count">{e.count}</b>
          </button>
        );
      })}
    </span>
  );
}
