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
    restartSync: () => c.restartSync(),
    openExternal: (url) => backend.call('openExternal', { url: String(url) }),
    setLaunchAtLogin: (on) => c.setLaunchAtLogin(Boolean(on)),
    checkUpdate: () => c.checkUpdate(),
    setAutoUpdate: (on) => c.setAutoUpdate(Boolean(on)),
    setUpdateChannel: (channel) => c.setUpdateChannel(channel === 'dev' ? 'dev' : 'stable'),
    dismissUpdate: (version) => c.dismissUpdate(String(version)),
    dismissInstalledUpdate: (version) => c.dismissInstalledUpdate(String(version)),
    restartToUpdate: () => c.restartToUpdate(),
    loadDetail: (key) => c.loadDetail(String(key)),
    cachedDetail: async (key) => c.cachedDetail(String(key)),
    repoOptions: (repo, fresh) => c.repoOptions(String(repo), Boolean(fresh)),
    resendEdit: (id, force) => c.resendEdit(String(id), Boolean(force)),
    abandonEdit: (id) => c.abandonEdit(String(id)),
    resendAllEdits: () => c.resendAllEdits(),
    abandonAllEdits: () => c.abandonAllEdits(),
    startCreate: (action) => c.startCreate(action),
    dismissCreate: async (id) => c.dismissCreate(Number(id)),
    retryCreateProjects: (id) => c.retryCreateProjects(Number(id)),
    applyCreateWatch: (id, key) => c.applyCreateWatch(Number(id), String(key)),
    startOp: async (action, from) => c.startOp(action, from === undefined ? {} : { from: String(from) }),
    opResend: (id) => c.opResend(String(id)),
    opFinish: (id) => c.opFinish(String(id)),
    opUnlock: async (id) => c.opUnlock(String(id)),
    opDismiss: async (id, dismissed) => c.opDismiss(String(id), dismissed !== false),
    opDropDraft: async (id) => c.opDropDraft(String(id)),
    previewMarkdown: (repo, text) => c.previewMarkdown(String(repo), String(text)),
    act: (action) => c.act(action),
    setHandBack: async (patch) => c.setHandBack(patch ?? {}),
    setMergeMethod: async (repo, method) => c.setMergeMethod(String(repo), method),
    setTableFold: async (groupBy, key, folded) => c.setTableFold(groupBy, key, folded),
    setLaneFold: async (lane, folded) => c.setLaneFold(lane, folded),
    setAutopilotConfirm: async (on) => c.setAutopilotConfirm(on),
    setClearAllOnActivate: async (on) => c.setClearAllOnActivate(on),
    reorderRepos: async (shown, next) => c.reorderRepos(shown, next),
    resetRepoOrder: async () => c.resetRepoOrder(),
    setNewIssueHandoff: async (h) => c.setNewIssueHandoff(h),
    // GitHub#314: straight to the back end, which runs every command (the controller has no part in it)
    daemonStatus: () => backend.call('daemonStatus'),
    daemonInstall: () => backend.call('daemonInstall'),
    daemonService: (key, action) => backend.call('daemonService', { key: String(key), action: action === 'start' ? 'start' : 'stop' }),
    daemonDisconnect: (key) => backend.call('daemonDisconnect', { key: String(key) }),
    daemonOpen: (key, what) => backend.call('daemonOpen', { key: String(key), what: what === 'config' ? 'config' : 'log' }),
    daemonUpdate: () => backend.call('daemonUpdate'),
    daemonConnectInfo: (repo) => backend.call('daemonConnectInfo', { repo: String(repo) }),
    daemonPrecheck: (agent) => backend.call('daemonPrecheck', { agent: String(agent) }),
    daemonCheckDir: (repo, dir) => backend.call('daemonCheckDir', { repo: String(repo), dir: String(dir) }),
    daemonPickFolder: (start) => backend.call('daemonPickFolder', start ? { start: String(start) } : {}),
    daemonConnect: (o) =>
      backend.call('daemonConnect', { repo: String(o.repo), agent: String(o.agent), ...(o.dir ? { dir: String(o.dir) } : {}), ...(o.cloneInto ? { cloneInto: String(o.cloneInto) } : {}) }),
    daemonConnectPoll: (job, from) => backend.call('daemonConnectPoll', { job: Number(job), from: Number(from) }),
  };
}
