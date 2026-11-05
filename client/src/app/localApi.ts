// `window.cavil`: the API the views use, served by the controller that runs in
// this same window. The views never see the back end or the credential.

import type { CavilApi, Snapshot } from '../shared/ipc';
import type { Backend } from '../backend/backend';
import type { Controller } from './controller';

export function localApi(c: Controller, backend: Backend): CavilApi {
  const snapshot = (): Snapshot => ({ state: c.getState(), data: c.getBoardData() });
  return {
    get: async () => snapshot(),
    subscribe(cb) {
      return c.onChange(() => cb(snapshot()));
    },
    startLogin: async () => void c.startLogin(),
    cancelLogin: async () => c.cancelLogin(),
    openVerification: () => c.openVerification(),
    logout: () => c.logout(),
    setAppKind: async (kind) => c.setAppKind(String(kind)),
    setClientId: async (id) => c.setClientId(String(id)),
    addSource: async (input) => c.addSource(String(input)),
    removeSource: async (key) => c.removeSource(String(key)),
    setView: async (patch) => c.setView(patch),
    syncNow: () => c.syncNow(),
    openExternal: (url) => backend.call('openExternal', { url: String(url) }),
    loadDetail: (key) => c.loadDetail(String(key)),
    repoOptions: (repo) => c.repoOptions(String(repo)),
    previewMarkdown: (repo, text) => c.previewMarkdown(String(repo), String(text)),
    act: (action) => c.act(action),
    setHandBack: async (patch) => c.setHandBack(patch ?? {}),
  };
}
