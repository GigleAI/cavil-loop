// GitHub#502: the find bar (⌘F). It only draws the state kept in findInPage.ts and passes on what is typed and
// pressed; finding, highlighting and the discussion frames are all there.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from './Icons';
import { closeFind, findView, setFindQuery, stepFind, subscribeFind } from './findInPage';
import { useShortcuts } from './keyboard';
import { keyText } from './shortcuts';

/** under the board's header when it is showing, else at the top of the page area */
function topOf(): number {
  const hdr = document.querySelector('.tab-page[data-front="yes"] header.hdr');
  const r = hdr?.getBoundingClientRect();
  if (r && r.height > 0) return Math.round(r.bottom) + 6;
  const pages = document.querySelector('.tab-pages');
  return pages ? Math.round(pages.getBoundingClientRect().top) + 8 : 8;
}

export function FindBar() {
  const v = useSyncExternalStore(subscribeFind, findView);
  const input = useRef<HTMLInputElement>(null);
  const [top, setTop] = useState(56);
  // ↩ / ⇧↩ / Esc while the keyboard is in the bar (shortcuts.ts, typing 'find')
  useShortcuts({ findBarNext: () => stepFind(1), findBarPrev: () => stepFind(-1), findBarClose: () => closeFind() });
  useLayoutEffect(() => {
    if (!v.open) return;
    const place = () => setTop(topOf());
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [v.open]);
  useEffect(() => {
    if (!v.open) return;
    input.current?.focus();
    input.current?.select();
  }, [v.open, v.focusSeq]);
  if (!v.open) return null;
  const none = v.query !== '' && v.total === 0 && !v.pending;
  const count = v.query === '' ? '' : v.total > 0 ? `${v.pos} / ${v.total}` : v.pending ? '…' : '没有找到';
  return (
    <div className="find-bar" data-testid="find-bar" data-find-skip="" role="search" style={{ top }}>
      <div className={`find-box${none ? ' none' : ''}`}>
        <Icon name="search" size={14} />
        <input
          ref={input}
          data-testid="find-input"
          data-keys="find"
          aria-label="在页面上查找"
          placeholder="在页面上查找"
          maxLength={1000}
          value={v.query}
          spellCheck={false}
          onChange={(e) => setFindQuery(e.target.value)}
        />
        <span className="find-count" data-testid="find-count" data-total={v.total} data-pos={v.pos} data-pending={v.pending ? 'yes' : 'no'}>
          {count}
        </span>
      </div>
      <span className="find-sep" />
      <button className="find-btn up" data-testid="find-prev" title={`上一处（⇧↩ / ${keyText('findPrev')}）`} aria-label="上一处" disabled={v.total === 0} onClick={() => stepFind(-1)}>
        <Icon name="chevron" />
      </button>
      <button className="find-btn" data-testid="find-next" title={`下一处（↩ / ${keyText('findNext')}）`} aria-label="下一处" disabled={v.total === 0} onClick={() => stepFind(1)}>
        <Icon name="chevron" />
      </button>
      <button className="find-btn" data-testid="find-close" title="关闭（Esc）" aria-label="关闭查找" onClick={() => closeFind()}>
        <Icon name="x" />
      </button>
    </div>
  );
}
