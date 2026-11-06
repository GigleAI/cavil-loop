import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Controller } from '../app/controller';
import { localApi } from '../app/localApi';
import type { Backend, BackendInit } from '../backend/backend';
import type { Desktop } from '../app/desktop';
import './styles.css';

// The app logic runs here, in the window; the back end (Rust) holds the
// credential. Test builds (CAVIL_TEST_BRIDGE) reach the same back end through
// a loopback bridge instead of Tauri's IPC — that code is not in the app.
declare const CAVIL_TEST_BRIDGE: boolean;

async function boot() {
  let backend: Backend;
  let desktop: Desktop;
  let mounted: (detail: string) => Promise<boolean>;
  if (CAVIL_TEST_BRIDGE) {
    const bridge = await import('../backend/testBridge');
    backend = bridge.bridgeBackend();
    desktop = bridge.bridgeDesktop();
    mounted = async () => false;
  } else {
    const tauri = await import('../backend/tauri');
    backend = tauri.tauriBackend;
    desktop = tauri.tauriDesktop;
    mounted = tauri.mounted;
  }
  const init = await backend.call<BackendInit>('init');
  // The sync beat comes from the shell (src-tauri/src/desktop.rs), not from a timer in this window:
  // a hidden window's timers are slowed down by the web engine, the shell's are not (GitHub#169).
  // UI-test builds get their beats from the test, so no round fires by itself during a test.
  const controller = new Controller({ backend, endpoints: init.endpoints, desktop }, init);
  window.cavil = localApi(controller, backend);
  createRoot(document.getElementById('root')!).render(<App />);
  // the packaged-app smoke test: the views mounted and the back end answered through IPC
  for (let i = 0; i < 100 && !document.querySelector('[data-testid="app-root"]'); i++) await new Promise((r) => setTimeout(r, 100));
  const rootUp = Boolean(document.querySelector('[data-testid="app-root"]'));
  const smoke = await mounted(`${rootUp ? 'mounted' : 'NOT mounted'}; back end answered (${Object.keys(init.settings).length} settings, persistent=${init.persistent})`);
  if (smoke) return;
  void controller.runDesktopEvents();
  await controller.start();
}

void boot();
