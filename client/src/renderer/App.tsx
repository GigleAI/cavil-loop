import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '../shared/ipc';
import type { Layout } from '../shared/types';
import { parseFilter } from '../shared/filter';
import { api } from './api';
import { LoginView } from './LoginView';
import { BoardView, type BoardWarnings, type OpenIntent } from './BoardView';
import { DetailPanel, draftDirty, type ResultNote, type TabDraft } from './DetailPanel';
import { TabBar } from './TabBar';
import { ConfirmDialog } from './ConfirmDialog';
import { OPENS_ITEM } from './outsideClick';
import { HOME, afterClose, stepTab } from '../shared/tabs';
import type { WriteAction } from '../shared/actions';
import { SettingsView } from './SettingsView';
import { AppKindHelp } from './AppKindHelp';
import { useQuery } from './query';
import { dismiss, isShown, notifyWarningIds, reconcile, warningIds, type Dismissed } from './warnings';
import { useKeyboard, useShortcuts } from './keyboard';
import { ShortcutHelp } from './ShortcutHelp';
import type { SettingsIntent } from './EmptyGuide';

/** a shortcut that needs the board (GitHub#192): taken once by the board, then dropped */
export type BoardRequest = { kind: 'search' | 'newIssue'; seq: number };

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<'board' | 'settings'>('board');
  // GitHub#401: the empty board's buttons open Settings with the picker open, or the address box focused
  const [intent, setIntent] = useState<{ what: SettingsIntent; seq: number } | null>(null);
  const intentSeq = useRef(0);
  const [help, setHelp] = useState(false);
  const openHelp = () => setHelp(true);
  useEffect(() => {
    let alive = true;
    const off = api().subscribe((s) => alive && setSnap(s));
    api()
      .get()
      .then((s) => alive && setSnap(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // The search box text and the closed yellow bars live here, not in the
  // board: the board is unmounted while the settings page is up, and a
  // problem that clears (or a filter an import replaces) meanwhile must still
  // drop the record (GitHub#153). Closed bars are kept for this run only.
  // ---- GitHub#397: detail tabs ----
  // The board is the fixed home tab; every opened issue / PR is a tab (the list is the controller's,
  // `state.tabs`, kept on this machine). Which tab is in front is this window's own. Only the tab in
  // front has its detail mounted; what a tab holds unsent is kept here per tab (`drafts`).
  const tabs = snap?.state.tabs ?? [];
  const tabKeys = tabs.map((t) => t.key);
  const [active, setActive] = useState<string>(HOME);
  // a tab that is gone (closed, signed out) is not in front any more
  const front = tabKeys.includes(active) ? active : HOME;
  const frontRef = useRef(front);
  frontRef.current = front;
  const keysRef = useRef(tabKeys);
  keysRef.current = tabKeys;
  /** every time a tab comes to the front is its own opening of the detail (its React key) */
  const [opening, setOpening] = useState<{ n: number; intent: OpenIntent | null }>({ n: 0, intent: null });
  const drafts = useRef(new Map<string, TabDraft>());
  const [askClose, setAskClose] = useState<string | null>(null);
  // Everything the window keeps per tab belongs to the account it was typed under (code review round 1:
  // a reply typed before a sign-out came back after signing in again, also as another account). Leaving
  // "signed in" or another account showing ends this account's window state; a late report from a
  // detail of the ended account (its draft) is dropped by its generation.
  const account = snap?.state.phase === 'ready' ? `ready:${snap.state.viewer ?? ''}` : 'out';
  const accountGen = useRef(0);
  const lastAccount = useRef(account);
  if (lastAccount.current !== account) {
    const wasIn = lastAccount.current.startsWith('ready:');
    const sameAccountKnownLater = wasIn && lastAccount.current === 'ready:' && account.startsWith('ready:');
    lastAccount.current = account;
    if (!sameAccountKnownLater) {
      accountGen.current++;
      drafts.current = new Map();
    }
  }
  const gen = accountGen.current;
  useEffect(() => {
    if (gen === 0) return;
    setActive(HOME);
    setAskClose(null);
    setOpening((o) => ({ n: o.n + 1, intent: null }));
  }, [gen]);
  const [leftNote, setLeftNote] = useState<{ note: ResultNote; about?: WriteAction; seq: number } | null>(null);
  const show = (key: string, intent: OpenIntent | null = null) => {
    if (key === frontRef.current && !intent) return;
    // the keyboard leaves whatever the tab going behind had focused
    (document.activeElement as HTMLElement | null)?.blur?.();
    setActive(key);
    if (key !== HOME) setOpening((o) => ({ n: o.n + 1, intent }));
  };
  /** Open an item's tab (already open: that one). `background`: it does not come to the front. */
  const openTab = async (key: string, o: { background?: boolean; intent?: OpenIntent } = {}) => {
    const ok = await api().openTab(key);
    if (!ok || o.background) return;
    setHelp(false);
    show(key, o.intent ?? null);
  };
  /** A click with ⌘ / Ctrl held opens in the background, as in a browser. */
  const openFromClick = (key: string, intent?: OpenIntent) => {
    const ev = window.event;
    const background = !intent && ev instanceof MouseEvent && (ev.metaKey || ev.ctrlKey);
    void openTab(key, { background, intent });
  };
  const closeNow = (key: string) => {
    drafts.current.delete(key);
    setAskClose(null);
    setActive(afterClose(keysRef.current, key, frontRef.current));
    void api().closeTab(key);
  };
  /** The tab's ×, the middle button, ⌘W: text that was not sent is never dropped without asking. */
  const closeTab = (key: string) => {
    if (draftDirty(drafts.current.get(key))) {
      show(key);
      setAskClose(key);
    } else closeNow(key);
  };
  // a clicked notification (GitHub#169), a new issue just created: that item's tab, in front
  const focus = snap?.state.focus ?? null;
  useEffect(() => {
    if (!focus) return;
    setPage('board');
    void openTab(focus.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);
  // the middle button on anything that opens an item: its tab, in the background
  useEffect(() => {
    const aux = (e: MouseEvent) => {
      if (e.button !== 1 || !(e.target instanceof Element)) return;
      const opener = e.target.closest(`[${OPENS_ITEM}]`);
      const key = opener?.closest<HTMLElement>('[data-key]')?.dataset.key;
      if (!key) return;
      e.preventDefault();
      void api().openTab(key);
    };
    window.addEventListener('auxclick', aux);
    return () => window.removeEventListener('auxclick', aux);
  }, []);
  // the shell's "close" key (macOS: the menu's ⌘W): the tab in front, or — none in front — the window, as before
  const closeReq = snap ? snap.state.closeTabReq : null;
  const closeSeen = useRef<number | null>(null);
  useEffect(() => {
    if (closeReq === null) return;
    const first = closeSeen.current === null;
    const changed = closeSeen.current !== closeReq;
    closeSeen.current = closeReq;
    if (first || !changed) return;
    if (frontRef.current !== HOME) closeTab(frontRef.current);
    else void Promise.resolve(api().closeWindow()).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeReq]);

  // Keyboard shortcuts (GitHub#192). They live here, the layer that stays mounted on every page:
  // the board is unmounted while Settings (or the app-kind page) is up. Shortcuts that need the
  // board go back to it first and hand it a request, taken once (like a clicked notification).
  const signedIn = snap?.state.phase === 'ready';
  const keysOn = signedIn;
  // GitHub#369: the settings page has its own Esc (back to the board), only while it is the page showing
  const onSettings = signedIn && !help && page === 'settings' && front === HOME;
  useKeyboard(keysOn, onSettings ? 'settings' : 'board');
  const [keysHelp, setKeysHelp] = useState(false);
  const [boardReq, setBoardReq] = useState<BoardRequest | null>(null);
  const reqSeq = useRef(0);
  const toBoard = (kind: BoardRequest['kind']) => {
    setHelp(false);
    show(HOME);
    setPage('board');
    setBoardReq({ kind, seq: ++reqSeq.current });
  };
  const toLayout = (layout: Layout) => {
    setHelp(false);
    show(HOME);
    setPage('board');
    void api().setView({ layout });
  };
  useShortcuts({
    search: () => toBoard('search'),
    newIssue: () => toBoard('newIssue'),
    // GitHub#372: the layout buttons' own action (the choice is kept like a click), on the board page
    viewBoard: () => toLayout('board'),
    viewTable: () => toLayout('table'),
    viewGraph: () => toLayout('graph'),
    // also while a round runs: starts over, like the button (GitHub#217)
    sync: () => void api().restartSync(),
    settings: () => {
      setHelp(false);
      show(HOME);
      setPage('settings');
    },
    help: () => setKeysHelp(true),
    // GitHub#397. With no tab in front the key is not ours (macOS: the shell closes the window, see above).
    closeTab: () => {
      if (front === HOME) return false;
      closeTab(front);
    },
    nextTab: () => {
      if (!tabKeys.length) return false;
      show(stepTab(tabKeys, front, 1));
    },
    prevTab: () => {
      if (!tabKeys.length) return false;
      show(stepTab(tabKeys, front, -1));
    },
  });

  const [query, setQuery] = useQuery(snap?.state.view.query ?? '');
  // GitHub#404: the search from before a view-bar number was clicked (kept here: the board unmounts on the settings page)
  const tallySaved = useRef<string | null>(null);
  const parsed = useMemo(() => parseFilter(query), [query]);
  const sync = snap?.state.sync;
  const notifyProblem = snap?.state.notifyProblem ?? null;
  const current = useMemo(() => (sync ? { ...warningIds(sync, parsed), ...notifyWarningIds(notifyProblem) } : null), [sync, parsed, notifyProblem]);
  const [closed, setClosed] = useState<Dismissed>({});
  // reconciled on every render, whichever page is showing; nothing is judged before the first snapshot
  const live = current ? reconcile(closed, current) : closed;
  if (live !== closed) setClosed(live);
  const warn: BoardWarnings = {
    shown: (kind) => current !== null && isShown(kind, current, live),
    close: (kind) => {
      if (current) setClosed((d) => dismiss(d, current, kind));
    },
  };

  const ready = snap?.state.phase === 'ready' && !help;
  return (
    <div data-testid="app-root" className="app" data-phase={snap?.state.phase ?? 'loading'}>
      {ready && (
        <TabBar
          tabs={tabs}
          active={front}
          labels={{ human: snap!.state.handBack.human, doing: snap!.state.handBack.running, blocked: snap!.state.handBack.blocked }}
          onPick={(key) => show(key)}
          onClose={closeTab}
          onMove={(key, to) => void api().moveTab(key, to)}
        />
      )}
      {!snap || snap.state.phase === 'loading' ? (
        <div className="center muted">正在启动…</div>
      ) : help ? (
        <AppKindHelp onBack={() => setHelp(false)} />
      ) : snap.state.phase === 'login' ? (
        <LoginView state={snap.state} onHelp={openHelp} />
      ) : (
        <div className="tab-pages">
          {/* the home tab stays mounted behind a detail tab: its scroll position and its search are kept */}
          <div className="tab-page" data-testid="tab-page-home" data-front={front === HOME ? 'yes' : 'no'} aria-hidden={front !== HOME}>
            {page === 'settings' ? (
              <SettingsView state={snap.state} data={snap.data} onBack={() => setPage('board')} onHelp={openHelp} intent={intent} onIntentTaken={() => setIntent(null)} />
            ) : (
              <BoardView
                state={snap.state}
                data={snap.data}
                query={query}
                setQuery={setQuery}
                parsed={parsed}
                warn={warn}
                onOpen={openFromClick}
                detailKey={front === HOME ? null : front}
                leftNote={leftNote}
                request={boardReq}
                onRequestTaken={() => setBoardReq(null)}
                onSettings={(what) => {
                  setIntent(what ? { what, seq: ++intentSeq.current } : null);
                  setPage('settings');
                }}
                onKeysHelp={() => setKeysHelp(true)}
                tallySaved={tallySaved}
              />
            )}
          </div>
          {front !== HOME && (
            <div className="tab-page" data-testid="tab-page-detail" data-front="yes">
              <DetailPanel
                itemKey={front}
                state={snap.state}
                data={snap.data}
                onHome={() => show(HOME)}
                onLeftBehind={(note, about) => setLeftNote((cur) => ({ note, about, seq: (cur?.seq ?? 0) + 1 }))}
                intent={opening.intent}
                key={`${gen}:${front}:${opening.n}`}
                draft={drafts.current.get(front) ?? null}
                onDraft={(d) => {
                  if (accountGen.current === gen) drafts.current.set(front, d);
                }}
              />
            </div>
          )}
        </div>
      )}
      {askClose && tabKeys.includes(askClose) && (
        <ConfirmDialog title="关掉这个标签页？" confirmLabel="关掉，不要这些文字" danger onCancel={() => setAskClose(null)} onConfirm={() => closeNow(askClose)}>
          <p data-testid="tab-close-question">这个标签页里还有没发出的文字（回复、正在编辑的评论或标题）。关掉后这些文字就没有了。</p>
        </ConfirmDialog>
      )}
      {keysOn && keysHelp && <ShortcutHelp onClose={() => setKeysHelp(false)} />}
    </div>
  );
}
