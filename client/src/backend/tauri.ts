// The app's transport to the back end: Tauri's IPC, one command (`backend`,
// src-tauri/src/main.rs). Only loaded inside the Tauri window.
//
// The desktop side (notifications, Dock badge, launch at login, sync beat) is
// the shell's, not the back end's: separate commands (src-tauri/src/desktop.rs),
// none of which touches the credential.

import { invoke } from '@tauri-apps/api/core';
import type { Backend } from './backend';
import type { Desktop } from '../app/desktop';

export const tauriBackend: Backend = {
  call: (cmd, args = {}) => invoke('backend', { cmd, args }),
};

export const tauriDesktop: Desktop = {
  notify: (alert) => invoke('desktop_notify', { alert }),
  setBadge: (count) => invoke('desktop_badge', { count }),
  loginItem: () => invoke('desktop_login_item'),
  setLoginItem: (on) => invoke('desktop_set_login_item', { on }),
  nextEvent: () => invoke('desktop_next_event'),
  updateStatus: () => invoke('desktop_update_status'),
  checkUpdate: () => invoke('desktop_update_check'),
  setAutoUpdate: (on) => invoke('desktop_update_set_auto', { on }),
  setUpdateChannel: (channel) => invoke('desktop_update_set_channel', { channel }),
  dismissUpdate: (version) => invoke('desktop_update_dismiss', { version }),
  restartToUpdate: () => invoke('desktop_update_restart'),
};

/** Tell the shell the window is up. true = this is the packaged-app smoke test: it reports and quits. */
export function mounted(detail: string): Promise<boolean> {
  return invoke<boolean>('mounted', { detail });
}
