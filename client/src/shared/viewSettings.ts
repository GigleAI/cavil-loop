// View settings: defaults, validation, and reading what an older build saved.
// Pure; shared by the controller and the renderer.

import type { ColumnMode, GroupBy, Layout, SortField, TableColumn, TableSettings, ViewSettings } from './types';
import { DEFAULT_QUERY, DEFAULT_TABLE_COLUMNS, NOT_IN_API } from './viewImport';

export { DEFAULT_QUERY };

export const MODES: readonly ColumnMode[] = ['iteration', 'status', 'milestone'];
export const LAYOUTS: readonly Layout[] = ['board', 'table', 'graph'];
export const GROUP_BYS: readonly GroupBy[] = ['iteration', 'status', 'milestone', 'repo', 'none'];
export const SORT_FIELDS: readonly SortField[] = ['manual', 'updated', 'title', 'number', 'repo', 'iteration', 'status', 'milestone'];
export const TABLE_COLUMNS: readonly TableColumn[] = [
  'title',
  'assignees',
  'labels',
  'linkedPrs',
  'subIssues',
  'updated',
  'iteration',
  'status',
  'milestone',
  'repo',
  'author',
];

export const DEFAULT_TABLE: TableSettings = {
  groupBy: 'iteration',
  sort: { field: 'updated', dir: 'desc' },
  columns: DEFAULT_TABLE_COLUMNS,
  sliceByRepo: NOT_IN_API.sliceByRepo,
  slice: null,
  hierarchy: NOT_IN_API.hierarchy,
  widths: {},
};

/** GitHub#205: the narrowest / widest a table column can be dragged to. */
export const COLUMN_MIN_WIDTH = 60;
export const COLUMN_MAX_WIDTH = 2000;

export function validWidths(v: unknown): v is Partial<Record<TableColumn, number>> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.entries(v).every(
    ([k, w]) => TABLE_COLUMNS.includes(k as TableColumn) && typeof w === 'number' && Number.isFinite(w) && w >= COLUMN_MIN_WIDTH && w <= COLUMN_MAX_WIDTH,
  );
}

export const DEFAULT_VIEW: ViewSettings = {
  mode: 'iteration',
  swimlanes: false,
  selected: null,
  layout: 'board',
  query: DEFAULT_QUERY,
  table: DEFAULT_TABLE,
  imported: null,
  prsUnderIssues: true,
  detailWidth: 560,
  detailFields: true,
};

/** The floating detail panel: narrowest it can be dragged to, and the widest any saved value may be. */
export const DETAIL_MIN_WIDTH = 360;
export const DETAIL_MAX_WIDTH = 4000;

function validWidth(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= DETAIL_MIN_WIDTH && v <= DETAIL_MAX_WIDTH;
}

/** A change from the UI: any top-level setting, and any part of the table settings. */
export type ViewPatch = Partial<Omit<ViewSettings, 'table'>> & { table?: Partial<TableSettings> };

function validTable(t: unknown): t is TableSettings {
  const x = t as TableSettings;
  return (
    typeof x === 'object' &&
    x !== null &&
    GROUP_BYS.includes(x.groupBy) &&
    typeof x.sort === 'object' &&
    x.sort !== null &&
    SORT_FIELDS.includes(x.sort.field) &&
    (x.sort.dir === 'asc' || x.sort.dir === 'desc') &&
    Array.isArray(x.columns) &&
    x.columns.length > 0 &&
    x.columns.every((c) => TABLE_COLUMNS.includes(c)) &&
    new Set(x.columns).size === x.columns.length &&
    typeof x.sliceByRepo === 'boolean' &&
    (x.slice === null || typeof x.slice === 'string') &&
    typeof x.hierarchy === 'boolean' &&
    validWidths(x.widths)
  );
}

export function isValidView(v: unknown): v is ViewSettings {
  const x = v as ViewSettings;
  return (
    typeof x === 'object' &&
    x !== null &&
    MODES.includes(x.mode) &&
    typeof x.swimlanes === 'boolean' &&
    (x.selected === null || (Array.isArray(x.selected) && x.selected.every((k) => typeof k === 'string'))) &&
    LAYOUTS.includes(x.layout) &&
    typeof x.query === 'string' &&
    validTable(x.table) &&
    (x.imported === null || (typeof x.imported === 'object' && Array.isArray(x.imported.notes))) &&
    typeof x.prsUnderIssues === 'boolean' &&
    validWidth(x.detailWidth) &&
    typeof x.detailFields === 'boolean'
  );
}

/** Whatever was saved (an older build saved only mode / swimlanes / selected): keep each valid part, default the rest. */
export function normalizeView(raw: unknown): ViewSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, any>;
  const pick = <K extends keyof ViewSettings>(k: K, ok: (v: any) => boolean): ViewSettings[K] => (ok(r[k]) ? r[k] : DEFAULT_VIEW[k]);
  const t = (typeof r.table === 'object' && r.table !== null ? r.table : {}) as Record<string, any>;
  const tpick = <K extends keyof TableSettings>(k: K, ok: (v: any) => boolean): TableSettings[K] => (ok(t[k]) ? t[k] : DEFAULT_TABLE[k]);
  const table: TableSettings = {
    groupBy: tpick('groupBy', (v) => GROUP_BYS.includes(v)),
    sort: tpick('sort', (v) => v && SORT_FIELDS.includes(v.field) && (v.dir === 'asc' || v.dir === 'desc')),
    columns: tpick('columns', (v) => Array.isArray(v) && v.length > 0 && v.every((c: any) => TABLE_COLUMNS.includes(c)) && new Set(v).size === v.length),
    sliceByRepo: tpick('sliceByRepo', (v) => typeof v === 'boolean'),
    slice: tpick('slice', (v) => v === null || typeof v === 'string'),
    hierarchy: tpick('hierarchy', (v) => typeof v === 'boolean'),
    widths: tpick('widths', validWidths),
  };
  return {
    mode: pick('mode', (v) => MODES.includes(v)),
    swimlanes: pick('swimlanes', (v) => typeof v === 'boolean'),
    selected: pick('selected', (v) => v === null || (Array.isArray(v) && v.every((k: any) => typeof k === 'string'))),
    layout: pick('layout', (v) => LAYOUTS.includes(v)),
    query: pick('query', (v) => typeof v === 'string'),
    table,
    imported: pick('imported', (v) => v === null || (typeof v === 'object' && Array.isArray(v.notes))),
    prsUnderIssues: pick('prsUnderIssues', (v) => typeof v === 'boolean'),
    detailWidth: pick('detailWidth', validWidth),
    detailFields: pick('detailFields', (v) => typeof v === 'boolean'),
  };
}
