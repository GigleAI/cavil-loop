// "Does this late answer still belong to what is on screen?" — the one rule
// every asynchronous call of the detail panel goes through (reading the
// detail, reading the repository's labels / milestones, the reply preview,
// a change sent to GitHub).
//
// An *opening* is one visit of the panel to one item: opening #138, going to
// #137 and back to #138 are three openings, so an answer started in the first
// one never counts as the third one's. Within an opening, a newer call of the
// same kind supersedes an older one (a second "refresh", typing after asking
// for a preview).
//
// Pure (no React): the panel creates one per opening; tests drive it directly.

export type CallKind = 'detail' | 'options' | 'preview' | 'write';

export interface OpenSession {
  /** this opening is still the one on screen */
  current(): boolean;
  /**
   * A call of `kind` starts now. The returned check is true while this opening
   * is current and no newer call of the same kind started since.
   */
  begin(kind: CallKind): () => boolean;
  /** a newer call of `kind` is about to replace whatever is in flight (e.g. the text being previewed changed) */
  supersede(kind: CallKind): void;
  /** the opening is over (the panel closed or moved to another opening) */
  end(): void;
}

export function createOpenSession(): OpenSession {
  let open = true;
  const seq: Record<CallKind, number> = { detail: 0, options: 0, preview: 0, write: 0 };
  return {
    current: () => open,
    begin(kind) {
      const mine = ++seq[kind];
      return () => open && seq[kind] === mine;
    },
    supersede(kind) {
      seq[kind]++;
    },
    end() {
      open = false;
    },
  };
}
