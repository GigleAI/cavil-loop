// Task-list boxes ("- [ ] A. …") in an issue / PR body or a comment, the way
// GitHub reads them (GitHub#193): which boxes the markdown source holds, where
// each one's [ ] / [x] sits, and whether that agrees box for box with what
// GitHub rendered. Ticking one box changes exactly one character of the source.
//
// One implementation, used by every caller: the detail read decides here
// whether an entry's boxes may be clicked, the window marks the boxes in
// GitHub's HTML with `annotateTaskBoxes`, and the write re-checks the fresh
// source and flips the character with `flipTask`.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';

export interface TaskBox {
  /** offset of the character between the brackets (' ', 'x' or 'X') in the source */
  at: number;
  checked: boolean;
}

/** a list item's own marker, its spacing, then the box: `- [ ]`, `1. [x]`, `* [X]` */
const MARKER = /^(?:[*+-]|\d{1,9}[.)])[ \t]+\[([ xX])\]/;

interface Node {
  type: string;
  checked?: boolean | null;
  position?: { start: { offset?: number } };
  children?: Node[];
}

/**
 * Every task-list box of `source`, in document order, as GitHub's markdown
 * (CommonMark + GFM task list items) reads them: a `- [ ]` inside a code block,
 * an HTML comment or a table cell is not a box. Null when a box the parser
 * found cannot be located in the source (then nothing may be written).
 */
export function findTaskBoxes(source: string): TaskBox[] | null {
  const tree = fromMarkdown(source, { extensions: [gfmTaskListItem()], mdastExtensions: [gfmTaskListItemFromMarkdown()] }) as Node;
  const out: TaskBox[] = [];
  let lost = false;
  const walk = (n: Node) => {
    if (n.type === 'listItem' && typeof n.checked === 'boolean') {
      const start = n.position?.start.offset;
      const m = start === undefined ? null : MARKER.exec(source.slice(start, start + 64));
      if (!m || start === undefined) lost = true;
      else {
        const at = start + m[0].length - 2;
        const checked = m[1] !== ' ';
        if (checked !== n.checked) lost = true;
        out.push({ at, checked });
      }
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return lost ? null : out;
}

/** GitHub's rendered task-list checkbox: `<input type="checkbox" … class="task-list-item-checkbox" …>` */
const HTML_BOX = /<input\b[^>]*\bclass="task-list-item-checkbox"[^>]*>/g;

/** The boxes GitHub rendered, in document order: checked or not. */
export function renderedTaskBoxes(html: string): boolean[] {
  return [...html.matchAll(HTML_BOX)].map((m) => /\schecked(?:=|\s|>|$)/.test(m[0]));
}

/** A click on its way to GitHub (GitHub#358): box `index` of one entry, and what the user asked for. */
export interface PendingTick {
  index: number;
  checked: boolean;
}

/**
 * GitHub's HTML with each rendered box numbered (`data-task="i"`, the same
 * order `renderedTaskBoxes` counts) and, when `clickable`, its `disabled`
 * dropped. The frame's script reports the number it finds on the clicked box.
 *
 * `pending` (GitHub#358): that box is drawn the way the user asked for it —
 * ticked or not — and marked `data-pending` (grey: GitHub has not confirmed
 * it yet). Every other box keeps what GitHub rendered.
 */
export function annotateTaskBoxes(html: string, clickable: boolean, pending: PendingTick | null = null): string {
  let i = 0;
  return html.replace(HTML_BOX, (tag) => {
    const n = i++;
    let t = tag.replace(/^<input\b/, `<input data-task="${n}"`);
    if (clickable) t = t.replace(/\sdisabled(?:="[^"]*")?/, '');
    if (pending && pending.index === n) {
      t = t.replace(/\schecked(?:="[^"]*")?(?=\s|\/?>)/, '');
      t = t.replace(/^<input\b/, `<input data-pending=""${pending.checked ? ' checked=""' : ''}`);
    }
    return t;
  });
}

export type TaskPlan = { ok: true; boxes: TaskBox[] } | { ok: false; why: string };

/** Can this entry's boxes be clicked? Only when the source and GitHub's rendering agree box for box. */
export function planTasks(source: string, html: string): TaskPlan {
  const rendered = renderedTaskBoxes(html);
  if (!rendered.length) return { ok: false, why: '没有勾选框' };
  const boxes = findTaskBoxes(source);
  if (!boxes || boxes.length !== rendered.length || boxes.some((b, i) => b.checked !== rendered[i]))
    return { ok: false, why: '这条评论的勾选框客户端对不上，请在网页上勾' };
  return { ok: true, boxes };
}

/**
 * `source` with box `index` set to `checked`: exactly one character changes.
 * Null when there is no such box, or it is not in the opposite state now
 * (somebody else changed it: nothing is written on a guess).
 */
export function flipTask(source: string, index: number, checked: boolean): string | null {
  const boxes = findTaskBoxes(source);
  const b = boxes?.[index];
  if (!b || b.checked === checked || !Number.isInteger(index)) return null;
  return source.slice(0, b.at) + (checked ? 'x' : ' ') + source.slice(b.at + 1);
}
