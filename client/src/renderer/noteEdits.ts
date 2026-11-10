// GitHub#323: a failed change's red bar above the board goes away by itself once the change it is
// about no longer needs anything from anyone — confirmed on GitHub, resent and accepted, or
// abandoned. It is about field changes only (labels, milestone, status, iteration): those are the
// ones kept in the "not saved / not confirmed" list, and that list is what says it is over.
//
// The rule is "seen waiting, then seen gone": the change must first be seen in the list as failed /
// not confirmed, and only then, with its item on the board and the change no longer listed, does it
// count as over. An item missing from the data (its source being re-read, filtered out of the
// read) is "can't tell" and changes nothing; a change never seen waiting is never taken as over.

import type { WriteAction } from '../shared/actions';
import type { Item } from '../shared/types';
import { fieldId, type EditField } from '../data/edits';

/** one change a note is about: the item and the change's id in the item's list of changes */
export interface NoteEdit {
  key: string;
  id: string;
  /** seen in the item's list as failed / not confirmed since the note went up */
  seen: boolean;
}

/** the change a write is kept as in the item's list of changes; null = not a field change */
export function noteEditOf(a: WriteAction): NoteEdit | null {
  let field: EditField;
  switch (a.kind) {
    case 'addLabel':
    case 'removeLabel':
      // the colour is not part of the id
      field = { kind: 'label', label: a.label, color: '' };
      break;
    case 'setMilestone':
      field = { kind: 'milestone' };
      break;
    case 'setStatus':
      field = { kind: 'status', projectKey: a.projectKey };
      break;
    case 'setIteration':
      field = { kind: 'iteration', projectKey: a.projectKey };
      break;
    default:
      return null;
  }
  return { key: a.key, id: fieldId(a.key, field), seen: false };
}

/**
 * One look at the board data. Returns the watched changes as they stand now, and `over` when every
 * one of them was seen waiting and is now gone from its (present) item. An empty list is never over.
 */
export function stepNoteEdits(watch: NoteEdit[], items: Item[]): { watch: NoteEdit[]; over: boolean } {
  if (!watch.length) return { watch, over: false };
  let over = true;
  let changed = false;
  const next = watch.map((w) => {
    const item = items.find((i) => i.key === w.key);
    if (!item) {
      over = false;
      return w;
    }
    const mark = item.edits?.find((m) => m.id === w.id);
    if (mark) {
      over = false;
      if (!w.seen && (mark.status === 'failed' || mark.status === 'unconfirmed')) {
        changed = true;
        return { ...w, seen: true };
      }
      return w;
    }
    if (!w.seen) over = false;
    return w;
  });
  return { watch: changed ? next : watch, over };
}
