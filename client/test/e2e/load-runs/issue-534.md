# Client e2e under load — GitHub#534 (follow-up of GitHub#523 / PR #531)

Machine: 28 cores. No code was changed; this file only records the runs.
Acceptance (issue #534): three consecutive full runs with 0 failures, the 1-minute load
average between 22 and 37 at every once-a-minute `uptime` sample.

Command, run from `client/` in a clean environment:

```bash
env -i HOME=$HOME PATH=$PATH LANG=C.UTF-8 TERM=dumb CAVIL_E2E_ENGINE=chromium npm run test:e2e
env -i HOME=$HOME PATH=$PATH LANG=C.UTF-8 TERM=dumb CAVIL_E2E_ENGINE=chromium npm run test:e2e -- blocked.spec.ts
```

Playwright config: `workers: 1`, no retries, test timeout 90 s — every test runs exactly once.
Load figures are the 1-minute averages from the `uptime` samples taken inside each run's
time window. Busy loops `( while :; do :; done ) &` were started and stopped by PID only;
after each round the controller and every loop were checked gone with `ps -p`.

## Round 2 — counts for acceptance

Commit `b4132cb0`: this branch with `main` at `6a646d27` (PR #521) merged in, 2026-11-14/15
(UTC+8). Load controller: every 2 s it read the number of running processes from
`/proc/stat` and started / stopped loops so that the running total stayed at 27, which
cancels the test run's own bursts instead of reacting to the lagging load average.

| Run | Time (UTC+8) | Load min / median / max | Samples outside 22–37 | Result |
|---|---|---|---|---|
| Full, pass 1 | 23:05–23:31 | 23.7 / 25.8 / 27.6 | 0 of 25 | 229 passed, 0 failed, 2 skipped (25.8 min) |
| Full, pass 2 | 23:31–23:56 | 23.8 / 26.6 / 28.6 | 0 of 26 | 229 passed, 0 failed, 2 skipped (25.8 min) |
| Full, pass 3 | 23:56–00:22 | 26.3 / 27.5 / 30.3 | 0 of 26 | 229 passed, 0 failed, 2 skipped (25.7 min) |
| `blocked.spec.ts` alone | 00:22–00:23 | 26.5 (one sample, 00:23:22) | 0 of 1 | 14 passed, 0 failed (57.1 s) |

- The two tests fixed in 2b4b4853 (PR #531) — `app.spec.ts` "leave an item and come back"
  and "GitHub#413 / #433 … Ctrl+Shift+X …" — passed in all three passes.
- The ~90 s "app root" start-up timeout from PR #531 review round 2 did not occur: no
  timeout in any run; the slowest `blocked.spec.ts` test took 5.5 s, the slowest test in
  the full passes 53–54 s.
- Without added load, on `b4132cb0`: `npm run typecheck` passed; `npm test` passed
  (109 files, 2262 tests; negative controls skipped by default).

## Round 1 — does not count (load left the band)

Commit `eee384c3`, 2026-11-14. Load controller: once a minute, read the 1-minute load
average and add / remove loops. It reacted too late to the test run's own bursts, so
every pass had samples outside 22–37 (review round 1 of PR #538 rejected it).

| Run | Time (UTC+8) | Load min / median / max | Samples outside 22–37 | Result |
|---|---|---|---|---|
| Full, pass 1 | 21:35–22:02 | 19.0 / 30.3 / 38.0 | 4 of 27 | 221 passed, 0 failed, 2 skipped |
| Full, pass 2 | 22:02–22:27 | 21.5 / 26.8 / 42.0 | 4 of 25 | 221 passed, 0 failed, 2 skipped |
| Full, pass 3 | 22:27–22:54 | 20.9 / 27.6 / 39.6 | 5 of 26 | 221 passed, 0 failed, 2 skipped |
| `blocked.spec.ts` alone | 22:54–22:55 | 22.5 (one sample) | 0 of 1 | 14 passed, 0 failed |
