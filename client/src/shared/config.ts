// Built-in defaults. The OAuth app's Client ID is not a secret (it is sent in
// clear to GitHub by every client that uses it); it can be overridden in
// Settings. This one is the maintainer's "Cavil Loop" OAuth app (device flow
// enabled), given on GigleAI/cavil-loop#140.
export const DEFAULT_OAUTH_CLIENT_ID = 'Ov23liTgYsFUdK0wup54';

export const SYNC_INTERVAL_MS = 60_000;
