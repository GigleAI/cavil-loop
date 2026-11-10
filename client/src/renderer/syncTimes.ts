// GitHub#324: the words for "how fresh is what is shown" — the header, the offline bar and the
// hover all take them from here, and all from the one set of times the controller keeps
// (SyncState.times / dataFrom / checkedFrom). Two different times, never merged into one:
//   整份读取  the source was read in full then (what is on screen is that read)
//   上次检查  the latest full read, or the latest "nothing changed" answer of the change check —
//             which does not see everything (CHECK_BLIND), so it is never called "current as of"

import type { SyncState } from '../shared/types';

export function ago(from: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - from) / 60_000));
  if (mins < 1) return '不到 1 分钟前';
  if (mins < 60) return `${mins} 分钟前`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** what the check cannot see (data/changeCheck.ts); no promise of when the full read succeeds */
export const CHECK_BLIND =
  '「检查」看不到仓库里被删除、被转走、滑出最近 14 天的条目，也看不到看板标题、保存的视图和写权限的变化；这些要等整份重读（约每 10 分钟一次，读不成就更久）。';

/** the header: the oldest check among the sources that have data; null = no source has data, nothing is shown */
export function headerText(sync: SyncState, now: number): string | null {
  return sync.checkedFrom === null ? null : `上次检查 ${ago(sync.checkedFrom, now)}`;
}

/** the offline bar's part about the data */
export function offlineDataText(sync: SyncState, now: number): string {
  if (sync.dataFrom === null) return '还没有同步过';
  const read = `数据整份读取：${ago(sync.dataFrom, now)}`;
  return sync.checkedFrom !== null && sync.checkedFrom > sync.dataFrom ? `${read}；上次检查：${ago(sync.checkedFrom, now)}` : read;
}

function lasted(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** the hover of the header, one line each: every source's two times, the connection, what a check misses, the round in progress */
export function hoverLines(sync: SyncState, label: (sourceKey: string) => string, now: number): string[] {
  const lines = sync.times.map((t) =>
    t.readAt === null || t.checkedAt === null
      ? `${label(t.sourceKey)}：还没有读到过`
      : `${label(t.sourceKey)}：整份读取 ${ago(t.readAt, now)} · 上次检查 ${ago(t.checkedAt, now)}`,
  );
  lines.push(sync.lastOnlineAt === null ? '最后连上 GitHub：这次打开后还没有连上过' : `最后连上 GitHub：${ago(sync.lastOnlineAt, now)}`);
  lines.push(CHECK_BLIND);
  if (sync.syncing && sync.progress) {
    lines.push(`同步中，已进行 ${lasted(now - sync.progress.startedAt)}，已读完 ${sync.progress.done} / ${sync.progress.total} 个来源`);
  }
  return lines;
}
