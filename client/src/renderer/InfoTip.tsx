// GitHub#591: a setting's explanation behind an ⓘ next to its name, instead of a line under it.
//
// One implementation for the settings page and the project settings dialog. The words are the
// same words that used to sit under the setting (passed in as they are); the tip shows them
// while the pointer is over the ⓘ, while the ⓘ has keyboard focus, or after a click (a second
// click, Esc or a click elsewhere hides it). Esc while a tip is showing only hides the tip: it is
// taken before the window's own Esc (leaving settings, closing the dialog) sees it.
//
// The tip is drawn by the window (not the system's `title` tooltip, which waits a second and is
// out of reach of the keyboard and screen readers) in a fixed layer at the end of the page (a
// portal), so a dialog's scrolling box does not clip it and the heading or label it sits next to
// keeps only its own words; it opens below the ⓘ and moves above / to the left when there is no room.

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icons';
import { t } from '../shared/i18n';

/** where the tip goes for an ⓘ at `at`, a tip of `size`, in a window of `view` (pure: unit-tested) */
export function tipPlace(
  at: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
  gap = 6,
  margin = 8,
): { left: number; top: number; above: boolean } {
  const below = at.bottom + gap;
  const above = below + size.height > view.height - margin && at.top - gap - size.height >= margin;
  const top = above ? at.top - gap - size.height : below;
  let left = at.left - 10;
  if (left + size.width > view.width - margin) left = view.width - margin - size.width;
  if (left < margin) left = margin;
  return { left, top, above };
}

/**
 * `testid` names the ⓘ (`<testid>-button`) and its text (`<testid>-text`); `textTestid` gives the text the handle the
 * line had before it moved behind the ⓘ, so what it says is still found by that name.
 */
export function InfoTip({ children, testid, textTestid, label }: { children: ReactNode; testid?: string; textTestid?: string; label?: string }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  /**
   * An explicit close (the second click, Esc) wins over the pointer still resting on the ⓘ and over its focus: it holds
   * until the pointer leaves and focus moves away, so the next hover, Tab or click opens it again (PR #596 review round 1).
   */
  const [closed, setClosed] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const id = useId();
  const open = !closed && (hover || focus || pinned);
  const hide = () => {
    setPinned(false);
    setClosed(true);
  };

  useLayoutEffect(() => {
    if (!open || !btn.current || !tip.current) return setPlace(null);
    const r = btn.current.getBoundingClientRect();
    const s = tip.current.getBoundingClientRect();
    setPlace(tipPlace(r, { width: s.width, height: s.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Esc hides the tip first; a click outside unpins it; scrolling moves the ⓘ away, so the tip goes
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      hide();
    };
    const down = (e: MouseEvent) => {
      if (btn.current && !btn.current.contains(e.target as Node)) setPinned(false);
    };
    const scroll = () => hide();
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', down, true);
    window.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);

  return (
    <span className="info-tip-wrap" data-testid={testid ?? 'info-tip'} data-open={String(open)}>
      <button
        type="button"
        ref={btn}
        className={`info-tip${open ? ' on' : ''}`}
        aria-label={label ?? t('说明')}
        aria-describedby={id}
        aria-expanded={open}
        data-testid={`${testid ?? 'info-tip'}-button`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => {
          setHover(false);
          setClosed(false);
        }}
        // keyboard focus opens it; the focus a mouse click leaves behind does not (that one is the click's to decide)
        onFocus={(e) => setFocus(e.currentTarget.matches(':focus-visible'))}
        onBlur={() => {
          setFocus(false);
          setClosed(false);
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // the first click keeps it open after the pointer leaves; a click on an open, kept tip closes it at once
          if (pinned && open) hide();
          else {
            setPinned(true);
            setClosed(false);
          }
        }}
      >
        <Icon name="info" size={14} />
      </button>
      {/* always in the page (the button's description for screen readers); shown only while open */}
      {createPortal(
      <span
        ref={tip}
        id={id}
        role="tooltip"
        className={`info-tip-text${open ? ' on' : ''}${place?.above ? ' above' : ''}`}
        data-testid={textTestid ?? `${testid ?? 'info-tip'}-text`}
        style={open && place ? { left: place.left, top: place.top } : undefined}
      >
        {children}
      </span>,
      document.body,
      )}
    </span>
  );
}
