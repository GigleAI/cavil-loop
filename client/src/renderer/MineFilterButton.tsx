// GitHub#689: the view bar's 「只看我的」 — one button; a press opens a small panel with the switch and its two
// boxes (我提出的 / 指派给我). Which items it picks is `mineOnly` (shared/filter.ts), applied by the board to
// every layout and the view-bar numbers; this file only draws the control and sends the change.
//
// The panel closes like the view bar's fold (TallyBar): a press elsewhere, the window losing focus, Esc pressed
// on the button or inside the panel (not a window-wide Esc, which belongs to the search box and the pages).

import { useEffect, useRef, useState } from 'react';
import type { MineFilter } from '../shared/uiPrefs';
import { t } from '../shared/i18n';

/** the hover text of the button: what the switch does now */
export function mineTip(f: MineFilter, viewer: string | null): string {
  if (!viewer) return t('登录后才能只看自己的条目');
  if (!f.on) return t('只看我的：关');
  const parts = [...(f.author ? [t('我提出的')] : []), ...(f.assignee ? [t('指派给我')] : [])];
  return t('只看我的：{parts}（满足任一项就显示）', { parts: parts.join(t('、')) });
}

export function MineFilterButton({ filter, viewer, onChange }: { filter: MineFilter; viewer: string | null; onChange: (patch: Partial<MineFilter>) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const known = !!viewer;
  const lit = filter.on && known;
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
      onKeyDown={(ev) => {
        if (ev.key !== 'Escape' || !open) return;
        ev.preventDefault();
        ev.stopPropagation();
        setOpen(false);
        box.current?.querySelector<HTMLButtonElement>('[data-testid="mine-filter-toggle"]')?.focus();
      }}
    >
      <button
        type="button"
        className={lit ? 'on' : 'ghost'}
        data-testid="mine-filter-toggle"
        data-on={lit ? 'yes' : 'no'}
        aria-expanded={open}
        aria-haspopup="true"
        disabled={!known}
        title={mineTip(filter, viewer)}
        onClick={() => setOpen(!open)}
      >
        {t('只看我的')}
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
