import type { GroupBy, SortField, ViewSettings } from '../shared/types';
import { GROUP_BYS, SORT_FIELDS, TABLE_COLUMNS } from '../shared/viewSettings';
import { columnLabel } from './TableView';
import { api } from './api';
import { t } from '../shared/i18n';

const groupLabel = (g: GroupBy): string => ({ iteration: t('迭代'), status: t('状态'), milestone: t('里程碑'), repo: t('仓库'), none: t('不分组') })[g];
const sortLabel = (f: SortField): string =>
  ({
    manual: t('Project 里的顺序'),
    updated: t('更新时间'),
    title: t('标题'),
    number: t('编号'),
    repo: t('仓库'),
    iteration: t('迭代'),
    status: t('状态'),
    milestone: t('里程碑'),
  })[f];

/**
 * View settings, saved at once. Sort and "PRs under their issue" apply to
 * both layouts (card order on the board, row order in the table); the rest is
 * the table's.
 */
export function ViewSettingsPanel({ view }: { view: ViewSettings }) {
  const tb = view.table;
  const table = view.layout === 'table';
  return (
    <div className="view-panel" data-testid="view-panel">
      {table && (
      <label>
        {t('分组：')}
        <select data-testid="group-by" value={tb.groupBy} onChange={(e) => api().setView({ table: { groupBy: e.target.value as GroupBy } })}>
          {GROUP_BYS.map((g) => (
            <option key={g} value={g}>
              {groupLabel(g)}
            </option>
          ))}
        </select>
      </label>
      )}
      <label>
        {t('排序：')}
        <select data-testid="sort-field" value={tb.sort.field} onChange={(e) => api().setView({ table: { sort: { ...tb.sort, field: e.target.value as SortField } } })}>
          {SORT_FIELDS.map((f) => (
            <option key={f} value={f}>
              {sortLabel(f)}
            </option>
          ))}
        </select>
        <select
          data-testid="sort-dir"
          value={tb.sort.dir}
          disabled={tb.sort.field === 'manual'}
          onChange={(e) => api().setView({ table: { sort: { ...tb.sort, dir: e.target.value as 'asc' | 'desc' } } })}
        >
          <option value="desc">{t('从新到旧 / 从大到小')}</option>
          <option value="asc">{t('从旧到新 / 从小到大')}</option>
        </select>
      </label>
      <label className="chip" title={t('同一列 / 同一组里，PR 紧跟在它关联的 issue 下面')}>
        <input type="checkbox" data-testid="prs-under-issues" checked={view.prsUnderIssues} onChange={(e) => api().setView({ prsUnderIssues: e.target.checked })} />
        {t('PR 跟在关联 issue 下面')}
      </label>
      {table && (
      <>
      <label className="chip">
        <input type="checkbox" data-testid="slice-by-repo" checked={tb.sliceByRepo} onChange={(e) => api().setView({ table: { sliceByRepo: e.target.checked } })} />
        {t('左侧按仓库切片')}
      </label>
      <label className="chip">
        <input type="checkbox" data-testid="hierarchy" checked={tb.hierarchy} onChange={(e) => api().setView({ table: { hierarchy: e.target.checked } })} />
        {t('子 issue 缩进在父 issue 下')}
      </label>
      <div className="columns-pick" data-testid="columns-pick">
        {t('列：')}
        {TABLE_COLUMNS.filter((c) => c !== 'title').map((c) => (
          <label key={c} className="chip">
            <input
              type="checkbox"
              data-col={c}
              checked={tb.columns.includes(c)}
              onChange={(e) =>
                api().setView({
                  table: {
                    // unticked: removed where it was; ticked: added at the end (imported order is kept)
                    columns: e.target.checked ? [...tb.columns, c] : tb.columns.filter((x) => x !== c),
                  },
                })
              }
            />
            {columnLabel(c)}
          </label>
        ))}
      </div>
      </>
      )}
    </div>
  );
}
