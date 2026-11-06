// When has the app's first complete sync round of this start been taken (GitHub#186)?
//
// The background tests (test/tauri/background.spec.ts) put a label
// on GitHub and require that item's own notification and the badge +1. That only holds for a
// label put on *after* the first complete read of the source: what that read already finds is
// the baseline (GitHub#139) and goes into one summary notification, never one per item. A badge
// record is no proof of that read — the app clears the badge to 0 when it starts, before any
// sync (arm64 CI lost that race on every run: the label went into the summary, the test timed
// out). So the tests put one item on the label before starting the app, and wait for what only
// the first complete round produces: the summary notification, and the badge set after it (the
// shell records the notification before it answers; the badge is the next call, so for a moment
// the summary is there and the badge is not).
//
// `records` = the shell's test record (one parsed JSON line each); `from` = the first record of
// this start (an earlier start's summary does not count). Returns the badge set after this start's
// first summary, or null while the round is not complete.
export function firstRoundBadge(records: any[], from = 0): number | null {
  let summary = -1;
  for (let i = from; i < records.length; i++) {
    const r = records[i];
    if (r?.op === 'notify' && r.alert?.kind === 'summary') {
      summary = i;
      break;
    }
  }
  if (summary < 0) return null;
  for (let i = summary + 1; i < records.length; i++) {
    const r = records[i];
    if (r?.op === 'badge' && typeof r.count === 'number') return r.count;
  }
  return null;
}

// Since GitHub#185 the badge is the unread count: an item that becomes pending while the window is
// in front is read at once. So the base the first round leaves depends on whether the window was in
// front when it came in — the shell records `active` / `inactive` as the window gains and loses the
// front. Returns whether it was in front at this start's first summary (null while there is none):
// the last of those records before the summary, within this start; none at all = not in front.
export function inFrontAtFirstRound(records: any[], from = 0): boolean | null {
  let front = false;
  for (let i = from; i < records.length; i++) {
    const r = records[i];
    if (r?.op === 'active') front = true;
    else if (r?.op === 'inactive') front = false;
    else if (r?.op === 'notify' && r.alert?.kind === 'summary') return front;
  }
  return null;
}
