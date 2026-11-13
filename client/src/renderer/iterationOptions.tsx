import type { Iteration } from '../shared/types';
import { iterationSections } from '../shared/filter';
import { CURRENT_MARK } from '../data/newIssueFields';
import { t } from '../shared/i18n';

export { CURRENT_MARK };

/** Today's date (local time) as YYYY-MM-DD — the board, the table and the pickers judge "current" by it. */
export function localToday(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The options of one Project's iteration picker (GitHub#231), used by the detail panel and the
 * table cell alike: current (marked) → upcoming, nearest first → ended, latest first, each part
 * under its own heading. A native picker cannot colour one option, so "current" stands out by its
 * own heading and the mark. `chosen` = the item's value: kept as an option when the Project no
 * longer lists it, so the picker still shows what is set.
 */
export function IterationOptions({
  iterations,
  chosen,
  today,
  label,
}: {
  iterations: Iteration[];
  chosen: Iteration | null;
  today: string;
  /** the text of one option */
  label: (it: Iteration) => string;
}) {
  const s = iterationSections(iterations, today);
  const opt = (it: Iteration, current: boolean) => (
    // an option holds text only: the iteration's name (GitHub's) cannot be wrapped on its own, so the option is marked
    <option key={it.id} value={it.id} data-section={current ? 'current' : undefined} data-verbatim="github">
      {label(it)}
      {current ? CURRENT_MARK : ''}
    </option>
  );
  return (
    <>
      {chosen && !iterations.some((i) => i.id === chosen.id) && <option value={chosen.id} data-verbatim="github">{chosen.title}</option>}
      {s.current.length > 0 && (
        <optgroup label={t('当前')} data-section="current">
          {s.current.map((it) => opt(it, true))}
        </optgroup>
      )}
      {s.upcoming.length > 0 && (
        <optgroup label={t('即将开始')} data-section="upcoming">
          {s.upcoming.map((it) => opt(it, false))}
        </optgroup>
      )}
      {s.ended.length > 0 && (
        <optgroup label={t('已结束')} data-section="ended">
          {s.ended.map((it) => opt(it, false))}
        </optgroup>
      )}
    </>
  );
}
