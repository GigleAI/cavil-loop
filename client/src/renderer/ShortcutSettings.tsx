// GitHub#487: the "快捷键" section of the settings page. Every shortcut of the table in effect, grouped like the
// shortcut list; a shortcut that may be changed gets "改" (press the new key) and, once changed, "恢复默认".
// Nothing is decided here: the controller checks every change on the whole table (`changeKey` in shortcuts.ts)
// and either saves it or hands back why not; this section only shows that answer.
import { useEffect, useState } from 'react';
import type { AppState } from '../shared/types';
import { api } from './api';
import { t, tKey } from '../shared/i18n';
import { tNode } from './tNode';
import { Icon } from './Icons';
import { Keys } from './ShortcutHelp';
import { SettingsMore } from './SettingsMore';
import { SCOPE_TITLE, activeShortcuts, composing, customizable, isCustom, isMac, keyParts, shortcutName, shownKeys, type CustomKey, type Scope, type ShortcutId } from './shortcuts';

const ORDER: Scope[] = ['global', 'detail', 'graph', 'reply', 'dialog', 'settings', 'picker', 'help', 'find'];
const MODIFIERS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'OS']);

/**
 * The key a key press stands for, as kept in the settings — or null while only modifiers are held. Letters and
 * digits go by the key position when the character says nothing useful (⌥A types "å" on macOS, ⇧1 types "!").
 */
export function recordedKey(e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): CustomKey | null {
  if (MODIFIERS.has(e.key)) return null;
  const code = e.code ?? '';
  let key = e.key;
  if (/^(Digit|Numpad)[0-9]$/.test(code)) key = code.slice(-1);
  else if (/^Key[A-Z]$/.test(code) && (e.altKey || !/^[a-zA-Z]$/.test(e.key))) key = code.slice(-1).toLowerCase();
  else if (key.length === 1) key = key.toLowerCase();
  const out: CustomKey = { key };
  if (e.metaKey || e.ctrlKey) out.mod = true;
  // GitHub#492: ⌃ and ⌘ held together are a key of their own on macOS
  if (e.metaKey && e.ctrlKey) out.ctrl = true;
  if (e.shiftKey) out.shift = true;
  if (e.altKey) out.alt = true;
  return out;
}

export function ShortcutSettings({ state }: { state: AppState }) {
  const mac = isMac();
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  /** the answer to the last change of one row (refused: why) */
  const [problem, setProblem] = useState<{ id: ShortcutId; why: string } | null>(null);
  // While recording, the next key press is the new key: taken before the window's shortcut listener sees it
  // (capture phase, default prevented). Esc alone cancels; an input method's keys are never a key.
  useEffect(() => {
    if (!recording) return;
    const id = recording;
    const on = (e: KeyboardEvent) => {
      if (composing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(null);
        setProblem(null);
        return;
      }
      const spec = recordedKey(e);
      if (!spec) return;
      void Promise.resolve(api().setShortcutKey(id, spec))
        .then((r) => {
          if (r.ok) {
            setRecording(null);
            setProblem(null);
          } else setProblem({ id, why: r.why });
        })
        .catch(() => setProblem({ id, why: t('没有保存上，再按一次试试') }));
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [recording]);
  const restore = (id: ShortcutId) => {
    setRecording(null);
    void Promise.resolve(api().setShortcutKey(id, null))
      .then((r) => setProblem(r.ok ? null : { id, why: r.why }))
      .catch(() => setProblem({ id, why: t('没有保存上，再点一次试试') }));
  };
  const table = activeShortcuts();
  const anyCustom = Object.keys(state.shortcutKeys).length > 0;
  return (
    <section id="set-keys" data-testid="shortcut-settings">
      <div className="row set-keys-head">
        <h3>{t('快捷键')}</h3>
        <button
          data-testid="shortcut-reset-all"
          disabled={!anyCustom && state.shortcutDropped.length === 0}
          onClick={() => {
            setRecording(null);
            setProblem(null);
            void Promise.resolve(api().resetShortcutKeys()).catch(() => undefined);
          }}
        >
          {t('全部恢复默认')}
        </button>
      </div>
      <p className="muted small">{t('点「改」后按下新键，只在这台电脑生效。')}</p>
      {/* GitHub#514: the longer rules, folded */}
      <SettingsMore title={t('哪些键固定、单个键何时生效')} testid="keys-more">
        {t('一个操作改成一个键，原来的键随之不再起作用。Esc、↩、方向键、{first} … {last}、{close} 和缩放键是固定的，不能改。不带 {mod} 的单个键只在光标不在输入框里时生效。', {
          first: `${mac ? '⌘' : 'Ctrl+'}1`,
          last: `${mac ? '⌘' : 'Ctrl+'}9`,
          close: `${mac ? '⌘' : 'Ctrl+'}W`,
          mod: mac ? '⌘' : 'Ctrl',
        })}
      </SettingsMore>
      {state.shortcutDropped.length > 0 && (
        <div className="banner warn" data-testid="shortcut-dropped">
          <Icon name="warn" />
          <span>
            {tNode('上次保存的快捷键里有 {n} 项这次不能用，已按默认处理：{list}。这一项改过或恢复后，这条提示消失。', {
              n: state.shortcutDropped.length,
              list: state.shortcutDropped.map((d, i) => (
                <span key={`${d.id}:${i}`} data-testid="shortcut-dropped-item" data-id={d.id}>
                  {i > 0 && t('；')}
                  {t('「{name}」（{why}）', { name: d.name, why: d.why })}
                </span>
              )),
            })}
          </span>
        </div>
      )}
      {ORDER.map((scope) => {
        const rows = table.filter((s) => s.scope === scope);
        if (!rows.length) return null;
        return (
          <div key={scope}>
            <div className="sk-group">{tKey(SCOPE_TITLE[scope])}</div>
            <table className="sk-table">
              <tbody>
                {rows.map((s) => {
                  const rec = recording === s.id;
                  const custom = isCustom(s.id);
                  const can = customizable(s.id);
                  const own = state.shortcutKeys[s.id];
                  const err = problem?.id === s.id ? problem.why : null;
                  const shown = shownKeys(s, mac);
                  return [
                    <tr key={s.id} className={rec ? 'recording' : ''} data-testid="shortcut-setting" data-id={s.id} data-custom={custom ? 'yes' : 'no'}>
                      <td>
                        {shortcutName(s.id)}
                        {custom && scope === 'detail' && own && !own.mod && (
                          <div className="muted small" data-testid="shortcut-plain-note">
                            {s.id === 'reply' ? t('不带 {mod} 的键在回复框里按是打字', { mod: mac ? '⌘' : 'Ctrl' }) : t('不带 {mod} 的键在回复框、讨论区里按不生效', { mod: mac ? '⌘' : 'Ctrl' })}
                          </div>
                        )}
                      </td>
                      <td className="k" data-testid="shortcut-setting-keys">
                        {rec ? (
                          <span className="rec" data-testid="shortcut-recording">
                            {tNode('请按新的按键…{esc} 取消', { esc: <kbd>Esc</kbd> })}
                          </span>
                        ) : s.range ? (
                          <span>
                            <Keys parts={keyParts(s.keys[0], mac)} />
                            <span className="muted"> … </span>
                            <Keys parts={keyParts(s.keys[s.keys.length - 1], mac)} />
                          </span>
                        ) : (
                          shown.map((k, i) => (
                            <span key={i}>
                              {i > 0 && <span className="muted"> / </span>}
                              <Keys parts={keyParts(k, mac)} />
                            </span>
                          ))
                        )}
                        {custom && !rec && <span className="chg">{t('已改')}</span>}
                      </td>
                      <td className="a">
                        {!can ? (
                          <span className="fixed" title={t('固定的键，不能改')}>
                            {t('固定')}
                          </span>
                        ) : rec ? (
                          <button className="link" data-testid="shortcut-cancel" onClick={() => (setRecording(null), setProblem(null))}>
                            {t('取消')}
                          </button>
                        ) : (
                          <>
                            <button className="link" data-testid="shortcut-change" onClick={() => (setProblem(null), setRecording(s.id))}>
                              {t('改')}
                            </button>
                            {custom && (
                              <button className="link" data-testid="shortcut-restore" onClick={() => restore(s.id)}>
                                {t('恢复默认')}
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>,
                    err && (
                      <tr key={`${s.id}:err`}>
                        <td colSpan={3}>
                          <div className="banner warn sk-err" data-testid="shortcut-problem">
                            <Icon name="warn" />
                            <span>{err}</span>
                          </div>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}
