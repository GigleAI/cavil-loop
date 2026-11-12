// What can be done with an item, on a right click (GitHub#442): open it in the floating panel (what a
// plain click does), in a tab in front (⌘ / Ctrl + click), in a tab in the background (the middle
// button), or on GitHub. Drawn in the window, not a system menu: the same on every system.
import { useEffect, useRef } from 'react';
import { useLayer, useShortcuts } from './keyboard';
import { KEEPS_PANEL } from './outsideClick';
import { isMac } from './shortcuts';

export type OpenHow = 'float' | 'front' | 'back';

export type OpenMenuAt = { key: string; url: string; x: number; y: number };

export function OpenMenu({ at, onPick, onWeb, onClose }: { at: OpenMenuAt; onPick: (how: OpenHow) => void; onWeb: () => void; onClose: () => void }) {
  // a layer: Esc closes it, and no other shortcut acts while it is open
  useLayer('dialog');
  useShortcuts({ cancel: onClose });
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    box.current?.querySelector('button')?.focus();
    // a press anywhere else, the window losing focus, a scroll or a resize: the menu goes
    const away = (e: Event) => {
      if (e.target instanceof Node && box.current?.contains(e.target)) return;
      closeRef.current();
    };
    const gone = () => closeRef.current();
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('scroll', away, true);
    window.addEventListener('blur', gone);
    window.addEventListener('resize', gone);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('blur', gone);
      window.removeEventListener('resize', gone);
    };
  }, []);
  // kept inside the window
  const W = 240;
  const H = 150;
  const left = Math.max(4, Math.min(at.x, window.innerWidth - W - 4));
  const top = Math.max(4, Math.min(at.y, window.innerHeight - H - 4));
  const mod = isMac() ? '⌘ 单击' : 'Ctrl+单击';
  const item = (how: OpenHow, text: string, hint: string) => (
    <button role="menuitem" data-testid={`open-menu-${how}`} onClick={() => onPick(how)}>
      <span>{text}</span>
      <span className="hint">{hint}</span>
    </button>
  );
  return (
    <div
      ref={box}
      className="open-menu"
      role="menu"
      data-testid="open-menu"
      data-key={at.key}
      style={{ left, top }}
      {...{ [KEEPS_PANEL]: '' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {item('float', '在浮窗打开', '单击')}
      {item('front', '在新标签页打开', mod)}
      {item('back', '在后台标签页打开', '中键')}
      <hr />
      <button role="menuitem" data-testid="open-menu-web" onClick={onWeb}>
        <span>在 GitHub 网页上看</span>
      </button>
    </div>
  );
}
