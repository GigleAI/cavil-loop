// Small line icons drawn here (GitHub#181): no icon library, nothing loaded from the network.
// 16×16 grid, stroked with the text colour, so they take whatever colour their parent has.
import type { IssueStateReason, ItemKind, ItemState } from '../shared/types';

const PATHS = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>,
  refresh: <><path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" /><path d="M12.5 1.8v2.6H9.9" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  // GitHub#229: a toothed gear (the old dot with eight rays read as a light / dark switch)
  gear: <><path d="M12.82 6.35L14.57 6.67V9.33L12.82 9.65L12.58 10.24L13.58 11.7L11.7 13.58L10.24 12.58L9.65 12.82L9.33 14.57H6.67L6.35 12.82L5.76 12.58L4.3 13.58L2.42 11.7L3.42 10.24L3.18 9.65L1.43 9.33V6.67L3.18 6.35L3.42 5.76L2.42 4.3L4.3 2.42L5.76 3.42L6.35 3.18L6.67 1.43H9.33L9.65 3.18L10.24 3.42L11.7 2.42L13.58 4.3L12.58 5.76Z" strokeLinejoin="round" /><circle cx="8" cy="8" r="2.1" /></>,
  board: <><rect x="2" y="2.5" width="3.2" height="11" rx="1" /><rect x="6.4" y="2.5" width="3.2" height="7.5" rx="1" /><rect x="10.8" y="2.5" width="3.2" height="9" rx="1" /></>,
  table: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 6h12M2 9.5h12M6 6v7.5" /></>,
  sliders: <><path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" /><circle cx="11" cy="4.5" r="1.5" /><circle cx="5" cy="11.5" r="1.5" /></>,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  ext: <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />,
  iteration: <><rect x="2.5" y="3" width="11" height="10.5" rx="1.5" /><path d="M2.5 6.5h11M5.5 1.5v3M10.5 1.5v3" /></>,
  milestone: <><path d="M3 14V2.5" /><path d="M3 3h8l-1.5 2.5L11 8H3" /></>,
  warn: <><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3M8 11.6v.1" /></>,
  repo: <path d="M3.5 13V3.5a1.5 1.5 0 0 1 1.5-1.5h7.5v9H5a1.5 1.5 0 0 0-1.5 1.5zM3.5 13a1.5 1.5 0 0 0 1.5 1.5h7.5v-3" />,
  project: <><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M6 2v12M10 2v8" /></>,
  tag: <><path d="M2.5 2.5h5.2l6 6-5.2 5.2-6-6z" /><circle cx="5.3" cy="5.3" r=".8" fill="currentColor" /></>,
  user: <><circle cx="8" cy="5.5" r="2.8" /><path d="M2.5 14c.6-2.8 2.9-4.3 5.5-4.3s4.9 1.5 5.5 4.3" /></>,
  key: <><circle cx="5" cy="11" r="2.8" /><path d="M7 9l6.5-6.5M11 5l1.8 1.8" /></>,
  bell: <><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1.5H3z" /><path d="M6.5 14.5h3" /></>,
  back: <path d="M10 3L5 8l5 5" />,
  chevron: <path d="M4 6l4 4 4-4" />,
  pencil: <><path d="M10.5 2.5l3 3-8 8H2.5v-3z" /><path d="M9 4l3 3" /></>,
  // item states (same shapes as GitHub's: circle + dot, circle + tick, circle + slash, branch, merge)
  'issue-open': <><circle cx="8" cy="8" r="6.25" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /></>,
  'issue-done': <><circle cx="8" cy="8" r="6.25" /><path d="M5.4 8.2l1.8 1.8 3.4-3.6" /></>,
  'issue-skipped': <><circle cx="8" cy="8" r="6.25" /><path d="M3.6 12.4l8.8-8.8" /></>,
  'pr-open': <><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><path d="M4.5 5.1v5.8" /><circle cx="11.5" cy="12.5" r="1.6" /><path d="M11.5 10.9V6.5a2 2 0 0 0-2-2H7.4" /><path d="M8.9 3l-1.5 1.5L8.9 6" /></>,
  'pr-closed': <><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><path d="M4.5 5.1v5.8" /><circle cx="11.5" cy="12.5" r="1.6" /><path d="M10 3l3 3M13 3l-3 3" /></>,
  'pr-merged': <><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><path d="M4.5 5.1v5.8" /><circle cx="11.5" cy="9" r="1.6" /><path d="M4.5 5.1c0 2.4 2.6 3.9 5.4 3.9" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      data-icon={name}
    >
      {PATHS[name]}
    </svg>
  );
}

/** Which state icon an item gets: the shape follows kind + state; the colour comes from its parent (stateTone). */
export function itemIcon(kind: ItemKind, state: ItemState, reason: IssueStateReason | null | undefined): IconName {
  if (kind === 'pr') return state === 'merged' ? 'pr-merged' : state === 'closed' ? 'pr-closed' : 'pr-open';
  if (state === 'open') return 'issue-open';
  return reason === 'not_planned' || reason === 'duplicate' ? 'issue-skipped' : 'issue-done';
}
