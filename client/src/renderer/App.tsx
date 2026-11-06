import { useEffect, useMemo, useState } from 'react';
import type { Snapshot } from '../shared/ipc';
import { parseFilter } from '../shared/filter';
import { api } from './api';
import { LoginView } from './LoginView';
import { BoardView, type BoardWarnings } from './BoardView';
import { SettingsView } from './SettingsView';
import { AppKindHelp } from './AppKindHelp';
import { useQuery } from './query';
import { dismiss, isShown, notifyWarningIds, reconcile, warningIds, type Dismissed } from './warnings';

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
          onSettings={() => setPage('settings')}
        />
      )}
    </div>
  );
}
