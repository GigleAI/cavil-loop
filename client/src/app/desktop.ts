// Notifications, the Dock badge, launch at login and the sync beat, as the app
// logic sees them (GitHub#139 / #169). The shell implements them per OS
// (src-tauri/src/desktop.rs); the controller only decides *what* to show.
// None of this touches the GitHub credential.

import type { UpdateStatus } from '../shared/types';

export type { UpdateStatus };

/**
 * What a notification is about; a click on an item notification opens that item. The app sends
 * only `item` since GitHub#251 (no start-up summary); `summary` stays for the packaging check's
 * test notification (`--notify-check`, src-tauri/src/main.rs).
 */
export type Alert =
  | { kind: 'item'; key: string; url: string; title: string; body: string }
  | { kind: 'summary'; title: string; body: string };

/** What the system did with one notification. */
export type Delivery = { ok: true } | { ok: false; error: string };

/** Something the shell tells the window: time for a sync round, a notification was clicked, or the updater changed. */
export type DesktopEvent =
  /** `everyMs` (GitHub#324): the beat's own interval, when its keeper says it — timed rounds keep that gap */
  | { kind: 'tick'; everyMs?: number }
  | { kind: 'open'; key: string; url: string }
  | { kind: 'update'; status: UpdateStatus }
  /** the window came to the front / left it (GitHub#185: switching to the app reads the unread items) */
  | { kind: 'active' }
  | { kind: 'inactive' };

export interface Desktop {
  /** resolves with what the system did (macOS may refuse: not allowed in System Settings) */
  notify(a: Alert): Promise<Delivery>;
  /** 0 clears the badge */
  setBadge(count: number): Promise<void>;
  /** take back this app's notifications still in Notification Center (GitHub#185) */
  clearNotifications(): Promise<void>;
  /** launch at login: on / off; null = this platform cannot */
  loginItem(): Promise<boolean | null>;
  setLoginItem(on: boolean): Promise<void>;
  /** the next event from the shell (waits until there is one; never rejects for "nothing yet") */
  nextEvent(): Promise<DesktopEvent>;
  /** the updater now; null = this build does not update itself */
  updateStatus(): Promise<UpdateStatus | null>;
  /** start a round now (returns at once; progress comes as `update` events) */
  checkUpdate(): Promise<void>;
  setAutoUpdate(on: boolean): Promise<void>;
  /** choose the update channel (kept); a check on it starts at once */
  setUpdateChannel(channel: 'stable' | 'dev'): Promise<void>;
  /** close the "ready" banner for `version` (kept) */
  dismissUpdate(version: string): Promise<void>;
  /** the "updated to `version`" notice was closed (kept) */
  dismissInstalledUpdate(version: string): Promise<void>;
  /** quit and start the new version (only once it is in place) */
  restartToUpdate(): Promise<void>;
}
