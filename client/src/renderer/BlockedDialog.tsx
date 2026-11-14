// GitHub#434: "等前置…" — pick what the item waits for (search the item's repository by number,
// number prefix, address (GitHub#448) or title), then register it the way the daemon reads it. The dialog only shows and picks: what is
// read, what is written and every check before a write are the controller's (blockedRead /
// blockedSearch / blockedStart), the rules shared/blocked.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { SETTLES_NOTHING, confirmBlock, layerRows, parseRefQuery, planBlocked, planLines, rankByNumber, refKey, type NumberSettled, type Pick, type Ref } from '../shared/blocked';
import type { BlockedRefInfo, BlockedView } from '../shared/ipc';
import type { AppState, Item } from '../shared/types';
import { t, tKey, zhKey } from '../shared/i18n';
import { tNode } from './tNode';
import { SaidText, Verbatim } from './Verbatim';

type Candidate = BlockedRefInfo & Pick;

const STATE_TEXT: Record<BlockedRefInfo['state'], string> = { open: zhKey('开'), closed: zhKey('已关闭'), merged: zhKey('已合并'), unknown: zhKey('读不到状态') };

function refName(r: { repo: string; number: number; kind?: string | null }, selfRepo: string): string {
  const n = r.repo === selfRepo.toLowerCase() ? `#${r.number}` : `${r.repo}#${r.number}`;
  return r.kind === 'pr' ? `PR ${n}` : n;
}

function RefChip({ r, selfRepo, testid, onRemove, fresh, locked }: { r: BlockedRefInfo; selfRepo: string; testid: string; onRemove?: () => void; fresh?: boolean; locked?: boolean }) {
  return (
    <span className={`chip blocked-chip${fresh ? ' new' : ''}`} data-testid={testid} data-ref={refKey(r)}>
      <b>{refName(r, selfRepo)}</b>
      <span className="blocked-title">
        <Verbatim from="github">{r.title}</Verbatim>
      </span>
      <span className={`small ${r.state === 'open' ? '' : 'muted'}`}>{tKey(STATE_TEXT[r.state])}</span>
      {onRemove && (
        <button className="link" aria-label={t('去掉')} data-testid="blocked-pick-remove" disabled={locked} onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  );
}

export function BlockedDialog({ item, state, items, onClose }: { item: Item; state: AppState; items: Item[]; onClose: () => void }) {
  const [view, setView] = useState<BlockedView | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [picks, setPicksState] = useState<Candidate[]>([]);
  // GitHub#523: the picks as of now, not as of the last render — "登记前置" waits for an item still being read
  // into the list and then registers what the list holds by then
  const picksRef = useRef<Candidate[]>([]);
  const setPicks = (f: (p: Candidate[]) => Candidate[]) => {
    picksRef.current = f(picksRef.current);
    setPicksState(picksRef.current);
  };
  // the adds whose read has not come back yet; each one says whether its item went into the list
  const adding = useRef(new Set<Promise<boolean>>());
  // PR #531 review round 1: from the press of "登记前置" until its answer the choice is fixed — nothing can be
  // picked, taken off or ticked, so what is registered is what the list held at the press plus the reads already
  // under way then. A ref, not `busy`: a click in the same moment must not slip in before the next render.
  const submitting = useRef(false);
  const [restore, setRestore] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const [found, setFound] = useState<Candidate[]>([]);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  // the board's items are read when the text changes, never a reason to search again (a sync round replaces the list)
  const itemsRef = useRef(items);
  const textRef = useRef('');
  itemsRef.current = items;
  textRef.current = text;

  const take = (v: BlockedView) => {
    setView(v);
    if (v.ok) setRestore(new Set(v.lost.map((r) => refKey(r))));
  };
  useEffect(() => {
    let live = true;
    void api()
      .blockedRead(item.key)
      .then((v) => live && take(v));
    return () => {
      live = false;
    };
  }, [item.key]);

  const taken = useMemo(() => {
    const s = new Set<string>(picks.map((p) => refKey(p)));
    if (view?.ok) for (const r of view.current) s.add(refKey(r));
    s.add(item.key);
    return s;
  }, [picks, view, item.key]);

  // the search: what the board already holds first, then GitHub (after a pause in typing). A number
  // (or an address) is read the one way the back end reads it (shared/blocked.ts, GitHub#448)
  useEffect(() => {
    const q = text.trim();
    const my = ++seq.current;
    setSearchErr(null);
    if (!q) {
      setFound([]);
      setSearching(false);
      return;
    }
    const parsed = parseRefQuery(q, state.githubWeb);
    const self = { repo: item.repo.toLowerCase(), number: item.number };
    const board = (repo: string): Candidate[] =>
      itemsRef.current
        .filter((i) => i.repo.toLowerCase() === repo)
        .map((i) => ({ repo: i.repo.toLowerCase(), number: i.number, kind: i.kind, id: 0, title: i.title, state: i.state === 'open' ? ('open' as const) : ('closed' as const), url: i.url }));
    let local: Candidate[];
    let combine: (remote: Candidate[], settled?: NumberSettled) => Candidate[];
    if (parsed.kind === 'number') {
      const repo = parsed.repo ?? self.repo;
      local = rankByNumber(board(repo), repo, parsed.digits, self);
      // GitHub's copies first: they carry the ids a native relation needs, and their state is fresh; a
      // board copy of what GitHub's answer settled (a closed exact number, the whole repository) goes
      combine = (remote, settled) => rankByNumber(layerRows([{ rows: remote, settled: settled ?? SETTLES_NOTHING }, { rows: local, settled: SETTLES_NOTHING }]), repo, parsed.digits, self);
    } else if (parsed.kind === 'url') {
      local = board(parsed.repo).filter((c) => c.number === parsed.number && c.state === 'open' && refKey(c) !== refKey(self));
      combine = (remote) => remote;
    } else {
      const low = q.toLowerCase();
      local = board(self.repo)
        .filter((c) => c.state === 'open' && c.title.toLowerCase().includes(low))
        .slice(0, 10);
      combine = (remote) => {
        const byKey = new Map<string, Candidate>();
        for (const x of local) byKey.set(refKey(x), x);
        for (const x of remote) byKey.set(refKey(x), x);
        return [...byKey.values()];
      };
    }
    setFound(local);
    setSearching(true);
    const timer = setTimeout(() => {
      void api()
        .blockedSearch(item.key, q)
        .then((r) => {
          if (my !== seq.current) return;
          setSearching(false);
          if (!r.ok) return setSearchErr(r.error);
          // an answer read only in part: what was read is shown next to the reason, never as the whole
          setFound(combine(r.items, r.settled));
          if (r.error) setSearchErr(r.error);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [text, item.key, item.repo, item.number, state.githubWeb]);

  const shown = found.filter((c) => !taken.has(refKey(c)));
  useEffect(() => setSel(0), [text]);

  const add = (c: Candidate) => {
    if (submitting.current) return Promise.resolve(false);
    const run = addOne(c);
    adding.current.add(run);
    void run.finally(() => adding.current.delete(run));
    return run;
  };
  const addOne = async (c: Candidate): Promise<boolean> => {
    if (taken.has(refKey(c))) return true;
    const typed = textRef.current;
    let pick = c;
    // a board copy has no GitHub id: read the item itself (the same read a number search makes)
    if (!pick.id) {
      const r = await api().blockedSearch(item.key, `${c.repo}#${c.number}`);
      // a number search lists the numbers that start with it too: take the one that was clicked (GitHub#448)
      const same = r.ok ? r.items.find((x) => refKey(x) === refKey(c)) : undefined;
      if (!same) {
        setSearchErr(!r.ok ? r.error : r.error ?? t('{ref} 不是开着的', { ref: refName(c, item.repo) }));
        return false;
      }
      pick = same;
    }
    setPicks((p) => (p.some((x) => refKey(x) === refKey(pick)) ? p : [...p, pick]));
    // a read for a board copy may come back after more was typed: what was typed since stays
    if (textRef.current === typed) setText('');
    return true;
  };

  const restoreRefs: Ref[] = view?.ok ? view.lost.filter((r) => restore.has(refKey(r))).map((r) => ({ repo: r.repo, number: r.number })) : [];
  const plan = view?.ok && !view.refuse ? planBlocked({ itemIsPr: view.isPr, selfRepo: item.repo, entry: view.entry, latest: view.latest, native: view.native, picks, restore: restoreRefs }) : null;
  // one rule with the controller: something new, or a registration stopped half way to finish
  const blockWhy = view?.ok && plan ? confirmBlock({ picks: picks.length, restore: restoreRefs.length, current: view.current.length, plan }) : null;
  const lines = plan && !blockWhy ? planLines(plan, item.repo, { human: state.handBack.human, blocked: state.blockedLabels.blocked }) : [];
  const paused = view?.ok && view.entry.kind === 'paused';

  const confirm = async () => {
    if (!view?.ok || busy || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    const done = () => {
      submitting.current = false;
      setBusy(false);
    };
    // GitHub#523: an item picked a moment ago may still be being read (a board copy is read from GitHub before it goes
    // into the list): wait for it and register it too. One that could not be read stops here with its reason shown —
    // registering without it would drop what was just picked. No new read can start meanwhile (`submitting`).
    const pending = [...adding.current];
    if (pending.length > 0 && (await Promise.all(pending)).includes(false)) return done();
    const r = await api().blockedStart({ key: item.key, fingerprint: view.fingerprint, picks: picksRef.current, restore: restoreRefs });
    done();
    if (r.ok) return onClose();
    setWarn(r.error);
    if (r.view) take(r.view);
  };

  return (
    <ConfirmDialog
      title={item.kind === 'pr' ? t('设置 PR #{number} 的前置', { number: item.number }) : t('设置 issue #{number} 的前置', { number: item.number })}
      confirmLabel={t('登记前置')}
      busy={busy}
      dirty={picks.length > 0 || text.trim().length > 0}
      disabled={!view?.ok || Boolean(view.refuse) || !plan || Boolean(blockWhy)}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    >
      <div className="blocked-dialog" data-testid="blocked-dialog">
        <div className="small muted">
          {tNode('前置全部完成（issue 以「已完成」关闭、PR 已合并）后，daemon 把本条翻回「{label}」接着干。', { label: <Verbatim from="user">{state.handBack.agent}</Verbatim> })}
        </div>
        {warn && (
          <div className="warn-text" data-testid="blocked-warn">
            {warn}
          </div>
        )}
        {view === null && <div className="small muted">{t('正在读这一条现在的状态…')}</div>}
        {view && !view.ok && (
          <div className="warn-text" data-testid="blocked-read-error">
            {view.error}
          </div>
        )}
        {view?.ok && (
          <>
            {view.refuse && (
              <div className="warn-text" data-testid="blocked-refuse">
                <SaidText said={view.refuse} />
              </div>
            )}
            {paused && (
              <div className="warn-text" data-testid="blocked-paused">
                {tNode('这一条正暂停在等前置里（同时挂着「{label}」）。确认后会把没做完的补上、恢复等待；已有的前置不用重新选。', { label: <Verbatim from="user">{state.handBack.human}</Verbatim> })}
              </div>
            )}
            <div className="blocked-sec">
              {t('已登记的前置')} <span className="small muted">{t('（刚从 GitHub 读到：最新一份登记 + 侧栏 Blocked by）')}</span>
            </div>
            <div className="chips" data-testid="blocked-current">
              {view.current.length ? view.current.map((r) => <RefChip key={refKey(r)} r={r} selfRepo={item.repo} testid="blocked-current-ref" />) : <span className="small muted">{t('还没有')}</span>}
            </div>
            {view.lost.length > 0 && (
              <>
                <div className="blocked-sec">{t('较早登记里有、最新一份没有')}</div>
                <div className="chips" data-testid="blocked-lost">
                  {view.lost.map((r) => (
                    <label key={refKey(r)} className="chip blocked-chip lost" data-testid="blocked-lost-ref" data-ref={refKey(r)}>
                      <input
                        type="checkbox"
                        checked={restore.has(refKey(r))}
                        disabled={busy}
                        onChange={(e) =>
                          !submitting.current &&
                          setRestore((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(refKey(r));
                            else n.delete(refKey(r));
                            return n;
                          })
                        }
                      />
                      <b>{refName(r, item.repo)}</b>
                      <span className="blocked-title">
                        <Verbatim from="github">{r.title}</Verbatim>
                      </span>
                      <span className="small">{tKey(STATE_TEXT[r.state])}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
            {picks.length > 0 && (
              <>
                <div className="blocked-sec">{t('本次新加')}</div>
                <div className="chips" data-testid="blocked-picks">
                  {picks.map((p) => (
                    <RefChip key={refKey(p)} r={p} selfRepo={item.repo} testid="blocked-pick" fresh locked={busy} onRemove={() => !submitting.current && setPicks((x) => x.filter((y) => refKey(y) !== refKey(p)))} />
                  ))}
                </div>
              </>
            )}
            {!view.refuse && (
              <>
                <input
                  className="blocked-search"
                  data-testid="blocked-search"
                  autoFocus
                  disabled={busy}
                  placeholder={t('输入编号或标题，搜本仓库开着的 issue / PR')}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSel((i) => Math.min(i + 1, Math.max(shown.length - 1, 0)));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSel((i) => Math.max(i - 1, 0));
                    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && shown[sel]) {
                      e.preventDefault();
                      void add(shown[sel]);
                    }
                  }}
                />
                {(shown.length > 0 || searching || searchErr) && (
                  <div className="blocked-results" data-testid="blocked-results">
                    {shown.map((c, i) => (
                      <button key={refKey(c)} className={`blocked-result${i === sel ? ' sel' : ''}`} data-testid="blocked-result" data-ref={refKey(c)} disabled={busy} onMouseEnter={() => setSel(i)} onClick={() => void add(c)}>
                        <b>{refName(c, item.repo)}</b>
                        <span className="blocked-title">
                          <Verbatim from="github">{c.title}</Verbatim>
                        </span>
                      </button>
                    ))}
                    {searching && <div className="small muted">{t('正在搜 GitHub…')}</div>}
                    {searchErr && (
                      <div className="small err" data-testid="blocked-search-err">
                        {searchErr}
                      </div>
                    )}
                  </div>
                )}
                <div className="small muted">
                  {t('输入编号（如 429）直接定位，并列出编号以它开头的开着的条目；也可粘贴 issue / PR 网址；输入文字按标题搜。↑↓ 选，回车加入。别的仓库写成 owner/repo#编号——daemon 只认互通名单里的仓库，名单外的会交人。')}
                </div>
              </>
            )}
            {lines.length > 0 && (
              <div className="blocked-sum" data-testid="blocked-summary">
                <b>{t('确认后会：')}</b>
                <ol>
                  {lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ol>
                <div className="small muted">{t('每一步发出前都会再读一遍；期间有变化就停在那一步，已做的会列出来。')}</div>
              </div>
            )}
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
