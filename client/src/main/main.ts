// Electron main process: one window, the controller, IPC. Everything the
// app decides lives in controller.ts / data/; this file only wires it up.

import { app, BrowserWindow, ipcMain, Notification, shell } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from './controller';
import { itemAlertText } from '../data/pending';
import { Cache } from '../data/cache';
import { createPlatform } from '../platform';
import { IPC, type Snapshot } from '../shared/ipc';
import type { ViewSettings } from '../shared/types';

// --notify-check implies the smoke test: after the window mounts, one real
// notification goes through the production path (platform layer → system
// notification) and the result (shown / failed / timeout) is part of the
// smoke line. Used by scripts/mac-open-check.sh on the packaged app.
const notifyCheck = process.argv.includes('--notify-check');
const smoke = notifyCheck || process.argv.includes('--smoke-test');
const smokeOut = process.argv.find((a) => a.startsWith('--smoke-out='))?.slice('--smoke-out='.length);

// Separate data dirs: the smoke test must not touch a real install, the UI
// tests point it at a temp dir (test mode only).
if (smoke) app.setPath('userData', mkdtempSync(join(tmpdir(), 'cavil-smoke-')));
else if (process.env.CAVIL_CLIENT_TEST_MODE === '1' && process.env.CAVIL_CLIENT_USER_DATA) {
  app.setPath('userData', process.env.CAVIL_CLIENT_USER_DATA);
}

function smokeResult(ok: boolean, detail: string) {
  const line = ok ? `CAVIL_SMOKE_OK ${detail}` : `CAVIL_SMOKE_FAIL ${detail}`;
  console.log(line);
  if (smokeOut) writeFileSync(smokeOut, `${line}\n`);
  app.exit(ok ? 0 : 1);
}

if (!smoke && !app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
/** set when the user really quits (menu, Cmd+Q, logout of macOS): closing the window then closes it */
let quitting = false;
app.on('before-quit', () => {
  quitting = true;
});
function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
// a second launch (Dock, Finder, Spotlight) brings the running one up
app.on('second-instance', showWindow);
// macOS: clicking the Dock icon with the window hidden
app.on('activate', showWindow);

/** notifications must stay referenced until clicked, or the click handler is collected */
const liveNotifications = new Set<Notification>();
/** --notify-check: told what happened to each notification ('shown', 'failed: …', 'unsupported') */
let notifyProbe: ((result: string) => void) | null = null;

app.whenReady().then(async () => {
  const platform = createPlatform({
    platform: process.platform,
    env: process.env,
    shellOpen: (u) => shell.openExternal(u),
    os: {
      notify(title, body, onClick) {
        if (!Notification.isSupported()) {
          notifyProbe?.('unsupported');
          return;
        }
        const n = new Notification({ title, body });
        liveNotifications.add(n);
        n.on('show', () => notifyProbe?.('shown'));
        n.on('failed', (_e, error) => notifyProbe?.(`failed: ${error}`));
        n.on('click', () => {
          liveNotifications.delete(n);
          onClick();
        });
        n.on('close', () => liveNotifications.delete(n));
        n.show();
      },
      setBadgeCount: (count) => void app.setBadgeCount(count),
      getOpenAtLogin: () => app.getLoginItemSettings().openAtLogin,
      setOpenAtLogin: (on) => app.setLoginItemSettings({ openAtLogin: on }),
      showWindow,
    },
  });
  const cache = new Cache(join(app.getPath('userData'), 'cache.sqlite'));
  const controller = new Controller({
    credentials: platform.credentials,
    endpoints: platform.endpoints,
    cache,
    openExternal: (u) => platform.openExternal(u),
    ...(platform.alerts ? { alerts: platform.alerts } : {}),
    ...(platform.loginItem ? { loginItem: platform.loginItem } : {}),
  });

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'Cavil Loop',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // started by "launch at login": stay in the background until the user opens it
  const openedAtLogin = platform.loginItem ? app.getLoginItemSettings().wasOpenedAtLogin : false;
  win.once('ready-to-show', () => {
    if (!smoke && !openedAtLogin) win?.show();
  });
  // Background mode: closing the window hides it; the app keeps syncing and
  // notifying (macOS keeps it in the Dock). Quitting for real goes through `quitting`.
  win.on('close', (e) => {
    if (platform.keepRunningWhenClosed && !quitting && !smoke) {
      e.preventDefault();
      win?.hide();
    }
  });
  const w = win;
  // Links never navigate the app window: GitHub links go to the system browser.
  w.webContents.setWindowOpenHandler(({ url }) => {
    platform.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());

  const snapshot = (): Snapshot => ({ state: controller.getState(), data: controller.getBoardData() });
  controller.onChange(() => {
    if (!w.isDestroyed()) w.webContents.send(IPC.push, snapshot());
  });
  ipcMain.handle(IPC.get, () => snapshot());
  ipcMain.handle(IPC.startLogin, () => void controller.startLogin());
  ipcMain.handle(IPC.cancelLogin, () => controller.cancelLogin());
  ipcMain.handle(IPC.openVerification, () => controller.openVerification());
  ipcMain.handle(IPC.logout, () => controller.logout());
  ipcMain.handle(IPC.setAppKind, (_e, kind: string) => controller.setAppKind(String(kind)));
  ipcMain.handle(IPC.setClientId, (_e, id: string) => controller.setClientId(String(id)));
  ipcMain.handle(IPC.addSource, (_e, input: string) => controller.addSource(String(input)));
  ipcMain.handle(IPC.removeSource, (_e, key: string) => controller.removeSource(String(key)));
  ipcMain.handle(IPC.setView, (_e, patch: Partial<ViewSettings>) => controller.setView(patch));
  ipcMain.handle(IPC.syncNow, () => controller.syncNow());
  ipcMain.handle(IPC.openExternal, (_e, url: string) => platform.openExternal(String(url)));
  ipcMain.handle(IPC.setPendingLabel, (_e, name: string) => controller.setPendingLabel(String(name)));
  ipcMain.handle(IPC.setLaunchAtLogin, (_e, on: boolean) => controller.setLaunchAtLogin(on === true));

  /** One notification through the same platform call a sync round uses; what the system reported back. */
  const probeNotification = async (): Promise<string> => {
    if (!platform.alerts) return 'no-alerts-on-this-platform';
    const result = new Promise<string>((resolve) => {
      notifyProbe = resolve;
      setTimeout(() => resolve('timeout (no show / failed event in 15 s)'), 15_000);
    });
    const sample = { key: 'gigleai/cavil-loop#139', repo: 'GigleAI/cavil-loop', number: 139, title: 'notify check', url: 'https://github.com/GigleAI/cavil-loop/issues/139', kind: 'issue' as const, state: 'open' as const };
    platform.alerts.notify({ kind: 'item', key: sample.key, url: sample.url, ...itemAlertText({ ...sample, updatedAt: '', labels: [], assignees: [], milestone: null, projects: [], sources: [] }) });
    const r = await result;
    notifyProbe = null;
    // keep it on screen a moment so the check script can capture it
    if (r === 'shown') await new Promise((res) => setTimeout(res, 3000));
    return r;
  };

  if (smoke) {
    const timer = setTimeout(() => smokeResult(false, 'timeout'), 60_000);
    w.webContents.once('did-finish-load', async () => {
      try {
        for (let i = 0; i < 100; i++) {
          const ok = await w.webContents.executeJavaScript(`Boolean(document.querySelector('[data-testid="app-root"]'))`);
          if (ok) {
            clearTimeout(timer);
            const base = `${process.platform}-${process.arch} electron ${process.versions.electron} notifications=${Notification.isSupported() ? 'supported' : 'unsupported'}`;
            if (!notifyCheck) return smokeResult(true, base);
            return smokeResult(true, `${base} notify-check=${await probeNotification()}`);
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        smokeResult(false, 'renderer did not mount');
      } catch (e) {
        smokeResult(false, (e as Error).message);
      }
    });
  }

  await w.loadFile(join(__dirname, '../renderer/index.html'));
  if (!smoke) {
    await controller.start();
    controller.startTimer();
  }
});

// Where the platform keeps the app running in the background the window is only
// hidden, so this fires only when quitting (or where background mode is off).
app.on('window-all-closed', () => app.quit());
