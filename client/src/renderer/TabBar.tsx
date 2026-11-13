// The tab bar (GitHub#397): the board is the fixed home tab on the left, every opened issue / PR
// is a tab with its status icon. Which status a tab shows, which one is unread and how the list
// changes are decided in shared/tabs.ts; this only draws them and reports clicks.
import { useEffect, useRef, useState } from 'react';
import { HOME, TAB_STATUS_TEXT, tabStatus, tabUnread, type TabInfo, type TabLabels, type TabStatus } from '../shared/tabs';
import { Icon, type IconName } from './Icons';
import { KEEPS_PANEL } from './outsideClick';
import { keyText } from './shortcuts';

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
  useEffect(() => {
    strip.current?.querySelector('[data-front="yes"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);
  return (
    // a click on the tab bar leaves the home tab's floating detail as it is (GitHub#442)
    <div className="tabs" data-testid="tabs" role="tablist" {...{ [KEEPS_PANEL]: '' }}>
      <button className={`tab tab-home${active === HOME ? ' on' : ''}`} role="tab" aria-selected={active === HOME} data-testid="tab-home" data-front={active === HOME ? 'yes' : 'no'} onClick={() => onPick(HOME)}>
        <Icon name="home" />
        <span className="tab-title">首页</span>
      </button>
      {tabs.length > 0 && <span className="tab-sep" aria-hidden="true" />}
      <div
        className="tab-strip"
        data-testid="tab-strip"
        ref={strip}
        onWheel={(e) => {
          if (e.deltaY !== 0 && e.deltaX === 0 && strip.current) strip.current.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((t, i) => {
          const on = t.key === active;
          const status = tabStatus(t.item, labels);
          const unread = tabUnread(t, on);
          const words = `${TAB_STATUS_TEXT[status]}${unread ? ' · 有新动静' : ''}`;
          return (
            <div
              key={t.key}
              className={`tab${on ? ' on' : ''}${over === t.key ? ' drop' : ''}`}
              role="tab"
              aria-selected={on}
              tabIndex={0}
              data-testid="tab"
              data-key={t.key}
              data-front={on ? 'yes' : 'no'}
              data-status={status}
              data-unread={unread ? 'yes' : 'no'}
              data-listed={t.listed ? 'yes' : 'no'}
              title={`${t.item.repo}#${t.item.number} ${t.item.title}\n${words}`}
              onClick={() => onPick(t.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPick(t.key);
                }
              }}
              // the middle button closes, as in a browser
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                onClose(t.key);
              }}
              draggable
              onDragStart={(e) => {
                dragged.current = t.key;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', t.key);
              }}
              onDragOver={(e) => {
                if (!dragged.current || dragged.current === t.key) return;
                e.preventDefault();
                setOver(t.key);
              }}
              onDragLeave={() => setOver((cur) => (cur === t.key ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragged.current;
                dragged.current = null;
                setOver(null);
                if (from && from !== t.key) onMove(from, i);
              }}
              onDragEnd={() => {
                dragged.current = null;
                setOver(null);
              }}
            >
              <span className="tab-status" data-testid="tab-status" role="img" aria-label={words}>
                <TabStatusIcon status={status} kind={t.item.kind} />
                {unread && <span className="tab-dot" data-testid="tab-dot" />}
              </span>
              <span className="tab-title" data-testid="tab-title">
                {t.item.title}
              </span>
              <span className="tab-ref">#{t.item.number}</span>
              <button
                className="tab-x"
                data-testid="tab-close"
                aria-label={`关掉标签页 #${t.item.number}`}
                title={on ? `关掉这个标签页（${keyText('closeTab')}）` : '关掉这个标签页'}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.key);
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
