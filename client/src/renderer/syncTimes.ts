// GitHub#324: the words for "how fresh is what is shown" — the header, the offline bar and the
// hover all take them from here, and all from the one set of times the controller keeps
// (SyncState.times / dataFrom / checkedFrom). Two different times, never merged into one:
//   整份读取  the source was read in full then (what is on screen is that read)
//   上次检查  the latest full read, or the latest "nothing changed" answer of the change check —
//             which does not see everything (CHECK_BLIND), so it is never called "current as of"

import type { SourceStatus, SyncState } from '../shared/types';
import { t } from '../shared/i18n';

export function ago(from: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - from) / 60_000));
  if (mins < 1) return t('不到 1 分钟前');
  if (mins < 60) return t('{n} 分钟前', { n: mins });
  const h = Math.floor(mins / 60);
  if (h < 24) return t('{n} 小时前', { n: h });
  return t('{n} 天前', { n: Math.floor(h / 24) });
}

/** a time of day, HH:MM (local) */
export function clockAt(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** GitHub#374: the line under a failed source — the panel and the hover both take it from here */
export function retryText(st: SourceStatus, now: number): string | null {
  const r = st.retry;
  if (st.ok || !r) return null;
  if (st.rateLimited) {
    if (r.limitedUntil === null) return null;
    return r.limitedUntil > now ? t('额度约 {at} 恢复，到时自动重读；在那之前不再发读取请求', { at: clockAt(r.limitedUntil) }) : t('限流时间已过，下一轮自动重读');
  }
  const next = r.nextAt === null || r.nextAt <= now ? t('下一轮自动重试') : t('下次自动重试 {at}', { at: clockAt(r.nextAt) });
  return t('从 {since} 起连续失败 {n} 次 · {next}（失败越多隔得越久，最长 10 分钟）', { since: clockAt(r.since), n: r.count, next });
}

/** GitHub#374: under the list of failed sources, when any of them waits for its next try */
export const retryByHand = () => t('点「重新同步」会马上重读，不等自动重试。');

/** what the check cannot see (data/changeCheck.ts); no promise of when the full read succeeds */
export const checkBlind = () =>
  t('「检查」看不到仓库里被删除、被转走、滑出最近 14 天的条目，也看不到看板标题、保存的视图和写权限的变化；这些要等整份重读（约每 10 分钟一次，读不成就更久）。');

/** the header: the oldest check among the sources that have data; null = no source has data, nothing is shown */
export function headerText(sync: SyncState, now: number): string | null {
  return sync.checkedFrom === null ? null : t('上次检查 {ago}', { ago: ago(sync.checkedFrom, now) });
}

/** the offline bar's part about the data */
export function offlineDataText(sync: SyncState, now: number): string {
  if (sync.dataFrom === null) return t('还没有同步过');
  const read = t('数据整份读取：{ago}', { ago: ago(sync.dataFrom, now) });
  return sync.checkedFrom !== null && sync.checkedFrom > sync.dataFrom ? t('{read}；上次检查：{ago}', { read, ago: ago(sync.checkedFrom, now) }) : read;
}

function lasted(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? t('{s} 秒', { s }) : t('{m} 分 {s} 秒', { m: Math.floor(s / 60), s: s % 60 });
}

/** the hover of the header, one line each: every source's two times, the connection, what a check misses, the round in progress */
export function hoverLines(sync: SyncState, label: (sourceKey: string) => string, now: number): string[] {
  const lines = sync.times.map((x) =>
    x.readAt === null || x.checkedAt === null
      ? t('{source}：还没有读到过', { source: label(x.sourceKey) })
      : t('{source}：整份读取 {read} · 上次检查 {checked}', { source: label(x.sourceKey), read: ago(x.readAt, now), checked: ago(x.checkedAt, now) }),
  );
  for (const st of sync.sources) {
    const r = retryText(st, now);
    if (r) lines.push(t('{source}：{text}', { source: label(st.sourceKey), text: r }));
  }
  lines.push(sync.lastOnlineAt === null ? t('最后连上 GitHub：这次打开后还没有连上过') : t('最后连上 GitHub：{ago}', { ago: ago(sync.lastOnlineAt, now) }));
  lines.push(checkBlind());
  if (sync.syncing && sync.progress) {
    lines.push(t('同步中，已进行 {lasted}，已读完 {done} / {total} 个来源', { lasted: lasted(now - sync.progress.startedAt), done: sync.progress.done, total: sync.progress.total }));
  }
  return lines;
}
