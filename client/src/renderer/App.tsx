import { useEffect, useState } from 'react';
import type { Snapshot } from '../shared/ipc';
import { api } from './api';
import { LoginView } from './LoginView';
import { BoardView } from './BoardView';
import { SettingsView } from './SettingsView';
import { AppKindHelp } from './AppKindHelp';

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
        <BoardView state={snap.state} data={snap.data} onSettings={() => setPage('settings')} />
      )}
    </div>
  );
}
