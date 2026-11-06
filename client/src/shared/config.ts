// Built-in defaults. The OAuth app's Client ID is not a secret (it is sent in
// clear to GitHub by every client that uses it); it can be overridden in
// Settings. This one is the maintainer's "Cavil Loop" OAuth app (device flow
// enabled), given on GigleAI/cavil-loop#140.
export const DEFAULT_OAUTH_CLIENT_ID = 'Ov23liTgYsFUdK0wup54';

// Signing in through a GitHub App is the opt-in alternative (GigleAI/cavil-loop#140:
// OAuth app by default, GitHub App when the user chooses it). There is no
// built-in GitHub App yet: until one is published here, choosing it means
// entering the Client ID of a GitHub App the user (or their org) created.
export const DEFAULT_GITHUB_APP_CLIENT_ID = '';

export const SYNC_INTERVAL_MS = 60_000;

/**
 * After a change succeeded, one more sync round this long after the last one
 * (GigleAI/cavil-loop#177): GitHub's own Project automations (closed / merged →
 * Done, auto-add by label, …) run on GitHub's side a little later, so the
 * immediate re-read can be too early for them. It only schedules a round —
 * nothing promises GitHub has finished by then; the 60 s timer still follows.
 */
export const FOLLOW_UP_SYNC_MS = 5_000;
