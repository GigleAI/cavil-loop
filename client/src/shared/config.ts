// Built-in defaults. The OAuth app's Client ID is not a secret (it is sent in
// clear to GitHub by every client that uses it); it can be overridden in
// Settings. Empty until the maintainer registers the OAuth app — the login
// page then asks for one (see client/README.md).
export const DEFAULT_OAUTH_CLIENT_ID = '';

export const SYNC_INTERVAL_MS = 60_000;
