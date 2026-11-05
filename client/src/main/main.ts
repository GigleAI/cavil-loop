// Electron main process: one window, the controller, IPC. Everything the
// app decides lives in controller.ts / data/; this file only wires it up.

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from './controller';
import { Cache } from '../data/cache';
import { createPlatform } from '../platform';
import { IPC, type Snapshot } from '../shared/ipc';
import type { ViewSettings } from '../shared/types';

const smoke = process.argv.includes('--smoke-test');
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

app.whenReady().then(async () => {
  const platform = createPlatform({ platform: process.platform, env: process.env, shellOpen: (u) => shell.openExternal(u) });
  const cache = new Cache(join(app.getPath('userData'), 'cache.sqlite'));
  const controller = new Controller({
    credentials: platform.credentials,
    endpoints: platform.endpoints,
    cache,
    openExternal: (u) => platform.openExternal(u),
  });

  const win = new BrowserWindow({
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
  win.once('ready-to-show', () => {
    if (!smoke) win.show();
  });
  // Links never navigate the app window: GitHub links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    platform.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const snapshot = (): Snapshot => ({ state: controller.getState(), data: controller.getBoardData() });
  controller.onChange(() => {
    if (!win.isDestroyed()) win.webContents.send(IPC.push, snapshot());
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

  if (smoke) {
    const timer = setTimeout(() => smokeResult(false, 'timeout'), 30_000);
    win.webContents.once('did-finish-load', async () => {
      try {
        for (let i = 0; i < 100; i++) {
          const ok = await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-testid="app-root"]'))`);
          if (ok) {
            clearTimeout(timer);
            return smokeResult(true, `${process.platform}-${process.arch} electron ${process.versions.electron}`);
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        smokeResult(false, 'renderer did not mount');
      } catch (e) {
        smokeResult(false, (e as Error).message);
      }
    });
  }

  await win.loadFile(join(__dirname, '../renderer/index.html'));
  if (!smoke) {
    await controller.start();
    controller.startTimer();
  }
});

// v1: closing the window quits (background mode comes with notifications, sub-item 4).
app.on('window-all-closed', () => app.quit());
