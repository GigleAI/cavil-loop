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
 * GitHub#733: the window's own watch over syncing. It wakes this often; a round with no progress
 * (no answer from the back end) for WATCH_QUIET_TICKS wakes in a row has stopped moving. Two wakes
 * further apart than WATCH_GAP_MS mean the timer did not run in between (the machine slept): the
 * count starts again. With no timed round asked for WATCH_FALLBACK_MS (the shell's beat did not
 * come), the watch asks for one itself.
 */
export const WATCH_EVERY_MS = 15_000;
export const WATCH_QUIET_TICKS = 12;
export const WATCH_GAP_MS = 45_000;
export const WATCH_FALLBACK_MS = 90_000;

/**
 * GitHub#755: a refresh by hand reads GitHub for at most this long — counted only while that round
 * reads (its sources, then the notifications), never while it renews the sign-in or saves what it read
 * (those are never cut). What is not read by then fails this time; timed rounds have no such limit.
 */
export const REREAD_READ_LIMIT_MS = 120_000;

/**
 * After a change succeeded, one more sync round this long after the last one
 * (GigleAI/cavil-loop#177): GitHub's own Project automations (closed / merged →
 * Done, auto-add by label, …) run on GitHub's side a little later, so the
 * immediate re-read can be too early for them. It only schedules a round —
 * nothing promises GitHub has finished by then; the 60 s timer still follows.
 */
export const FOLLOW_UP_SYNC_MS = 5_000;
