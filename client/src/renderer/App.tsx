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
import { HOME, afterClose, autoCloseVerdict, stepTab, tabAt } from '../shared/tabs';
import { OpNotice } from './OpNotice';
import { OpenMenu, type OpenHow, type OpenMenuAt } from './OpenMenu';
import type { WriteAction } from '../shared/actions';
import type { OpRecord } from '../shared/ops';
import { SettingsView } from './SettingsView';
import { AppKindHelp } from './AppKindHelp';
import { useQuery } from './query';
import { dismiss, isShown, notifyWarningIds, reconcile, warningIds, type Dismissed } from './warnings';
import { useKeyboard, useShortcuts } from './keyboard';
import { ShortcutHelp } from './ShortcutHelp';
import { setCustomKeys, type CustomKeys } from './shortcuts';
import type { SettingsIntent } from './EmptyGuide';

/** GitHub#442: the "tab" the close question / ⌘W is about when it is the floating panel (never an item key) */
const FLOAT = '\u0000float';

/**
 * GitHub#447: where a close (issue or PR) was started — one life of a tab (`life`: closed and opened
 * again, the same item is another tab), or one opening of the floating panel (`n`: the panel showing
 * another item, or opened again, is another place)
 */
type CloseOrigin = { where: 'tab'; key: string; life: number } | { where: 'float'; key: string; n: number };

/** a shortcut that needs the board (GitHub#192): taken once by the board, then dropped */
export type BoardRequest = { kind: 'search' | 'newIssue'; seq: number };

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const [page, setPage] = useState<'board' | 'settings'>('board');
  const pageRef = useRef(page);
  pageRef.current = page;
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
  // GitHub#447 (PR #454 code review round 1): every tab gets a life of its own when it shows up; closed and
  // opened again — by any way — it is another life, so a close started in the old tab never puts away the new one
  const tabLife = useRef(new Map<string, number>());
  const lifeSeq = useRef(0);
  for (const k of [...tabLife.current.keys()]) if (!tabKeys.includes(k)) tabLife.current.delete(k);
  for (const k of tabKeys) if (!tabLife.current.has(k)) tabLife.current.set(k, ++lifeSeq.current);
  const lifeOf = (k: string) => tabLife.current.get(k) ?? -1;
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
    setFloat(null);
    floatDraft.current = null;
    setMenu(null);
    closeOrigins.current = new Map();
    setPutAway([]);
    setHeld([]);
  }, [gen]);
  // ---- GitHub#442: the floating detail, the default way to open an item ----
  // It belongs to the home tab: it shows over the board on the right, and is drawn only while the home
  // tab is in front (going to a tab and back finds it again — a new opening, its unsent text kept here).
  const [float, setFloat] = useState<{ key: string; n: number; intent: OpenIntent | null } | null>(null);
  const floatSeq = useRef(0);
  const floatRef = useRef(float);
  floatRef.current = float;
  /** what the floating panel holds unsent, and for which item */
  const floatDraft = useRef<{ key: string; draft: TabDraft } | null>(null);
  const closeFloatNow = () => {
    floatDraft.current = null;
    setFloat(null);
    setHeld((h) => (h.some((x) => x.where === 'float') ? h.filter((x) => x.where !== 'float') : h));
  };
  // ---- GitHub#447: a close made in a tab / the floating panel puts it away once GitHub took it ----
  /** the closes started from a detail of this account and not decided yet: operation id → where */
  const closeOrigins = useRef(new Map<string, CloseOrigin>());
  /** closes whose detail was put away: their notices show in the strip above every page, not above the board */
  const [putAway, setPutAway] = useState<string[]>([]);
  /** closes that went through while their place held unsent text: the place stayed and says why */
  const [held, setHeld] = useState<({ id: string } & CloseOrigin)[]>([]);
  const [menu, setMenu] = useState<OpenMenuAt | null>(null);
  const [leftNote, setLeftNote] = useState<{ note: ResultNote; about?: WriteAction; seq: number } | null>(null);
  const show = (key: string, intent: OpenIntent | null = null) => {
    if (key === frontRef.current && !intent) return;
    // the keyboard leaves whatever the tab going behind had focused
    (document.activeElement as HTMLElement | null)?.blur?.();
    // GitHub#442: the floating panel goes behind with the home tab; coming back is a new opening of it, which
    // must not do its notice's 重试 / 去回复 a second time
    if (key !== HOME) setFloat((f) => (f?.intent ? { ...f, intent: null } : f));
    setActive(key);
    if (key !== HOME) setOpening((o) => ({ n: o.n + 1, intent }));
  };
  /** Open an item's tab (already open: that one). `background`: it does not come to the front. */
  const openTab = async (key: string, o: { background?: boolean; intent?: OpenIntent } = {}) => {
    const ok = await api().openTab(key);
    if (!ok) return;
    // GitHub#442: the item was in the floating panel: it moves into its tab, with what it held unsent
    if (floatRef.current?.key === key) {
      const d = floatDraft.current;
      if (d?.key === key && !drafts.current.has(key)) drafts.current.set(key, d.draft);
      closeFloatNow();
    }
    if (o.background) return;
    setHelp(false);
    show(key, o.intent ?? null);
  };
  /**
   * GitHub#442: open an item. `float` (a plain click, a notification, a notice's 打开 / 重试 / 去回复):
   * the floating panel over the board — or, when the item already has a tab, that tab (one item never
   * has two reply boxes). `front` (⌘ / Ctrl + click): its tab, in front. `back` (the middle button): its
   * tab, behind.
   */
  const openItem = (key: string, how: OpenHow, intent: OpenIntent | null = null) => {
    setMenu(null);
    if (how === 'back') return void openTab(key, { background: true });
    if (how === 'front' || keysRef.current.includes(key)) return void openTab(key, { intent: intent ?? undefined });
    setHelp(false);
    setPage('board');
    show(HOME);
    if (floatDraft.current?.key !== key) floatDraft.current = null;
    // the item the panel shows already: that opening stays (its unfolded entries, its scroll) — unless a notice asks something of it
    setFloat((cur) => (cur?.key === key && !intent ? cur : { key, n: ++floatSeq.current, intent }));
  };
  /** A click with ⌘ / Ctrl held opens the item's tab in front (GitHub#442); a plain click, the floating panel. */
  const openFromClick = (key: string, intent?: OpenIntent) => {
    const ev = window.event;
    const mod = !intent && ev instanceof MouseEvent && (ev.metaKey || ev.ctrlKey);
    openItem(key, mod ? 'front' : 'float', intent ?? null);
  };
  const openRef = useRef(openItem);
  openRef.current = openItem;
  const itemsRef = useRef(snap?.data.items ?? []);
  itemsRef.current = snap?.data.items ?? [];
  const closeNow = (key: string) => {
    setAskClose(null);
    if (key === FLOAT) return closeFloatNow();
    drafts.current.delete(key);
    setHeld((h) => (h.some((x) => x.where === 'tab' && x.key === key) ? h.filter((x) => !(x.where === 'tab' && x.key === key)) : h));
    // this tab's life ends here: a close it started can no longer put anything away (the snapshot may still list the key a moment)
    for (const [id, o] of closeOrigins.current) if (o.where === 'tab' && o.key === key) closeOrigins.current.delete(id);
    tabLife.current.delete(key);
    setActive(afterClose(keysRef.current, key, frontRef.current));
    void api().closeTab(key);
  };
  /**
   * GitHub#447: decide every close started from a detail, against the operations as they are now and
   * the place as it is now (`autoCloseVerdict`, the one rule for tabs and the panel). Run on every
   * change of the operations and right after a close was started (its answer may already be in).
   */
  const settleCloses = () => {
    const ops = snapRef.current?.state.ops ?? [];
    for (const [id, o] of [...closeOrigins.current]) {
      const f = floatRef.current;
      const place =
        o.where === 'tab'
          ? { present: keysRef.current.includes(o.key) && tabLife.current.get(o.key) === o.life, dirty: draftDirty(drafts.current.get(o.key)) }
          : { present: f !== null && f.key === o.key && f.n === o.n, dirty: floatDraft.current?.key === o.key && draftDirty(floatDraft.current.draft) };
      const v = autoCloseVerdict(ops.find((r) => r.id === id), place);
      if (v === 'wait') continue;
      closeOrigins.current.delete(id);
      if (v === 'close') {
        setPutAway((l) => (l.includes(id) ? l : [...l, id]));
        if (o.where === 'tab') closeNow(o.key);
        else closeFloatNow();
      } else if (v === 'hold') setHeld((h) => [...h.filter((x) => x.id !== id), { id, ...o }]);
    }
  };
  const settleRef = useRef(settleCloses);
  settleRef.current = settleCloses;
  const ops = snap?.state.ops;
  useEffect(() => {
    settleRef.current();
    // a put-away close whose record is gone or was put away itself leaves the strip for good
    const live = ops ?? [];
    setPutAway((l) => {
      const next = l.filter((id) => live.some((r) => r.id === id && !r.dismissed));
      return next.length === l.length ? l : next;
    });
  }, [ops]);
  /** a detail of this account (`g`) started a close from `o` */
  const closeStarted = (g: number, o: CloseOrigin) => (id: string) => {
    if (accountGen.current !== g) return;
    closeOrigins.current.set(id, o);
    settleRef.current();
  };
  /** The tab's ×, the middle button, ⌘W: text that was not sent is never dropped without asking. */
  const closeTab = (key: string) => {
    // GitHub#442: ⌘W on the home tab puts the floating panel away, asking first when it holds unsent text
    if (key === FLOAT) {
      if (draftDirty(floatDraft.current?.draft)) setAskClose(FLOAT);
      else closeFloatNow();
      return;
    }
    if (draftDirty(drafts.current.get(key))) {
      show(key);
      setAskClose(key);
    } else closeNow(key);
  };
  // a clicked notification (GitHub#169), a new issue just created: that item, the way a click opens it (GitHub#442)
  const focus = snap?.state.focus ?? null;
  useEffect(() => {
    if (!focus) return;
    setPage('board');
    openItem(focus.key, 'float');
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
      openRef.current(key, 'back');
    };
    // GitHub#442: a right click on anything that opens an item: what can be done with it
    const menuAt = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      const opener = e.target.closest(`[${OPENS_ITEM}]`);
      const key = opener?.closest<HTMLElement>('[data-key]')?.dataset.key;
      if (!key) return;
      const url = itemsRef.current.find((i) => i.key === key)?.url;
      // a box of the graph that is no item of the board (only its number is known): nothing to offer
      if (!url) return;
      e.preventDefault();
      setMenu({ key, url, x: e.clientX, y: e.clientY });
    };
    window.addEventListener('auxclick', aux);
    window.addEventListener('contextmenu', menuAt);
    return () => {
      window.removeEventListener('auxclick', aux);
      window.removeEventListener('contextmenu', menuAt);
    };
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
    else if (floatRef.current && pageRef.current === 'board') closeTab(FLOAT);
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
  // GitHub#487: the keys changed on this machine, for every key decision and tooltip drawn below
  setCustomKeys(snap?.state.shortcutKeys as CustomKeys | undefined);
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
    // GitHub#397. With no tab in front the key is not ours (macOS: the shell closes the window, see above) —
    // unless the floating panel is open over the board: then it goes (GitHub#442).
    closeTab: () => {
      if (front !== HOME) return void closeTab(front);
      if (float && page === 'board') return void closeTab(FLOAT);
      return false;
    },
    // GitHub#442: ⌘1 … ⌘9, as in a browser (⌘1 = 首页, ⌘9 = the last tab)
    tabAt: (spec) => {
      const to = tabAt(tabKeys, Number(spec.key));
      if (to === null || !tabKeys.length) return false;
      show(to);
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
  // GitHub#464: the view-bar number last clicked — tells two numbers with one click text apart (state: a switch
  // between them leaves the box as it is, and the lit number and its "显示已关闭" switch must still follow)
  const [tallyPick, setTallyPick] = useState<string | null>(null);
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
      {/* GitHub#442: the tab bar shows only once a tab is open; the last one closed, it goes */}
      {ready && tabs.length > 0 && (
        <TabBar
          tabs={tabs}
          active={front}
          labels={{ human: snap!.state.handBack.human, doing: snap!.state.handBack.running, blocked: snap!.state.handBack.blocked }}
          onPick={(key) => show(key)}
          onClose={closeTab}
          onMove={(key, to) => void api().moveTab(key, to)}
        />
      )}
      {ready && <PutAwayStrip ops={snap!.state.ops} ids={putAway} showing={[front === HOME ? null : front, front === HOME && float && page === 'board' ? float.key : null]} open={openItem} />}
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
                floatKey={front === HOME && float ? float.key : null}
                shownAbove={putAway}
                floatPanel={
                  front === HOME && float ? (
                    <DetailPanel
                      itemKey={float.key}
                      state={snap.state}
                      data={snap.data}
                      float={{ onClose: closeFloatNow, onOpenTab: () => void openTab(float.key) }}
                      onHome={closeFloatNow}
                      onLeftBehind={(note, about) => setLeftNote((cur) => ({ note, about, seq: (cur?.seq ?? 0) + 1 }))}
                      intent={float.intent}
                      onCloseStarted={closeStarted(gen, { where: 'float', key: float.key, n: float.n })}
                      autoCloseHeld={heldFor(held, { where: 'float', key: float.key, n: float.n }, setHeld)}
                      key={`${gen}:float:${float.key}:${float.n}`}
                      draft={floatDraft.current?.key === float.key ? floatDraft.current.draft : null}
                      onDraft={(d) => {
                        if (accountGen.current === gen) floatDraft.current = { key: float.key, draft: d };
                      }}
                    />
                  ) : null
                }
                leftNote={leftNote}
                request={boardReq}
                onRequestTaken={() => setBoardReq(null)}
                onSettings={(what) => {
                  setIntent(what ? { what, seq: ++intentSeq.current } : null);
                  setPage('settings');
                }}
                onKeysHelp={() => setKeysHelp(true)}
                tallySaved={tallySaved}
                tallyPick={tallyPick}
                onTallyPick={setTallyPick}
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
                onCloseStarted={closeStarted(gen, { where: 'tab', key: front, life: lifeOf(front) })}
                autoCloseHeld={heldFor(held, { where: 'tab', key: front, life: lifeOf(front) }, setHeld)}
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
      {askClose === FLOAT && float && (
        <ConfirmDialog title="收起这个面板？" confirmLabel="收起，不要这些文字" danger onCancel={() => setAskClose(null)} onConfirm={() => closeNow(FLOAT)}>
          <p data-testid="tab-close-question">面板里还有没发出的文字（回复、正在编辑的评论或标题）。收起后这些文字就没有了。</p>
        </ConfirmDialog>
      )}
      {menu && (
        <OpenMenu
          at={menu}
          onPick={(how) => openItem(menu.key, how)}
          onWeb={() => {
            setMenu(null);
            void Promise.resolve(api().openExternal(menu.url)).catch(() => undefined);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {askClose && tabKeys.includes(askClose) && (
        <ConfirmDialog title="关掉这个标签页？" confirmLabel="关掉，不要这些文字" danger onCancel={() => setAskClose(null)} onConfirm={() => closeNow(askClose)}>
          <p data-testid="tab-close-question">这个标签页里还有没发出的文字（回复、正在编辑的评论或标题）。关掉后这些文字就没有了。</p>
        </ConfirmDialog>
      )}
      {keysOn && keysHelp && (
        <ShortcutHelp
          onClose={() => setKeysHelp(false)}
          onEdit={() => {
            setKeysHelp(false);
            setHelp(false);
            show(HOME);
            setIntent({ what: 'keys', seq: ++intentSeq.current });
            setPage('settings');
          }}
        />
      )}
    </div>
  );
}

/** GitHub#447: the "kept because of unsent text" line of a place, if it has one; its × removes it */
function heldFor(
  held: ({ id: string } & CloseOrigin)[],
  o: CloseOrigin,
  setHeld: (f: (h: ({ id: string } & CloseOrigin)[]) => ({ id: string } & CloseOrigin)[]) => void,
): { onDismiss: () => void } | null {
  const same = (x: CloseOrigin) => x.where === o.where && x.key === o.key && (x.where === 'tab' ? o.where === 'tab' && x.life === o.life : o.where === 'float' && x.n === o.n);
  if (!held.some(same)) return null;
  return { onDismiss: () => setHeld((h) => h.filter((x) => !same(x))) };
}

/**
 * GitHub#447: the notices of closes that put their tab / floating panel away. They show here, above
 * every page (under the tab bar; at the top of the window when no tab is open), so the result is seen
 * wherever the window went — the next tab's detail, the board, or the tab the person was on when the
 * answer came. The same notice as above the board (its text, buttons and 5 s rule); the board leaves
 * these out, and an item open in front (its detail or the floating panel) shows its own.
 */
function PutAwayStrip({ ops, ids, showing, open }: { ops: OpRecord[]; ids: string[]; showing: (string | null)[]; open: (key: string, how: OpenHow, intent?: OpenIntent | null) => void }) {
  const list = ops.filter((r) => ids.includes(r.id) && !r.dismissed && !showing.includes(r.key));
  if (!list.length) return null;
  return (
    <div className="op-strip" data-testid="op-strip">
      {list.map((r) => (
        <OpNotice
          key={r.id}
          r={r}
          prefix={`${r.repo}#${r.number}：`}
          onOpen={(key) => open(key, 'float')}
          onRetry={(x) => open(x.key, 'float', { opId: x.id, what: 'retry' })}
          onToReply={(x) => open(x.key, 'float', { opId: x.id, what: 'toReply' })}
        />
      ))}
    </div>
  );
}
