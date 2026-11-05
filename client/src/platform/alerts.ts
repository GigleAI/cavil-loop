// Notifications, the Dock badge and launch at login, as the app logic sees
// them. The platform layer (index.ts) implements them per OS; the controller
// only decides *what* to show.

/** What a notification is about; the platform layer decides what a click does with it. */
export type Alert =
  | { kind: 'item'; key: string; url: string; title: string; body: string }
  | { kind: 'summary'; title: string; body: string };

/** What the system did with one notification. */
export type Delivery = { ok: true } | { ok: false; error: string };

export interface Alerts {
  /** `done` is told whether the system put it on screen (macOS may refuse: not allowed in System Settings) */
  notify(a: Alert, done?: (d: Delivery) => void): void;
  /** 0 clears the badge */
  setBadge(count: number): void;
}

export interface LoginItem {
  get(): boolean;
  set(on: boolean): void;
}
