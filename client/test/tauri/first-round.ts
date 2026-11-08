// When may the background tests put a label on GitHub (GitHub#186, reworked in #251)?
//
// The background tests (test/tauri/background.spec.ts) put a label on GitHub and require that
// item's own notification and the badge +1. That only holds for a label put on *after* the first
// complete read of the source this start: what that read already finds is the reminders'
// baseline — history, never notified, never unread (GitHub#251).
//
// Until #251 the first round ended in a start-up summary notification, and the tests waited for
// it. That summary is gone, and the shell records nothing else that only the first round
// produces (the badge is cleared to 0 when the app starts, before any sync — arm64 CI once lost
// that race). So the proof is read where the data comes from: the fake GitHub's request log. A
// repository source reads two lists at once (every open item; everything updated in the last 14
// days). Once both have been answered after this start, the first complete read has its data —
// frozen at that moment, without a label put on later — so a label put on from then on is new to
// the baseline, whenever the app gets round to processing that read.
//
// `log` = the fake GitHub's request log; `from` = its length when this start began (an earlier
// start's reads do not count); `repo` = `owner/name` as the app requests it.
export interface LoggedRead {
  method: string;
  path: string;
  status: number;
}

export function firstReadDone(log: LoggedRead[], from: number, repo: string): boolean {
  const base = `/api/repos/${repo}/issues?`;
  let open = false;
  let recent = false;
  for (let i = from; i < log.length; i++) {
    const r = log[i];
    if (r.method !== 'GET' || r.status !== 200 || !r.path.toLowerCase().startsWith(base.toLowerCase())) continue;
    const q = new URLSearchParams(r.path.slice(r.path.indexOf('?') + 1));
    if (q.get('page') && q.get('page') !== '1') continue;
    if (q.get('state') === 'open') open = true;
    else if (q.get('state') === 'all' && q.get('since')) recent = true;
  }
  return open && recent;
}
