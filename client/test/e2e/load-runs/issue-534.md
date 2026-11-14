# Client e2e under load — GitHub#534 (follow-up of GitHub#523 / PR #531)

Commit under test: `eee384c3` (tip of `main` on 2026-11-14). Machine: 28 cores.
No code was changed; this file only records the runs.

Command, run from `client/` in a clean environment:

```bash
env -i HOME=$HOME PATH=$PATH LANG=C.UTF-8 TERM=dumb CAVIL_E2E_ENGINE=chromium npm run test:e2e
env -i HOME=$HOME PATH=$PATH LANG=C.UTF-8 TERM=dumb CAVIL_E2E_ENGINE=chromium npm run test:e2e -- blocked.spec.ts
```

Playwright config: `workers: 1`, no retries, test timeout 90 s.

Load: busy loops `( while :; do :; done ) &` were added and removed by PID by a small
controller that read the 1-minute load average once a minute (target band 26–31; 13–26
loops depending on what else was running). `uptime` was logged every minute; the figures
below are those 1-minute averages, taken over the samples inside each run's time window.
All loops were stopped by PID afterwards and checked gone with `ps -p`.

| Run | Time (UTC+8) | Load min / median / max | Samples outside 22–37 | Result |
|---|---|---|---|---|
| Full, pass 1 | 21:35–22:02 | 19.0 / 30.3 / 38.0 | 4 of 27 | 221 passed, 0 failed, 2 skipped (26.2 min) |
| Full, pass 2 | 22:02–22:27 | 21.5 / 26.8 / 42.0 | 4 of 25 | 221 passed, 0 failed, 2 skipped (25.5 min) |
| Full, pass 3 | 22:27–22:54 | 20.9 / 27.6 / 39.6 | 5 of 26 | 221 passed, 0 failed, 2 skipped (26.1 min) |
| `blocked.spec.ts` alone | 22:54–22:55 | 22.5 (one sample) | 0 of 1 | 14 passed, 0 failed (47.4 s) |

Not flaky either: with no retries configured, every test ran exactly once.

The two tests fixed in 2b4b4853 (PR #531, never through a full run before):
`app.spec.ts` "leave an item and come back" and `app.spec.ts` "GitHub#413 / #433 …
Ctrl+Shift+X …" passed in all three passes.

The ~90 s "app root" start-up timeout seen in PR #531 review round 2 did not occur: no
timeout in any of the four runs; the slowest `blocked.spec.ts` test took 5.0 s, and the
slowest test in the full passes took 52–57 s.

Also on `eee384c3`, without added load: `npm run typecheck` passed; `npm test` passed
(106 files, 2246 tests; negative controls skipped by default).
