// The shortcut list (GitHub#192), drawn from the same table the keys act on (shortcuts.ts).
import { useEffect, useRef } from 'react';
import { SCOPE_TITLE, SHORTCUTS, isMac, keyParts, shownKeys, type Scope } from './shortcuts';
import { useLayer, useShortcuts } from './keyboard';

const ORDER: Scope[] = ['global', 'dialog', 'detail', 'graph', 'settings', 'reply', 'picker', 'help'];

export function Keys({ parts }: { parts: string[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <kbd key={i}>{p}</kbd>
      ))}
    </>
  );
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  useLayer('help');
  useShortcuts({ helpClose: onClose });
  const box = useRef<HTMLDivElement>(null);
  // the keyboard leaves whatever field it was in: the list is on top now
  useEffect(() => box.current?.focus(), []);
  const mac = isMac();
  return (
    <div className="modal-back" data-testid="shortcut-help" onClick={onClose}>
      <div className="modal shortcuts" role="dialog" aria-modal="true" tabIndex={-1} ref={box} onClick={(e) => e.stopPropagation()}>
        <h3>键盘快捷键</h3>
        <div className="shortcut-groups">
          {ORDER.map((scope) => (
            <section key={scope}>
              <h4>{SCOPE_TITLE[scope]}</h4>
              <table>
                <tbody>
                  {SHORTCUTS.filter((s) => s.scope === scope).map((s) => (
                    <tr key={s.id} data-testid="shortcut-row" data-id={s.id}>
                      <td>{s.label}</td>
                      <td className="keys">
                        {s.range ? (
                          // GitHub#442: one run of keys (⌘1 … ⌘9), its first and last
                          <span>
                            <Keys parts={keyParts(s.keys[0], mac)} />
                            <span className="muted"> … </span>
                            <Keys parts={keyParts(s.keys[s.keys.length - 1], mac)} />
                          </span>
                        ) : (
                          shownKeys(s, mac).map((k, i) => (
                            <span key={i}>
                              {i > 0 && <span className="muted"> / </span>}
                              <Keys parts={keyParts(k, mac)} />
                            </span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <p className="small muted">
          单个字母的快捷键只在光标不在输入框里时生效；输入法正在拼字时，快捷键一律不响应。放大 / 缩小 / 实际大小在「缩放」菜单里（⌘= / ⌘- / ⌘0）。点过讨论区之后，键盘停在讨论区里，先点一下讨论区以外的地方。
        </p>
        <div className="row end">
          <button data-testid="shortcut-help-close" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
