// The tab bar (GitHub#397): the board is the fixed home tab on the left, every opened issue / PR
// is a tab with its status icon. Which status a tab shows, which one is unread and how the list
// changes are decided in shared/tabs.ts; this only draws them and reports clicks.
import { useEffect, useRef, useState } from 'react';
import { HOME, TAB_STATUS_TEXT, tabStatus, tabUnread, type TabInfo, type TabLabels, type TabStatus } from '../shared/tabs';
import { Icon, type IconName } from './Icons';
import { KEEPS_PANEL } from './outsideClick';
import { keyText } from './shortcuts';
import { t, tKey } from '../shared/i18n';
import { Verbatim, verbatimParts } from './Verbatim';

const ICON: Record<Exclude<TabStatus, 'running' | 'waiting' | 'blocked'>, { issue: IconName; pr: IconName; tone: string }> = {
  merged: { issue: 'pr-merged', pr: 'pr-merged', tone: 'done' },
  closed: { issue: 'pr-closed', pr: 'pr-closed', tone: 'closed' },
  done: { issue: 'issue-done', pr: 'pr-closed', tone: 'done' },
  skipped: { issue: 'issue-skipped', pr: 'pr-closed', tone: 'neutral' },
  draft: { issue: 'issue-open', pr: 'pr-open', tone: 'neutral' },
  open: { issue: 'issue-open', pr: 'pr-open', tone: 'open' },
};

/** The square the "running" icon's bright stretch goes round, starting at the top-left. */
const FRAME = 'M4 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z';

/** The status icon of one tab: GitHub's own state icons, plus "an agent is working on it" (a stretch of edge going round a square, GitHub#449), "waiting for a human" and "waiting for a prerequisite" (a pause, GitHub#443). */
export function TabStatusIcon({ status, kind }: { status: TabStatus; kind: 'issue' | 'pr' }) {
  if (status === 'running')
    // GitHub#449: a hollow square with a short bright stretch of its edge going round it (one lap in 2 s),
    // a small solid square in the middle. Still under "reduce motion": the stretch rests at the top-left.
    // Not a spinner (GitHub#442: one read as "still loading"): the path is a square and there is no disc.
    return (
      <svg className="tab-icon running" data-icon="frame-run" viewBox="0 0 16 16" width={16} height={16} aria-hidden="true">
        <path className="track" d={FRAME} />
        <path className="seg" d={FRAME} pathLength={100} />
        <rect className="core" x="6" y="6" width="4" height="4" rx="1" />
      </svg>
    );
  if (status === 'waiting')
    return (
      <svg className="tab-icon waiting" viewBox="0 0 16 16" width={16} height={16} aria-hidden="true">
        <circle className="disc" cx="8" cy="8" r="7" />
        <circle className="person" cx="8" cy="6" r="2.2" />
        <path className="person" d="M3.9 12.4c.6-2 2.2-3 4.1-3s3.5 1 4.1 3" />
      </svg>
    );
  if (status === 'blocked')
    return (
      <svg className="tab-icon blocked" viewBox="0 0 16 16" width={16} height={16} aria-hidden="true">
        <circle className="disc" cx="8" cy="8" r="7" />
        <rect className="bar" x="5.4" y="4.6" width="1.9" height="6.8" rx="0.5" />
        <rect className="bar" x="8.7" y="4.6" width="1.9" height="6.8" rx="0.5" />
      </svg>
    );
  const i = ICON[status];
  return (
    <span className={`tab-icon tone-${i.tone}`}>
      <Icon name={i[kind]} />
    </span>
  );
}

export function TabBar({
  tabs,
  active,
  labels,
  onPick,
  onClose,
  onMove,
}: {
  tabs: TabInfo[];
  /** HOME or the key of the tab in front */
  active: string;
  labels: TabLabels;
  onPick: (key: string) => void;
  onClose: (key: string) => void;
  /** a tab dragged onto the place of another one */
  onMove: (key: string, to: number) => void;
}) {
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // more tabs than fit: the strip scrolls sideways (the wheel moves it), and the tab in front is kept in view
  const strip = useRef<HTMLDivElement>(null);
  // GitHub#467: which side has tabs scrolled out of sight — that edge fades and gets its arrow
  const [hidden, setHidden] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const measure = () => {
    const el = strip.current;
    if (!el) return;
    const next = overflowOf(el.scrollLeft, el.clientWidth, el.scrollWidth);
    setHidden((cur) => (cur.left === next.left && cur.right === next.right ? cur : next));
  };
  useEffect(() => {
    strip.current?.querySelector('[data-front="yes"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [active, tabs.length]);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** one arrow click: most of what is visible, so the tab at the edge stays in sight */
  const page = (dir: -1 | 1) => {
    const el = strip.current;
    if (el) el.scrollBy?.({ left: dir * Math.max(120, el.clientWidth * 0.8), behavior: 'smooth' });
  };
  return (
    // a click on the tab bar leaves the home tab's floating detail as it is (GitHub#442)
    <div className="tabs" data-testid="tabs" role="tablist" {...{ [KEEPS_PANEL]: '' }}>
      <button className={`tab tab-home${active === HOME ? ' on' : ''}`} role="tab" aria-selected={active === HOME} data-testid="tab-home" data-front={active === HOME ? 'yes' : 'no'} onClick={() => onPick(HOME)}>
        <Icon name="home" />
        <span className="tab-title">{t('首页')}</span>
      </button>
      {tabs.length > 0 && <span className="tab-sep" aria-hidden="true" />}
      <div className={`tab-scroll${hidden.left ? ' more-left' : ''}${hidden.right ? ' more-right' : ''}`}>
        {hidden.left && (
          <button className="tab-arrow left" data-testid="tab-arrow-left" aria-label={t('往左看更多标签页')} title={t('往左看更多标签页')} tabIndex={-1} onClick={() => page(-1)}>
            <Icon name="chevron-left" size={14} />
          </button>
        )}
        <div
          className="tab-strip"
          data-testid="tab-strip"
          ref={strip}
          onScroll={measure}
          onWheel={(e) => {
            if (e.deltaY !== 0 && e.deltaX === 0 && strip.current) strip.current.scrollLeft += e.deltaY;
          }}
          // GitHub#467: a tab dragged to an edge of the strip scrolls it, so every place can be reached
          onDragOver={(e) => {
            const el = strip.current;
            if (!el || !dragged.current) return;
            const r = el.getBoundingClientRect();
            if (e.clientX < r.left + EDGE) el.scrollLeft -= EDGE_STEP;
            else if (e.clientX > r.right - EDGE) el.scrollLeft += EDGE_STEP;
          }}
        >
          {tabs.map((tab, i) => {
            const on = tab.key === active;
            const status = tabStatus(tab.item, labels);
            const unread = tabUnread(tab, on);
            const words = unread ? t('{status} · 有新动静', { status: tKey(TAB_STATUS_TEXT[status]) }) : tKey(TAB_STATUS_TEXT[status]);
            return (
              <div
                key={tab.key}
                className={`tab${on ? ' on' : ''}${over === tab.key ? ' drop' : ''}`}
                role="tab"
                aria-selected={on}
                tabIndex={0}
                data-testid="tab"
                data-key={tab.key}
                data-front={on ? 'yes' : 'no'}
                data-status={status}
                data-unread={unread ? 'yes' : 'no'}
                data-listed={tab.listed ? 'yes' : 'no'}
                title={`${tab.item.repo}#${tab.item.number} ${tab.item.title}\n${words}`}
                {...verbatimParts('github', [tab.item.repo, tab.item.title])}
                onClick={() => onPick(tab.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onPick(tab.key);
                  }
                }}
                // the middle button closes, as in a browser
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  onClose(tab.key);
                }}
                draggable
                onDragStart={(e) => {
                  dragged.current = tab.key;
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', tab.key);
                }}
                onDragOver={(e) => {
                  if (!dragged.current || dragged.current === tab.key) return;
                  e.preventDefault();
                  setOver(tab.key);
                }}
                onDragLeave={() => setOver((cur) => (cur === tab.key ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragged.current;
                  dragged.current = null;
                  setOver(null);
                  if (from && from !== tab.key) onMove(from, i);
                }}
                onDragEnd={() => {
                  dragged.current = null;
                  setOver(null);
                }}
              >
                <span className="tab-status" data-testid="tab-status" role="img" aria-label={words}>
                  <TabStatusIcon status={status} kind={tab.item.kind} />
                  {unread && <span className="tab-dot" data-testid="tab-dot" />}
                </span>
                <span className="tab-title" data-testid="tab-title">
                  <Verbatim from="github">{tab.item.title}</Verbatim>
                </span>
                <span className="tab-ref">#{tab.item.number}</span>
                <button
                  className="tab-x"
                  data-testid="tab-close"
                  aria-label={t('关掉标签页 #{number}', { number: tab.item.number })}
                  title={on ? t('关掉这个标签页（{key}）', { key: keyText('closeTab') }) : t('关掉这个标签页')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.key);
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            );
          })}
        </div>
        {hidden.right && (
          <button className="tab-arrow right" data-testid="tab-arrow-right" aria-label={t('往右看更多标签页')} title={t('往右看更多标签页')} tabIndex={-1} onClick={() => page(1)}>
            <Icon name="chevron-right" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/** how close to an edge of the strip a dragged tab has to be to scroll it, and how far one step goes (px) */
const EDGE = 32;
const EDGE_STEP = 12;

/**
 * GitHub#467: which sides of the strip have tabs out of sight. A pixel of slack either way: a strip
 * scrolled by a fraction (zoom, a trackpad) is not "one more tab hidden".
 */
export function overflowOf(scrollLeft: number, clientWidth: number, scrollWidth: number): { left: boolean; right: boolean } {
  return { left: scrollLeft > 1, right: scrollLeft + clientWidth < scrollWidth - 1 };
}
