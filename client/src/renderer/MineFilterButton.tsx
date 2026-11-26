// GitHub#689: the view bar's 「只看我的」 — one button; a press opens a small panel with the switch and its two
// boxes (我提出的 / 指派给我). GitHub#721: it is an ordinary bordered button with a down arrow even while off, so it
// reads as a control that opens something, not as the label of the "显示已关闭" switch next to it. Which items it picks is `mineOnly` (shared/filter.ts), applied by the board to
// every layout and the view-bar numbers; this file only draws the control and sends the change.
//
// The panel closes like the view bar's fold (TallyBar): a press elsewhere, the window losing focus, Esc pressed
// on the button or inside the panel (not a window-wide Esc, which belongs to the search box and the pages).
//
// GitHub#728: with a mouse it also opens on its own — the pointer resting on the button (HOVER_OPEN_MS) opens the
// panel, the pointer leaving the button and the panel (HOVER_CLOSE_MS, so crossing the gap between them or coming
// back in time does not close it) closes it. There is one rule for the mouse, whatever was clicked: a mouse click on
// an open panel leaves it open, on a closed one opens it, and leaving closes it either way. Touch and the keyboard
// do not hover: a tap or Enter / Space still opens and closes it as before. Every way of closing (press elsewhere,
// Esc, blur, unmount) also drops a pending hover timer, so a panel just closed is not reopened by one.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { MineFilter } from '../shared/uiPrefs';
import { t } from '../shared/i18n';
import { Icon } from './Icons';

/** how long the mouse rests on the button before the panel opens, and how long after it left before it closes */
export const HOVER_OPEN_MS = 150;
export const HOVER_CLOSE_MS = 300;

/** the hover text of the button: what the switch does now */
export function mineTip(f: MineFilter, viewer: string | null): string {
  if (!viewer) return t('登录后才能只看自己的条目');
  if (!f.on) return t('只看我的：关');
  const parts = [...(f.author ? [t('我提出的')] : []), ...(f.assignee ? [t('指派给我')] : [])];
  return t('只看我的：{parts}（满足任一项就显示）', { parts: parts.join(t('、')) });
}

export function MineFilterButton({ filter, viewer, onChange }: { filter: MineFilter; viewer: string | null; onChange: (patch: Partial<MineFilter>) => void }) {
  const [open, setOpenState] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** the kind of pointer that pressed the button last ('' = none: the click came from the keyboard) */
  const pressedBy = useRef('');
  const known = !!viewer;
  const lit = filter.on && known;
  const stopTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const later = (ms: number, next: boolean) => {
    stopTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpenState(next);
    }, ms);
  };
  /** open or close now, dropping any hover timer still waiting */
  const setOpen = (next: boolean) => {
    stopTimer();
    setOpenState(next);
  };
  useEffect(() => {
    // leaving the window drops a hover timer still waiting, open or not (the listener below only runs while open)
    window.addEventListener('blur', stopTimer);
    return () => {
      window.removeEventListener('blur', stopTimer);
      stopTimer();
    };
  }, []);
  const enter = (ev: ReactPointerEvent) => {
    if (ev.pointerType !== 'mouse' || !known) return;
    if (open) stopTimer();
    else later(HOVER_OPEN_MS, true);
  };
  const leave = (ev: ReactPointerEvent) => {
    if (ev.pointerType !== 'mouse') return;
    if (open) later(HOVER_CLOSE_MS, false);
    else stopTimer();
  };
  useEffect(() => {
    if (!open) return;
    const away = (ev: Event) => {
      if (ev.target instanceof Node && box.current?.contains(ev.target)) return;
      setOpen(false);
    };
    const gone = () => setOpen(false);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', gone);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', gone);
    };
  }, [open]);
  const last = (k: 'author' | 'assignee') => filter[k] && !filter[k === 'author' ? 'assignee' : 'author'];
  const box2 = (k: 'author' | 'assignee', label: string) => (
    <label className="check" title={last(k) ? t('至少留一项；不想筛就关掉「只看我的」') : undefined}>
      <input type="checkbox" data-testid={`mine-${k}`} checked={filter[k]} disabled={!filter.on || last(k)} onChange={(e) => onChange({ [k]: e.target.checked })} />
      {label}
    </label>
  );
  return (
    <span
      className="mine-filter"
      ref={box}
      data-testid="mine-filter"
      onPointerEnter={enter}
      onPointerLeave={leave}
      onKeyDown={(ev) => {
        if (ev.key !== 'Escape') return;
        if (!open) return stopTimer(); // Esc while the hover wait runs: it does not open
        ev.preventDefault();
        ev.stopPropagation();
        setOpen(false);
        box.current?.querySelector<HTMLButtonElement>('[data-testid="mine-filter-toggle"]')?.focus();
      }}
    >
      <button
        type="button"
        className={lit ? 'on' : undefined}
        data-testid="mine-filter-toggle"
        data-on={lit ? 'yes' : 'no'}
        aria-expanded={open}
        aria-haspopup="true"
        disabled={!known}
        title={open ? undefined : mineTip(filter, viewer)}
        onPointerDown={(ev) => {
          pressedBy.current = ev.pointerType;
        }}
        onClick={() => {
          const mouse = pressedBy.current === 'mouse';
          pressedBy.current = '';
          // the mouse opens it by resting on it and closes it by leaving: a click never closes it under the pointer
          setOpen(mouse ? true : !open);
        }}
      >
        {t('只看我的')}
        <Icon name="chevron" size={12} />
      </button>
      {open && known && (
        <span className="mine-filter-pop" data-testid="mine-filter-pop" role="group" aria-label={t('只看我的')}>
          <label className="toggle">
            <input type="checkbox" data-testid="mine-on" checked={filter.on} onChange={(e) => onChange({ on: e.target.checked })} />
            {t('只看我的')}
          </label>
          <span className="mine-filter-boxes">
            {box2('author', t('我提出的'))}
            {box2('assignee', t('指派给我（assignee 里有我）'))}
          </span>
          <span className="mine-filter-hint">{t('两项都勾：满足任一项就显示。看板、表格、依赖图和顶栏的数都按它，只记一份。')}</span>
        </span>
      )}
    </span>
  );
}
