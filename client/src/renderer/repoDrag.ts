// Dragging a repository to another place in the list (GitHub#304), shared by the table's repository
// slices and the board's swimlane heads. Its own drag: a card or a row dropped on a repository does
// nothing (the targets only take a drag started here), and a repository dropped on a column or a
// group changes nothing there (those take only their own drags).

import { useRef, useState } from 'react';
import type React from 'react';
import { moveRepo } from '../shared/repoOrder';
import { api } from './api';

/** where a dragged repository would land: before or after `repo` */
export interface RepoDropAt {
  repo: string;
  after: boolean;
}

/**
 * `shown` = the repositories on screen, in their order. `onStart` runs when a repository drag starts
 * (the board forgets a card drag that never landed, so a later drop on a column cannot pick it up).
 */
export function useRepoDrag(shown: string[], onStart?: () => void) {
  const drag = useRef<{ repo: string; shown: string[] } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [at, setAt] = useState<RepoDropAt | null>(null);
  const end = () => {
    drag.current = null;
    setDragging(null);
    setAt(null);
  };
  const over = (repo: string) => (e: React.DragEvent) => {
    if (!drag.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    setAt((a) => (a && a.repo === repo && a.after === after ? a : { repo, after }));
  };
  const props = (repo: string) => ({
    draggable: true,
    'data-repo-drag': dragging === repo ? 'yes' : undefined,
    'data-drop-at': at && at.repo === repo ? (at.after ? 'after' : 'before') : undefined,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.setData('text/plain', repo);
      e.dataTransfer.effectAllowed = 'move';
      onStart?.();
      drag.current = { repo, shown: [...shown] };
      setDragging(repo);
    },
    // entering and moving over both mark the place (and accept the drop): only a drag started here
    onDragEnter: over(repo),
    onDragOver: over(repo),
    onDragLeave: (e: React.DragEvent) => {
      const to = e.relatedTarget as Node | null;
      if (!to || !(e.currentTarget as Node).contains(to)) setAt((a) => (a && a.repo === repo ? null : a));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const d = drag.current;
      const r = (e.currentTarget as Element).getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      end();
      if (!d) return;
      const next = moveRepo(d.shown, d.repo, repo, after);
      if (next) void Promise.resolve(api().reorderRepos(d.shown, next)).catch(() => undefined);
    },
    onDragEnd: end,
  });
  return { props };
}
