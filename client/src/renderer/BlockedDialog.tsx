// GitHub#434: "等前置…" — pick what the item waits for (search the item's repository by number or
// title), then register it the way the daemon reads it. The dialog only shows and picks: what is
// read, what is written and every check before a write are the controller's (blockedRead /
// blockedSearch / blockedStart), the rules shared/blocked.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { confirmBlock, planBlocked, planLines, refKey, type Pick, type Ref } from '../shared/blocked';
import type { BlockedRefInfo, BlockedView } from '../shared/ipc';
import type { AppState, Item } from '../shared/types';

type Candidate = BlockedRefInfo & Pick;

const STATE_TEXT: Record<BlockedRefInfo['state'], string> = { open: '开', closed: '已关闭', merged: '已合并', unknown: '读不到状态' };

function refName(r: { repo: string; number: number; kind?: string | null }, selfRepo: string): string {
  const n = r.repo === selfRepo.toLowerCase() ? `#${r.number}` : `${r.repo}#${r.number}`;
  return r.kind === 'pr' ? `PR ${n}` : n;
}

function RefChip({ r, selfRepo, testid, onRemove, fresh }: { r: BlockedRefInfo; selfRepo: string; testid: string; onRemove?: () => void; fresh?: boolean }) {
  return (
    <span className={`chip blocked-chip${fresh ? ' new' : ''}`} data-testid={testid} data-ref={refKey(r)}>
      <b>{refName(r, selfRepo)}</b>
      <span className="blocked-title">{r.title}</span>
      <span className={`small ${r.state === 'open' ? '' : 'muted'}`}>{STATE_TEXT[r.state]}</span>
      {onRemove && (
        <button className="link" aria-label="去掉" data-testid="blocked-pick-remove" onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  );
}

export function BlockedDialog({ item, state, items, onClose }: { item: Item; state: AppState; items: Item[]; onClose: () => void }) {
  const [view, setView] = useState<BlockedView | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [picks, setPicks] = useState<Candidate[]>([]);
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

  // the search: what the board already holds first (titles), then GitHub (after a pause in typing)
  useEffect(() => {
    const q = text.trim();
    const my = ++seq.current;
    setSearchErr(null);
    if (!q) {
      setFound([]);
      setSearching(false);
      return;
    }
    const low = q.toLowerCase();
    const local: Candidate[] = /^\d+$/.test(q)
      ? []
      : itemsRef.current
          .filter((i) => i.repo.toLowerCase() === item.repo.toLowerCase() && i.state === 'open' && i.title.toLowerCase().includes(low))
          .slice(0, 10)
          .map((i) => ({ repo: i.repo.toLowerCase(), number: i.number, kind: i.kind, id: 0, title: i.title, state: 'open' as const, url: i.url }));
    setFound(local);
    setSearching(true);
    const t = setTimeout(() => {
      void api()
        .blockedSearch(item.key, q)
        .then((r) => {
          if (my !== seq.current) return;
          setSearching(false);
          if (!r.ok) return setSearchErr(r.error);
          // GitHub's answer carries the ids a native relation needs: it replaces the board's copy
          const byKey = new Map<string, Candidate>();
          for (const x of local) byKey.set(refKey(x), x);
          for (const x of r.items) byKey.set(refKey(x), x);
          setFound([...byKey.values()]);
        });
    }, 300);
    return () => clearTimeout(t);
  }, [text, item.key, item.repo]);

  const shown = found.filter((c) => !taken.has(refKey(c)));
  useEffect(() => setSel(0), [text]);

  const add = async (c: Candidate) => {
    if (taken.has(refKey(c))) return;
    const typed = textRef.current;
    let pick = c;
    // a board copy has no GitHub id: read the item itself (the same read a number search makes)
    if (!pick.id) {
      const r = await api().blockedSearch(item.key, `${c.repo}#${c.number}`);
      if (!r.ok || !r.items.length) return setSearchErr(r.ok ? `${refName(c, item.repo)} 不是开着的` : r.error);
      pick = r.items[0];
    }
    setPicks((p) => (p.some((x) => refKey(x) === refKey(pick)) ? p : [...p, pick]));
    // a read for a board copy may come back after more was typed: what was typed since stays
    if (textRef.current === typed) setText('');
  };

  const restoreRefs: Ref[] = view?.ok ? view.lost.filter((r) => restore.has(refKey(r))).map((r) => ({ repo: r.repo, number: r.number })) : [];
  const plan = view?.ok && !view.refuse ? planBlocked({ itemIsPr: view.isPr, selfRepo: item.repo, entry: view.entry, latest: view.latest, native: view.native, picks, restore: restoreRefs }) : null;
  // one rule with the controller: something new, or a registration stopped half way to finish
  const blockWhy = view?.ok && plan ? confirmBlock({ picks: picks.length, restore: restoreRefs.length, current: view.current.length, plan }) : null;
  const lines = plan && !blockWhy ? planLines(plan, item.repo, { human: state.handBack.human, blocked: state.blockedLabels.blocked }) : [];
  const paused = view?.ok && view.entry.kind === 'paused';

  const confirm = async () => {
    if (!view?.ok || busy) return;
    setBusy(true);
    const r = await api().blockedStart({ key: item.key, fingerprint: view.fingerprint, picks, restore: restoreRefs });
    setBusy(false);
    if (r.ok) return onClose();
    setWarn(r.error);
    if (r.view) take(r.view);
  };

  return (
    <ConfirmDialog
      title={`设置 ${item.kind === 'pr' ? 'PR' : 'issue'} #${item.number} 的前置`}
      confirmLabel="登记前置"
      busy={busy}
      dirty={picks.length > 0 || text.trim().length > 0}
      disabled={!view?.ok || Boolean(view.refuse) || !plan || Boolean(blockWhy)}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    >
      <div className="blocked-dialog" data-testid="blocked-dialog">
        <div className="small muted">前置全部完成（issue 以「已完成」关闭、PR 已合并）后，daemon 把本条翻回「{state.handBack.agent}」接着干。</div>
        {warn && (
          <div className="warn-text" data-testid="blocked-warn">
            {warn}
          </div>
        )}
        {view === null && <div className="small muted">正在读这一条现在的状态…</div>}
        {view && !view.ok && (
          <div className="warn-text" data-testid="blocked-read-error">
            {view.error}
          </div>
        )}
        {view?.ok && (
          <>
            {view.refuse && (
              <div className="warn-text" data-testid="blocked-refuse">
                {view.refuse}
              </div>
            )}
            {paused && (
              <div className="warn-text" data-testid="blocked-paused">
                这一条正暂停在等前置里（同时挂着「{state.handBack.human}」）。确认后会把没做完的补上、恢复等待；已有的前置不用重新选。
              </div>
            )}
            <div className="blocked-sec">
              已登记的前置 <span className="small muted">（刚从 GitHub 读到：最新一份登记 + 侧栏 Blocked by）</span>
            </div>
            <div className="chips" data-testid="blocked-current">
              {view.current.length ? view.current.map((r) => <RefChip key={refKey(r)} r={r} selfRepo={item.repo} testid="blocked-current-ref" />) : <span className="small muted">还没有</span>}
            </div>
            {view.lost.length > 0 && (
              <>
                <div className="blocked-sec">较早登记里有、最新一份没有</div>
                <div className="chips" data-testid="blocked-lost">
                  {view.lost.map((r) => (
                    <label key={refKey(r)} className="chip blocked-chip lost" data-testid="blocked-lost-ref" data-ref={refKey(r)}>
                      <input
                        type="checkbox"
                        checked={restore.has(refKey(r))}
                        onChange={(e) =>
                          setRestore((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(refKey(r));
                            else n.delete(refKey(r));
                            return n;
                          })
                        }
                      />
                      <b>{refName(r, item.repo)}</b>
                      <span className="blocked-title">{r.title}</span>
                      <span className="small">{STATE_TEXT[r.state]}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
            {picks.length > 0 && (
              <>
                <div className="blocked-sec">本次新加</div>
                <div className="chips" data-testid="blocked-picks">
                  {picks.map((p) => (
                    <RefChip key={refKey(p)} r={p} selfRepo={item.repo} testid="blocked-pick" fresh onRemove={() => setPicks((x) => x.filter((y) => refKey(y) !== refKey(p)))} />
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
                  placeholder="输入编号或标题，搜本仓库开着的 issue / PR"
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
                      <button key={refKey(c)} className={`blocked-result${i === sel ? ' sel' : ''}`} data-testid="blocked-result" data-ref={refKey(c)} onMouseEnter={() => setSel(i)} onClick={() => void add(c)}>
                        <b>{refName(c, item.repo)}</b>
                        <span className="blocked-title">{c.title}</span>
                      </button>
                    ))}
                    {searching && <div className="small muted">正在搜 GitHub…</div>}
                    {searchErr && <div className="small err">{searchErr}</div>}
                  </div>
                )}
                <div className="small muted">输入编号（如 429）直接定位；输入文字按标题搜。↑↓ 选，回车加入。别的仓库写成 owner/repo#编号——daemon 只认互通名单里的仓库，名单外的会交人。</div>
              </>
            )}
            {lines.length > 0 && (
              <div className="blocked-sum" data-testid="blocked-summary">
                <b>确认后会：</b>
                <ol>
                  {lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ol>
                <div className="small muted">每一步发出前都会再读一遍；期间有变化就停在那一步，已做的会列出来。</div>
              </div>
            )}
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
