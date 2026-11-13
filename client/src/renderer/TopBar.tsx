// The window's one top row (GitHub#467): logo, the tabs (or the app's name while none is open), and
// the board's tools — search, sync state, refresh, new issue, settings, the account. It replaces the
// tab bar and the board's own top row, and belongs to the whole window: a detail tab in front keeps
// the tools. The tools are the board's (BoardView draws them into `tools` through a portal), so
// there is one search box and one new-issue button, whatever is in front.
//
// On macOS the row is the window's title bar (src-tauri/src/main.rs): the page is drawn under it,
// the three window buttons sit at its left, and a press on an empty part of it moves the window, a
// double click zooms it. Elsewhere the system keeps its own title bar and none of that applies.
import { useEffect, useState, type ReactNode } from 'react';
import type { WindowFrame } from '../shared/ipc';
import { api } from './api';
import brandIcon from '../../build/icon.png';

/** what in the row is not "empty": a press there is that control's, never a window move */
const NOT_EMPTY = 'button, a, input, select, textarea, label, [role="tab"], [data-no-drag]';

/** How the window's top row sits, read again whenever the window changes size (entering / leaving full screen does). */
export function useWindowFrame(): WindowFrame {
  const [frame, setFrame] = useState<WindowFrame>({ overlay: false, fullscreen: false });
  useEffect(() => {
    let alive = true;
    const read = () =>
      void Promise.resolve(api().windowFrame?.())
        .then((f) => {
          if (!alive || !f) return;
          setFrame((cur) => (cur.overlay === f.overlay && cur.fullscreen === f.fullscreen ? cur : f));
        })
        .catch(() => undefined);
    read();
    window.addEventListener('resize', read);
    return () => {
      alive = false;
      window.removeEventListener('resize', read);
    };
  }, []);
  return frame;
}

export function TopBar({
  frame,
  tabs,
  onTools,
  plain,
}: {
  frame: WindowFrame;
  /** the tab bar, while a tab is open (null: the app's name in its place) */
  tabs: ReactNode | null;
  /** where the board draws its tools (null: no tools in this row, e.g. on the sign-in page) */
  onTools?: (el: HTMLDivElement | null) => void;
  /** the sign-in / start-up pages: only the empty row the window is moved by */
  plain?: boolean;
}) {
  const own = frame.overlay;
  return (
    <header
      className={`topbar${own ? ' own-frame' : ''}${own && !frame.fullscreen ? ' with-lights' : ''}${plain ? ' plain' : ''}`}
      data-testid="topbar"
      data-frame={own ? (frame.fullscreen ? 'fullscreen' : 'overlay') : 'system'}
      onMouseDown={(e) => {
        if (!own || e.button !== 0 || !(e.target instanceof Element) || e.target.closest(NOT_EMPTY)) return;
        // the second press of a double click zooms the window (as on a macOS title bar); the first moves it
        if (e.detail === 2) void Promise.resolve(api().toggleZoom()).catch(() => undefined);
        else if (e.detail === 1) void Promise.resolve(api().startDrag()).catch(() => undefined);
      }}
    >
      {!plain && (
        <>
          <img className="topbar-logo" src={brandIcon} alt="" />
          {tabs ?? (
            <span className="topbar-name" data-testid="topbar-name">
              Cavil Loop
            </span>
          )}
          <div className="topbar-tools" data-testid="topbar-tools" ref={onTools} />
        </>
      )}
    </header>
  );
}
