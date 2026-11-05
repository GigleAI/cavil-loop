import type { GroupBy, SortField, ViewSettings } from '../shared/types';
import { GROUP_BYS, SORT_FIELDS, TABLE_COLUMNS } from '../shared/viewSettings';
import { COLUMN_LABEL } from './TableView';
import { api } from './api';

const GROUP_LABEL: Record<GroupBy, string> = { iteration: '迭代', status: '状态', milestone: '里程碑', repo: '仓库', none: '不分组' };
const SORT_LABEL: Record<SortField, string> = {
  manual: 'Project 里的顺序',
  updated: '更新时间',
  title: '标题',
  number: '编号',
  repo: '仓库',
  iteration: '迭代',
  status: '状态',
  milestone: '里程碑',
};

/**
 * View settings, saved at once. Sort applies to both layouts (card order on
 * the board, row order in the table); the rest is the table's.
 */
export function ViewSettingsPanel({ view }: { view: ViewSettings }) {
  const t = view.table;
  const table = view.layout === 'table';
  return (
    <div className="view-panel" data-testid="view-panel">
      {table && (
      <label>
        分组：
        <select data-testid="group-by" value={t.groupBy} onChange={(e) => api().setView({ table: { groupBy: e.target.value as GroupBy } })}>
          {GROUP_BYS.map((g) => (
            <option key={g} value={g}>
              {GROUP_LABEL[g]}
            </option>
          ))}
        </select>
      </label>
      )}
      <label>
        排序：
        <select data-testid="sort-field" value={t.sort.field} onChange={(e) => api().setView({ table: { sort: { ...t.sort, field: e.target.value as SortField } } })}>
          {SORT_FIELDS.map((f) => (
            <option key={f} value={f}>
              {SORT_LABEL[f]}
            </option>
          ))}
        </select>
        <select
          data-testid="sort-dir"
          value={t.sort.dir}
          disabled={t.sort.field === 'manual'}
          onChange={(e) => api().setView({ table: { sort: { ...t.sort, dir: e.target.value as 'asc' | 'desc' } } })}
        >
          <option value="desc">从新到旧 / 从大到小</option>
          <option value="asc">从旧到新 / 从小到大</option>
        </select>
      </label>
      {table && (
      <>
      <label className="chip">
        <input type="checkbox" data-testid="slice-by-repo" checked={t.sliceByRepo} onChange={(e) => api().setView({ table: { sliceByRepo: e.target.checked } })} />
        左侧按仓库切片
      </label>
      <label className="chip">
        <input type="checkbox" data-testid="hierarchy" checked={t.hierarchy} onChange={(e) => api().setView({ table: { hierarchy: e.target.checked } })} />
        子 issue 缩进在父 issue 下
      </label>
      <div className="columns-pick" data-testid="columns-pick">
        列：
        {TABLE_COLUMNS.filter((c) => c !== 'title').map((c) => (
          <label key={c} className="chip">
            <input
              type="checkbox"
              data-col={c}
              checked={t.columns.includes(c)}
              onChange={(e) =>
                api().setView({
                  table: {
                    // unticked: removed where it was; ticked: added at the end (imported order is kept)
                    columns: e.target.checked ? [...t.columns, c] : t.columns.filter((x) => x !== c),
                  },
                })
              }
            />
            {COLUMN_LABEL[c]}
          </label>
        ))}
      </div>
      </>
      )}
    </div>
  );
}
