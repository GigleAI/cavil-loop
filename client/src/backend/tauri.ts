// The app's transport to the back end: Tauri's IPC, one command (`backend`,
// src-tauri/src/main.rs). Only loaded inside the Tauri window.

import { invoke } from '@tauri-apps/api/core';
import type { Backend } from './backend';

export const tauriBackend: Backend = {
  call: (cmd, args = {}) => invoke('backend', { cmd, args }),
};

/** Tell the shell the window is up. true = this is the packaged-app smoke test: it reports and quits. */
export function mounted(detail: string): Promise<boolean> {
  return invoke<boolean>('mounted', { detail });
}
