// GitHub#324: the words for "how fresh is what is shown" — the header, the offline bar and the
// hover all take them from here, and all from the one set of times the controller keeps
// (SyncState.times / dataFrom / checkedFrom). Two different times, never merged into one:
//   整份读取  the source was read in full then (what is on screen is that read)
//   上次检查  the latest full read, or the latest "nothing changed" answer of the change check —
//             which does not see everything (CHECK_BLIND), so it is never called "current as of"

import type { SourceStatus, SyncStall, SyncState, SyncStep } from '../shared/types';
import { t } from '../shared/i18n';
import { hhmm } from '../shared/readFailure';

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
// GitHub#558: the time a rate limit lifts is rounded up to the minute, as on the yellow button next to refresh (shared/readFailure.ts)
export function retryText(st: SourceStatus, now: number): string | null {
  const r = st.retry;
  if (st.ok || !r) return null;
  if (st.rateLimited) {
    if (r.limitedUntil === null) return null;
    if (r.limitedUntil <= now) return t('限流时间已过，下一轮自动重读');
    // GitHub#558: GitHub gave no time — the client's own wait is not when the quota comes back
    return r.limitedSaid
      ? t('额度约 {at} 恢复，到时自动重读；在那之前不再发读取请求', { at: hhmm(r.limitedUntil) })
      : t('GitHub 没说什么时候恢复，客户端 {at} 再试；在那之前不再发读取请求', { at: hhmm(r.limitedUntil) });
  }
  const next = r.nextAt === null || r.nextAt <= now ? t('下一轮自动重试') : t('下次自动重试 {at}', { at: clockAt(r.nextAt) });
  return t('从 {since} 起连续失败 {n} 次 · {next}（失败越多隔得越久，最长 10 分钟）', { since: clockAt(r.since), n: r.count, next });
}

/** GitHub#374: under the list of failed sources, when any of them waits for its next try */
export const retryByHand = () => t('点「重新同步」会马上重读，不等自动重试。');

/** what the check and the read of changes cannot see (data/changeCheck.ts, data/delta.ts); no promise of when the full read succeeds */
export const checkBlind = () =>
  t('「检查」和「读取变化」看不到被删除、被转走的条目，也看不到看板标题、保存的视图、写权限和只改了别的条目带来的依赖关系变化；这些要等整份重读（仓库约每 10 分钟一次，按变化读取的看板约每 60 分钟一次，读不成就更久）。');

/** the header: the oldest check among the sources that have data; null = no source has data, nothing is shown */
export function headerText(sync: SyncState, now: number): string | null {
  return sync.checkedFrom === null ? null : t('上次检查 {ago}', { ago: ago(sync.checkedFrom, now) });
}

/** GitHub#733: the words for each step of a round (what the hover names when a round stopped moving) */
export function stepName(step: SyncStep): string {
  switch (step) {
    case 'renew':
      return t('续期登录');
    case 'saveCredential':
      return t('补存登录凭据');
    case 'grant':
      return t('读本机的登录信息');
    case 'read':
      return t('读 GitHub');
    case 'adopt':
      return t('确认账号');
    case 'store':
      return t('存到本机');
    case 'activity':
      return t('读与我相关的通知');
    case 'catchUp':
      return t('补读');
  }
}

/**
 * GitHub#733: the stall the header shows — none while GitHub cannot be reached or a source failed
 * (those have their own yellow and their own words, the two are not shown together)
 */
export function shownStall(sync: SyncState): SyncStall | null {
  if (!sync.stall || sync.offline || sync.sources.some((st) => !st.ok)) return null;
  return sync.stall;
}

/** GitHub#733: the words after 上次检查 when a round stopped moving; null = none */
export function stallText(sync: SyncState): string | null {
  const s = shownStall(sync);
  if (!s) return null;
  return s.kind === 'restarted' ? t('同步卡住，已重来') : t('同步卡住');
}

/** GitHub#733: the first lines of the hover when a round stopped moving */
export function stallLines(sync: SyncState, now: number): string[] {
  const s = shownStall(sync);
  if (!s) return [];
  const step = stepName(s.step);
  const at = clockAt(s.roundStartedAt);
  const lines: string[] = [];
  if (s.kind === 'restarted') {
    lines.push(t('{at} 开始的那一轮卡在「{step}」，3 分钟没有任何进展，客户端已放弃它（它迟到的结果不会采用）。', { at, step }));
    const r = sync.roundAt;
    if (r && r.startedAt !== s.roundStartedAt) {
      lines.push(t('正在进行的新一轮：{at} 开始，已进行 {lasted}，最后一次进展 {ago}。', { at: clockAt(r.startedAt), lasted: lasted(now - r.startedAt), ago: ago(r.lastProgressAt, now) }));
    }
  } else {
    lines.push(t('这一轮 {at} 开始，卡在「{step}」已 3 分钟没有进展。', { at, step }));
    lines.push(t('这一步不能安全地中途打断，客户端不会强行打断，正在等它结束；点刷新也要等它结束才生效。'));
    lines.push(t('一直不结束：完全退出客户端（菜单「退出」，不是关窗口）再打开。'));
  }
  return lines;
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
  const lines = stallLines(sync, now);
  const sourceLines = sync.times.map((x) =>
    x.readAt === null || x.checkedAt === null
      ? t('{source}：还没有读到过', { source: label(x.sourceKey) })
      : x.delta && x.fullAt !== undefined
        ? t('{source}：读取变化（{n} 个条目）{delta} · 整份读取 {read} · 上次检查 {checked}', {
            source: label(x.sourceKey),
            n: x.delta.count,
            delta: ago(x.delta.at, now),
            read: ago(x.fullAt, now),
            checked: ago(x.checkedAt, now),
          })
        : t('{source}：整份读取 {read} · 上次检查 {checked}', { source: label(x.sourceKey), read: ago(x.readAt, now), checked: ago(x.checkedAt, now) }),
  );
  lines.push(...sourceLines);
  for (const st of sync.sources) {
    const r = retryText(st, now);
    if (r) lines.push(t('{source}：{text}', { source: label(st.sourceKey), text: r }));
  }
  lines.push(sync.lastOnlineAt === null ? t('最后连上 GitHub：这次打开后还没有连上过') : t('最后连上 GitHub：{ago}', { ago: ago(sync.lastOnlineAt, now) }));
  // GitHub#733: when the shell's sync beat last came (desktop app only)
  if (typeof sync.beatAt === 'number') lines.push(t('最后收到定时信号：{ago}', { ago: ago(sync.beatAt, now) }));
  lines.push(checkBlind());
  if (sync.syncing && sync.progress) {
    lines.push(t('同步中，已进行 {lasted}，已读完 {done} / {total} 个来源', { lasted: lasted(now - sync.progress.startedAt), done: sync.progress.done, total: sync.progress.total }));
  }
  return lines;
}
