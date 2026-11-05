import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type CavilApi, type Snapshot } from '../shared/ipc';

const api: CavilApi = {
  get: () => ipcRenderer.invoke(IPC.get),
  subscribe(cb) {
    const h = (_e: unknown, s: Snapshot) => cb(s);
    ipcRenderer.on(IPC.push, h);
    return () => ipcRenderer.removeListener(IPC.push, h);
  },
  startLogin: () => ipcRenderer.invoke(IPC.startLogin),
  cancelLogin: () => ipcRenderer.invoke(IPC.cancelLogin),
  openVerification: () => ipcRenderer.invoke(IPC.openVerification),
  logout: () => ipcRenderer.invoke(IPC.logout),
  setAppKind: (kind) => ipcRenderer.invoke(IPC.setAppKind, kind),
  setClientId: (id) => ipcRenderer.invoke(IPC.setClientId, id),
  addSource: (input) => ipcRenderer.invoke(IPC.addSource, input),
  removeSource: (key) => ipcRenderer.invoke(IPC.removeSource, key),
  setView: (patch) => ipcRenderer.invoke(IPC.setView, patch),
  syncNow: () => ipcRenderer.invoke(IPC.syncNow),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  setLaunchAtLogin: (on) => ipcRenderer.invoke(IPC.setLaunchAtLogin, on),
  loadDetail: (key) => ipcRenderer.invoke(IPC.loadDetail, key),
  repoOptions: (repo) => ipcRenderer.invoke(IPC.repoOptions, repo),
  previewMarkdown: (repo, text) => ipcRenderer.invoke(IPC.previewMarkdown, repo, text),
  act: (action) => ipcRenderer.invoke(IPC.act, action),
  setHandBack: (patch) => ipcRenderer.invoke(IPC.setHandBack, patch),
};

contextBridge.exposeInMainWorld('cavil', api);
