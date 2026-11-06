import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '../shared/ipc';
import { parseFilter } from '../shared/filter';
import { api } from './api';
import { LoginView } from './LoginView';
import { BoardView, type BoardWarnings } from './BoardView';
import { SettingsView } from './SettingsView';
import { AppKindHelp } from './AppKindHelp';
import { useQuery } from './query';
import { dismiss, isShown, notifyWarningIds, reconcile, warningIds, type Dismissed } from './warnings';
import { useKeyboard, useShortcuts } from './keyboard';
import { ShortcutHelp } from './ShortcutHelp';

/** a shortcut that needs the board (GitHub#192): taken once by the board, then dropped */
export type BoardRequest = { kind: 'search' | 'newIssue'; seq: number };

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<'board' | 'settings'>('board');
  const [help, setHelp] = useState(false);
  const openHelp = () => setHelp(true);
  useEffect(() => {
    let alive = true;
    const off = api().subscribe((s) => alive && setSnap(s));
    api()
      .get()
      .then((s) => alive && setSnap(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // The search box text and the closed yellow bars live here, not in the
  // board: the board is unmounted while the settings page is up, and a
  // problem that clears (or a filter an import replaces) meanwhile must still
  // drop the record (GitHub#153). Closed bars are kept for this run only.
  // A clicked notification (GitHub#169): back to the board, which opens that item once.
  // The request lives here and is dropped once the board took it, so coming back to the
  // board later (it is unmounted while Settings is up) never reopens an old click.
  const focus = snap?.state.focus ?? null;
  const [focusReq, setFocusReq] = useState<{ key: string; seq: number } | null>(null);
  useEffect(() => {
    if (!focus) return;
    setHelp(false);
    setPage('board');
    setFocusReq(focus);
  }, [focus?.seq]);

  // Keyboard shortcuts (GitHub#192). They live here, the layer that stays mounted on every page:
  // the board is unmounted while Settings (or the app-kind page) is up. Shortcuts that need the
  // board go back to it first and hand it a request, taken once (like a clicked notification).
  const signedIn = snap?.state.phase === 'ready';
  const keysOn = signedIn;
  useKeyboard(keysOn);
  const [keysHelp, setKeysHelp] = useState(false);
  const [boardReq, setBoardReq] = useState<BoardRequest | null>(null);
  const reqSeq = useRef(0);
  const toBoard = (kind: BoardRequest['kind']) => {
    setHelp(false);
    setPage('board');
    setBoardReq({ kind, seq: ++reqSeq.current });
  };
  useShortcuts({
    search: () => toBoard('search'),
    newIssue: () => toBoard('newIssue'),
    sync: () => {
      if (!snap?.state.sync.syncing) void api().syncNow();
    },
    settings: () => {
      setHelp(false);
      setPage('settings');
    },
    help: () => setKeysHelp(true),
  });

  const [query, setQuery] = useQuery(snap?.state.view.query ?? '');
  const parsed = useMemo(() => parseFilter(query), [query]);
  const sync = snap?.state.sync;
  const notifyProblem = snap?.state.notifyProblem ?? null;
  const current = useMemo(() => (sync ? { ...warningIds(sync, parsed), ...notifyWarningIds(notifyProblem) } : null), [sync, parsed, notifyProblem]);
  const [closed, setClosed] = useState<Dismissed>({});
  // reconciled on every render, whichever page is showing; nothing is judged before the first snapshot
  const live = current ? reconcile(closed, current) : closed;
  if (live !== closed) setClosed(live);
  const warn: BoardWarnings = {
    shown: (kind) => current !== null && isShown(kind, current, live),
    close: (kind) => {
      if (current) setClosed((d) => dismiss(d, current, kind));
    },
  };

  return (
    <div data-testid="app-root" className="app" data-phase={snap?.state.phase ?? 'loading'}>
      {!snap || snap.state.phase === 'loading' ? (
        <div className="center muted">正在启动…</div>
      ) : help ? (
        <AppKindHelp onBack={() => setHelp(false)} />
      ) : snap.state.phase === 'login' ? (
        <LoginView state={snap.state} onHelp={openHelp} />
      ) : page === 'settings' ? (
        <SettingsView state={snap.state} data={snap.data} onBack={() => setPage('board')} onHelp={openHelp} />
      ) : (
        <BoardView
          state={snap.state}
          data={snap.data}
          query={query}
          setQuery={setQuery}
          parsed={parsed}
          warn={warn}
          focus={focusReq}
          onFocusTaken={() => setFocusReq(null)}
          request={boardReq}
          onRequestTaken={() => setBoardReq(null)}
          onSettings={() => setPage('settings')}
          onKeysHelp={() => setKeysHelp(true)}
        />
      )}
      {keysOn && keysHelp && <ShortcutHelp onClose={() => setKeysHelp(false)} />}
    </div>
  );
}
