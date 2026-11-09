// Turn a view saved on the GitHub Project page into this client's view
// settings. Pure. Whatever the view uses that this client cannot reproduce
// (a custom field as grouping / sort / column, the roadmap layout, …) is
// named in `notes` — never silently dropped. The filter text is taken as-is:
// words the search box does not understand get the usual yellow bar. One
// exception (GitHub#298): an empty filter keeps the default search text.

import type { GroupBy, ImportInfo, ProjectMeta, SavedView, SortField, TableColumn, ViewField, ViewSettings } from './types';

export const DEFAULT_TABLE_COLUMNS: TableColumn[] = ['title', 'assignees', 'labels', 'linkedPrs', 'subIssues', 'updated', 'iteration'];

/**
 * GitHub#298: the search text a client starts with — items whose Project
 * status is Done, or that carry the `Done` label, are hidden. Only settings
 * that never saved a search text get it; a saved one (even empty) is kept.
 */
export const DEFAULT_QUERY = '-Status:done -label:Done';

export const STATUS_FIELD = 'Status';

/**
 * The repository slice list and "show hierarchy" are part of a saved view on
 * the web, but GitHub's API does not return them. An import sets them to these
 * (both on, as in the view the client was modelled on); the user can switch them.
 */
export const NOT_IN_API = { sliceByRepo: true, hierarchy: true } as const;

const COLUMN_BY_TYPE: Record<string, TableColumn> = {
  TITLE: 'title',
  ASSIGNEES: 'assignees',
  LABELS: 'labels',
  LINKED_PULL_REQUESTS: 'linkedPrs',
  SUB_ISSUES_PROGRESS: 'subIssues',
  UPDATED: 'updated',
  ITERATION: 'iteration',
  MILESTONE: 'milestone',
  REPOSITORY: 'repo',
};

function isStatus(f: ViewField): boolean {
  return f.dataType === 'SINGLE_SELECT' && f.name === STATUS_FIELD;
}

function columnOf(f: ViewField): TableColumn | null {
  if (isStatus(f)) return 'status';
  return COLUMN_BY_TYPE[f.dataType] ?? null;
}

function groupOf(f: ViewField): GroupBy | null {
  if (f.dataType === 'ITERATION') return 'iteration';
  if (isStatus(f)) return 'status';
  if (f.dataType === 'MILESTONE') return 'milestone';
  if (f.dataType === 'REPOSITORY') return 'repo';
  return null;
}

function sortOf(f: ViewField): SortField | null {
  if (f.dataType === 'UPDATED') return 'updated';
  if (f.dataType === 'TITLE') return 'title';
  if (f.dataType === 'ITERATION') return 'iteration';
  if (f.dataType === 'MILESTONE') return 'milestone';
  if (f.dataType === 'REPOSITORY') return 'repo';
  if (isStatus(f)) return 'status';
  return null;
}

/** The view to import: `/views/N` when given and present, else the first one. */
export function pickView(project: ProjectMeta, wanted: number | undefined): { view: SavedView | null; note: string | null } {
  if (project.views.length === 0) return { view: null, note: `「${project.title}」在网页上没有存好的视图，没有可导入的设置` };
  if (wanted === undefined) return { view: project.views[0], note: null };
  const v = project.views.find((x) => x.number === wanted);
  if (v) return { view: v, note: null };
  return { view: project.views[0], note: `「${project.title}」没有编号为 ${wanted} 的视图，改为导入第一个视图「${project.views[0].name}」` };
}

export type ImportPatch = Pick<ViewSettings, 'layout' | 'query' | 'mode' | 'swimlanes' | 'table' | 'imported'>;

/**
 * Settings from one saved view. `current` supplies what the view does not
 * decide (e.g. a table view keeps the board's column mode as it was).
 */
export function importView(view: SavedView, project: ProjectMeta, current: ViewSettings, extraNote: string | null): ImportPatch {
  const notes: string[] = extraNote ? [extraNote] : [];
  let layout: ViewSettings['layout'] = 'table';
  if (view.layout === 'BOARD_LAYOUT') layout = 'board';
  else if (view.layout !== 'TABLE_LAYOUT') notes.push('路线图布局本客户端不支持，已改用表格');

  const table = { ...current.table, ...NOT_IN_API, slice: null };
  let mode = current.mode;
  let swimlanes = current.swimlanes;

  if (layout === 'table') {
    const g = view.groupBy[0];
    if (!g) table.groupBy = 'none';
    else {
      const got = groupOf(g);
      if (got) table.groupBy = got;
      else {
        table.groupBy = 'none';
        notes.push(`按「${g.name}」分组本客户端不支持，已改为不分组`);
      }
    }
  } else {
    const col = view.verticalGroupBy[0];
    if (col) {
      const got = groupOf(col);
      if (got === 'iteration' || got === 'status' || got === 'milestone') mode = got;
      else notes.push(`看板按「${col.name}」分列本客户端不支持，保留按${mode === 'iteration' ? '迭代' : mode === 'status' ? '状态' : '里程碑'}分列`);
    }
    const lane = view.groupBy[0];
    if (!lane) swimlanes = false;
    else if (groupOf(lane) === 'repo') swimlanes = true;
    else {
      swimlanes = false;
      notes.push(`按「${lane.name}」分泳道本客户端不支持，已改为不分泳道`);
    }
  }

  const s = view.sortBy[0];
  // no sort on the web = the Project's own item order, which is the order the items were read in
  if (!s) table.sort = { field: 'manual', dir: 'asc' };
  else {
    const f = sortOf(s.field);
    if (f) table.sort = { field: f, dir: s.direction === 'ASC' ? 'asc' : 'desc' };
    else notes.push(`按「${s.field.name}」排序本客户端不支持，保留按${table.sort.field === 'updated' ? '更新时间' : '原设置'}排序`);
  }
  if (view.sortBy.length > 1) notes.push(`网页视图有 ${view.sortBy.length} 级排序，本客户端只用第一级`);

  const columns: TableColumn[] = [];
  const skipped: string[] = [];
  for (const f of view.fields) {
    const c = columnOf(f);
    if (c) {
      if (!columns.includes(c)) columns.push(c);
    } else skipped.push(f.name);
  }
  if (!columns.includes('title')) columns.unshift('title');
  table.columns = columns;
  if (skipped.length) notes.push(`这些列本客户端不支持，未显示：${skipped.join('、')}`);

  const imported: ImportInfo = { sourceKey: project.key, viewNumber: view.number, viewName: view.name, notes };
  // GitHub#298: a view with no filter does not wipe the default search text
  // (only that exact text — any other search text is replaced as before)
  const query = view.filter.trim() === '' && current.query === DEFAULT_QUERY ? DEFAULT_QUERY : view.filter;
  return { layout, query, mode, swimlanes, table, imported };
}
