// GitHub#468: Settings → 顶栏计数. One row per view-bar number: name, what it counts, colour; move up /
// down / delete; add one, back to the default. Every change saves the whole table (setTallies); the
// table the window shows is always what the back end holds (state.tallies), never a copy of its own.

import type { AppState, TallyColor, TallyDef, TallyFlow } from '../shared/types';
import { effectiveTallies, TALLY_COLORS, tallyFlowText, TALLY_MAX } from '../shared/tallies';
import { flowCondition, tallyName } from '../data/flowTally';
import { t } from '../shared/i18n';
import { tNode } from './tNode';
import { Verbatim } from './Verbatim';
import { parseFilter } from '../shared/filter';
import { api } from './api';

const colorText = (c: TallyColor): string => ({ green: t('绿'), blue: t('蓝'), orange: t('橙'), red: t('红'), purple: t('紫'), gray: t('灰'), ring: t('空心圆') })[c];

function newId(taken: Set<string>): string {
  for (;;) {
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * "改成自己写条件": the label's own query — the one a click on the row puts in the box, so the number
 * stays the same ("等人处理" has no `is:open`, GitHub#462) — when it can be written exactly, otherwise
 * empty (never a query that counts something else)
 */
export function toQueryRow(d: TallyDef, labels: Record<TallyFlow, string>): TallyDef {
  if (d.source.kind !== 'flow') return d;
  const flow = d.source.flow;
  return { ...d, source: { kind: 'query', query: flowCondition(flow, labels[flow]) ?? '', from: flow } };
}

export function TallySettings({ state }: { state: AppState }) {
  const rows = effectiveTallies(state.tallies);
  const labels: Record<TallyFlow, string> = { running: state.handBack.running, agent: state.handBack.agent, human: state.handBack.human };
  const save = (next: TallyDef[]) => void api().setTallies(next);
  const patch = (i: number, d: TallyDef) => save(rows.map((x, j) => (j === i ? d : x)));
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };

  return (
    <section id="set-tallies" data-testid="tally-settings">
      <h3>{t('顶栏计数')}</h3>
      <p className="muted small">
        {t('顶栏右侧的每个数各对应下面一行，按这里的顺序、名称和颜色显示；数的是当前勾选来源里的条目，不受搜索框影响。点一下数字，搜索框换成这一行的条件、只看这些，再点一下回到之前的搜索。')}
        <br />
        {tNode('「跟随流程标签」的行按上面「流程标签」里的标签名直接数：跟随「等人处理的标签」的开着的和已关闭的都数（和提醒用同一条规则），另外两个只数开着的；标签名改了这里跟着变。自己写的条件和搜索框是同一种写法（例：{a}、{b}）。', {
          a: <code>is:open label:"bug"</code>,
          b: <code>is:pr author:@me</code>,
        })}
        <br />
        {t('系统通知和 Dock 角标仍按「等人处理的标签」数，不随这里变。')}
      </p>
      {state.talliesBroken && (
        <div className="banner warn" data-testid="tally-broken" style={{ margin: '8px 0' }}>
          {t('保存的顶栏计数读不出，现在显示的是默认的四个数；在这里改动一次就会重新保存。')}
        </div>
      )}
      <table className="tally-table" data-testid="tally-rows">
        <thead>
          <tr>
            <th>{t('名称')}</th>
            <th>{t('数什么')}</th>
            <th>{t('颜色')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((d, i) => {
            const src = d.source;
            const label = src.kind === 'flow' ? labels[src.flow].trim() : '';
            const unsupported = src.kind === 'query' ? parseFilter(src.query).unsupported : [];
            const fromLabel = src.kind === 'query' && src.from ? labels[src.from].trim() : '';
            // GitHub#471: a default row's default name shows in the window's language; saved only when edited
            const shown = tallyName({ kind: d.id, name: d.name }).text;
            return (
              <tr key={d.id} data-testid="tally-row" data-id={d.id} data-source={src.kind}>
                <td className="tally-name">
                  <input
                    key={`n:${d.name}:${shown}`}
                    data-testid="tally-name"
                    aria-label={t('名称')}
                    defaultValue={shown}
                    onBlur={(e) => e.target.value !== shown && patch(i, { ...d, name: e.target.value })}
                  />
                  {d.name.trim() === '' && <div className="tally-row-note bad" data-testid="tally-note">{t('名称为空，这一行不显示在顶栏')}</div>}
                </td>
                <td className="tally-cond">
                  {src.kind === 'flow' ? (
                    <>
                      <span className="tally-flow" data-testid="tally-flow" title={t('跟随「流程标签」里的{which}', { which: tallyFlowText(src.flow) })}>
                        {label === ''
                          ? t('跟随流程标签：{which}留空', { which: tallyFlowText(src.flow) })
                          : tNode('跟随流程标签：开着、带 {label} 标签的', {
                              label: (
                                <b>
                                  <Verbatim from="user">{label}</Verbatim>
                                </b>
                              ),
                            })}
                      </span>{' '}
                      <button className="link small" data-testid="tally-to-query" onClick={() => patch(i, toQueryRow(d, labels))}>
                        {t('改成自己写条件')}
                      </button>
                      {label === '' && <div className="tally-row-note muted" data-testid="tally-note">{t('{which}留空，这一行不显示在顶栏', { which: tallyFlowText(src.flow) })}</div>}
                      {label !== '' && flowCondition(src.flow, label) === null && (
                        <div className="tally-row-note muted" data-testid="tally-note">
                          {t('这个标签名写不进搜索框（含双引号，或以 < > 开头）：照样计数，但点数字不能筛选')}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <input
                        key={`q:${src.query}`}
                        data-testid="tally-query"
                        aria-label={t('搜索条件')}
                        placeholder={t('例：is:open label:"bug"')}
                        defaultValue={src.query}
                        onBlur={(e) => e.target.value !== src.query && patch(i, { ...d, source: { ...src, query: e.target.value } })}
                      />
                      {src.query.trim() === '' &&
                        (src.from && fromLabel !== '' && flowCondition(src.from, fromLabel) === null ? (
                          <div className="tally-row-note warn" data-testid="tally-note">
                            {tNode('标签名「{label}」写不进搜索条件（含双引号，或以 < > 开头），没法自动转换。改回「跟随流程标签」可以照常计数（点数字不能筛选，和以前一样）。', {
                              label: <Verbatim from="user">{fromLabel}</Verbatim>,
                            })}
                          </div>
                        ) : (
                          <div className="tally-row-note bad" data-testid="tally-note">{t('条件为空，这一行不显示在顶栏')}</div>
                        ))}
                      {unsupported.length > 0 && (
                        <div className="tally-row-note warn" data-testid="tally-unsupported">
                          {tNode('{words}本客户端不支持，计数和点开时都会忽略这一段（结果可能偏多）', {
                            words: <Verbatim from="user">{unsupported.map((w) => t('「{w}」', { w })).join('')}</Verbatim>,
                          })}
                        </div>
                      )}
                      {src.from && (
                        <button className="link small" data-testid="tally-to-flow" onClick={() => patch(i, { ...d, source: { kind: 'flow', flow: src.from! } })}>
                          {t('改回跟随流程标签')}
                        </button>
                      )}
                    </>
                  )}
                </td>
                <td>
                  <span className="tally-swatches" role="radiogroup" aria-label={t('颜色')}>
                    {TALLY_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`tally-swatch c-${c}`}
                        data-testid="tally-color"
                        data-color={c}
                        aria-pressed={d.color === c}
                        title={colorText(c)}
                        aria-label={colorText(c)}
                        onClick={() => d.color !== c && patch(i, { ...d, color: c })}
                      />
                    ))}
                  </span>
                </td>
                <td className="tally-moves">
                  <button className="ghost" data-testid="tally-up" title={t('上移')} aria-label={t('上移')} disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>{' '}
                  <button className="ghost" data-testid="tally-down" title={t('下移')} aria-label={t('下移')} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>{' '}
                  <button className="ghost" data-testid="tally-remove" title={t('删除')} aria-label={t('删除')} onClick={() => save(rows.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="muted small" data-testid="tally-empty">
                {t('一个都没有：顶栏不显示计数')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="tally-actions">
        <button
          className="ghost"
          data-testid="tally-add"
          disabled={rows.length >= TALLY_MAX}
          onClick={() => save([...rows, { id: newId(new Set(rows.map((r) => r.id))), name: t('新的数'), color: 'gray', source: { kind: 'query', query: 'is:open' } }])}
        >
          {t('＋ 加一个数')}
        </button>
        <button className="ghost" data-testid="tally-reset" disabled={state.tallies === null && !state.talliesBroken} onClick={() => void api().setTallies(null)}>
          {t('恢复默认')}
        </button>
        <span className="muted small">{t('最多 {n} 个；一个都不留 = 顶栏不显示计数', { n: TALLY_MAX })}</span>
      </div>
    </section>
  );
}
