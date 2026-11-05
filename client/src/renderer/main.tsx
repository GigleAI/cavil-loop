import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Controller } from '../app/controller';
import { localApi } from '../app/localApi';
import type { Backend, BackendInit } from '../backend/backend';
import './styles.css';

// The app logic runs here, in the window; the back end (Rust) holds the
// credential. Test builds (CAVIL_TEST_BRIDGE) reach the same back end through
// a loopback bridge instead of Tauri's IPC — that code is not in the app.
declare const CAVIL_TEST_BRIDGE: boolean;

async function boot() {
  let backend: Backend;
  let mounted: (detail: string) => Promise<boolean>;
  if (CAVIL_TEST_BRIDGE) {
    const bridge = await import('../backend/testBridge');
    backend = bridge.bridgeBackend();
    mounted = async () => false;
  } else {
    const tauri = await import('../backend/tauri');
    backend = tauri.tauriBackend;
    mounted = tauri.mounted;
  }
  const init = await backend.call<BackendInit>('init');
  const controller = new Controller({ backend, endpoints: init.endpoints }, init);
  window.cavil = localApi(controller, backend);
  createRoot(document.getElementById('root')!).render(<App />);
  // the packaged-app smoke test: the views mounted and the back end answered through IPC
  for (let i = 0; i < 100 && !document.querySelector('[data-testid="app-root"]'); i++) await new Promise((r) => setTimeout(r, 100));
  const rootUp = Boolean(document.querySelector('[data-testid="app-root"]'));
  const smoke = await mounted(`${rootUp ? 'mounted' : 'NOT mounted'}; back end answered (${Object.keys(init.settings).length} settings, persistent=${init.persistent})`);
  if (smoke) return;
  await controller.start();
  controller.startTimer();
}

void boot();
