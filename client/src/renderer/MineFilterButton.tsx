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
//
// GitHub#746: under each box, the accounts picked as 提出者 / 负责人 (chips, × takes one off) and a search box
// whose list offers everyone who opened / is assigned an item read so far (`mineCandidates`): type to narrow,
// ↑↓ to move, Enter or a click to add / take off, Esc to put the list away (a second Esc closes the panel).
// While a search box has the focus, the mouse leaving does not close the panel (a hand moving off while typing
// is common); a press elsewhere, the window losing focus and Esc still do. With other accounts picked the button
// reads 「只看 N 人」 (`mineLabel`); with none it is 「只看我的」 as before.

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { MINE_PEOPLE_MAX, mineConditions, type MineFilter } from '../shared/uiPrefs';
import { mineCandidates, type MineCandidate } from '../shared/filter';
import { sameLogin } from '../shared/assignees';
import type { Item } from '../shared/types';
import { t } from '../shared/i18n';
import { Icon } from './Icons';
import { Avatar } from './Avatar';
import { Verbatim } from './Verbatim';

/** how long the mouse rests on the button before the panel opens, and how long after it left before it closes */
export const HOVER_OPEN_MS = 150;
export const HOVER_CLOSE_MS = 300;

/**
 * GitHub#746: the button's words — 「只看我的」 while only the two boxes decide (as before), 「只看 N 人」 once other
 * accounts are picked: N = the different accounts in both lists, the signed-in one counted once when a box is ticked.
 */
export function mineLabel(f: MineFilter, viewer: string | null): string {
  if (f.authors.length + f.assignees.length === 0) return t('只看我的');
  const people = new Set([...f.authors, ...f.assignees].map((l) => l.toLowerCase()));
  if ((f.author || f.assignee) && viewer) people.add(viewer.toLowerCase());
  return t('只看 {n} 人', { n: people.size });
}

/** the hover text of the button: what the switch does now */
export function mineTip(f: MineFilter, viewer: string | null): string {
  if (!viewer) return t('登录后才能只看自己的条目');
  const label = mineLabel(f, viewer);
  if (!f.on) return t('{label}：关', { label });
  const parts = [
    ...(f.author ? [t('我提出的')] : []),
    ...f.authors.map((login) => t('{login} 提出的', { login })),
    ...(f.assignee ? [t('指派给我')] : []),
    ...f.assignees.map((login) => t('{login} 负责的', { login })),
  ];
  return t('{label}：{parts}（满足任一项就显示）', { label, parts: parts.join(t('、')) });
}

/** GitHub#746: one list of picked accounts (提出者 or 负责人) — its box, the chips, the search box and its list */
function PeoplePick({
  field,
  box,
  picked,
  candidates,
  disabled,
  lastOne,
  onPick,
}: {
  field: 'author' | 'assignee';
  box: ReactNode;
  picked: string[];
  candidates: MineCandidate[];
  /** the switch is off: everything waits */
  disabled: boolean;
  /** this list's only account is the filter's only condition: it cannot be taken off */
  lastOne: boolean;
  onPick: (next: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const shown = useMemo(() => {
    const f = q.trim().toLowerCase();
    return f ? candidates.filter((c) => c.login.toLowerCase().includes(f)) : candidates;
  }, [candidates, q]);
  const at = Math.min(active, Math.max(0, shown.length - 1));
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector('[data-active="yes"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [at, listOpen]);
  const isPicked = (login: string) => picked.some((p) => sameLogin(p, login));
  const full = picked.length >= MINE_PEOPLE_MAX;
  const drop = (login: string) => onPick(picked.filter((p) => !sameLogin(p, login)));
  const toggle = (c: MineCandidate | undefined) => {
    if (disabled || !c) return;
    if (isPicked(c.login)) {
      if (!lastOne) drop(c.login);
    } else if (!full) {
      onPick([...picked, c.login]);
      // picked: the search starts over, so the next name can be typed at once
      setQ('');
      setActive(0);
    }
  };
  const lastTip = t('至少留一个条件；不想筛就关掉「只看」');
  return (
    <span className="mine-people" data-testid={`mine-people-${field}`}>
      {box}
      {picked.length > 0 && (
        <span className="mine-chips">
          {picked.map((login) => (
            <span key={login} className="mine-chip" data-testid="mine-chip" data-login={login}>
              <Avatar login={login} size={16} />
              <Verbatim from="github">{login}</Verbatim>
              <button
                type="button"
                className="ghost"
                data-testid="mine-chip-remove"
                aria-label={t('去掉「{login}」', { login })}
                title={lastOne ? lastTip : t('去掉「{login}」', { login })}
                disabled={disabled || lastOne}
                onClick={() => drop(login)}
              >
                ×
              </button>
            </span>
          ))}
        </span>
      )}
      {/* the list lies over what follows (never pushes it): a click below must land where it was aimed */}
      <span className="mine-people-search">
        <input
          type="text"
          data-mine-search=""
          data-testid={`mine-${field}-search`}
          value={q}
          placeholder={field === 'author' ? t('搜索提出者…') : t('搜索负责人…')}
          disabled={disabled}
          aria-expanded={listOpen}
          onFocus={() => setListOpen(true)}
          onBlur={() => setListOpen(false)}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setListOpen(true);
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
              ev.preventDefault();
              setListOpen(true);
              setActive(ev.key === 'ArrowDown' ? Math.min(shown.length - 1, at + 1) : Math.max(0, at - 1));
            } else if (ev.key === 'Enter') {
              ev.preventDefault();
              if (listOpen) toggle(shown[at]);
              else setListOpen(true);
            } else if (ev.key === 'Escape' && listOpen) {
              // the first Esc puts the list away; the next one reaches the panel and closes it
              ev.preventDefault();
              ev.stopPropagation();
              setListOpen(false);
            }
          }}
        />
        {listOpen && !disabled && (
          <span className="mine-people-list" data-testid={`mine-${field}-list`}>
            <ul ref={list} role="listbox">
              {shown.map((c, n) => {
                const on = isPicked(c.login);
                const blocked = on ? (lastOne ? lastTip : undefined) : full ? t('每项最多选 {n} 人', { n: MINE_PEOPLE_MAX }) : undefined;
                return (
                  <li
                    key={c.login}
                    role="option"
                    aria-selected={on}
                    data-testid="mine-candidate"
                    data-login={c.login}
                    data-picked={on ? 'yes' : 'no'}
                    data-active={n === at ? 'yes' : 'no'}
                    title={blocked}
                    className={`${n === at ? 'active' : ''}${blocked ? ' disabled' : ''}`}
                    // keep the focus in the search box, or the list would close before the click lands
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(n)}
                    onClick={() => toggle(c)}
                  >
                    <span className="chk">{on ? '✓' : ''}</span>
                    <Avatar login={c.login} size={16} />
                    <Verbatim from="github">{c.login}</Verbatim>
                    <span className="n">{field === 'author' ? t('提出 {n} 条', { n: c.count }) : t('负责 {n} 条', { n: c.count })}</span>
                  </li>
                );
              })}
              {shown.length === 0 && <li className="muted">{t('没有匹配的')}</li>}
            </ul>
            <span className="mine-people-foot">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> {t('选择')}
              </span>
              <span>
                <kbd>↩</kbd> {t('加上 / 去掉')}
              </span>
              <span>
                <kbd>Esc</kbd> {t('收起')}
              </span>
            </span>
          </span>
        )}
      </span>
    </span>
  );
}

export function MineFilterButton({
  filter,
  viewer,
  items = [],
  onChange,
}: {
  filter: MineFilter;
  viewer: string | null;
  /** GitHub#746: the items read so far (every source), whose authors / assignees the searches offer */
  items?: readonly Item[];
  onChange: (patch: Partial<MineFilter>) => void;
}) {
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
    // GitHub#746: typing in a search box — the hand moving off does not close the panel
    const typing = document.activeElement instanceof HTMLElement && document.activeElement.hasAttribute('data-mine-search') && !!box.current?.contains(document.activeElement);
    if (open && typing) stopTimer();
    else if (open) later(HOVER_CLOSE_MS, false);
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
  const conditions = mineConditions(filter);
  const last = (k: 'author' | 'assignee') => filter[k] && conditions === 1;
  const box2 = (k: 'author' | 'assignee', label: string) => (
    <label className="check" title={last(k) ? t('至少留一个条件；不想筛就关掉「只看」') : undefined}>
      <input type="checkbox" data-testid={`mine-${k}`} checked={filter[k]} disabled={!filter.on || last(k)} onChange={(e) => onChange({ [k]: e.target.checked })} />
      {label}
    </label>
  );
  const authors = useMemo(() => (open ? mineCandidates(items, 'author', viewer, filter.authors) : []), [open, items, viewer, filter.authors]);
  const assignees = useMemo(() => (open ? mineCandidates(items, 'assignee', viewer, filter.assignees) : []), [open, items, viewer, filter.assignees]);
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
        {mineLabel(filter, viewer)}
        <Icon name="chevron" size={12} />
      </button>
      {open && known && (
        <span className="mine-filter-pop" data-testid="mine-filter-pop" role="group" aria-label={mineLabel(filter, viewer)}>
          <label className="toggle">
            <input type="checkbox" data-testid="mine-on" checked={filter.on} onChange={(e) => onChange({ on: e.target.checked })} />
            {t('只看')}
          </label>
          <span className="mine-filter-head">{t('提出者')}</span>
          <PeoplePick
            field="author"
            box={box2('author', t('我提出的'))}
            picked={filter.authors}
            candidates={authors}
            disabled={!filter.on}
            lastOne={filter.authors.length === 1 && conditions === 1}
            onPick={(next) => onChange({ authors: next })}
          />
          <span className="mine-filter-head">{t('负责人')}</span>
          <PeoplePick
            field="assignee"
            box={box2('assignee', t('指派给我（assignee 里有我）'))}
            picked={filter.assignees}
            candidates={assignees}
            disabled={!filter.on}
            lastOne={filter.assignees.length === 1 && conditions === 1}
            onPick={(next) => onChange({ assignees: next })}
          />
          <span className="mine-filter-hint">{t('勾的和选的人满足任一项就显示。看板、表格、依赖图和顶栏的数都按它，只记一份。')}</span>
        </span>
      )}
    </span>
  );
}
