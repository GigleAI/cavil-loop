// GitHub#350: the dependency graph view — parents as boxes with their sub-issues inside,
// arrows from each blocker to what it blocks, pan / zoom, "fit" / "the open part", a minimap.
// What goes in is decided in data/graph.ts, where it goes in data/graphLayout.ts; this file
// only draws and handles the pointer.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { badgeText, stateTone } from '../shared/stateTone';
import type { SourceStatus } from '../shared/types';
import { boxProgress, type GraphModel, type GraphNode } from '../data/graph';
import { edgePath, fitView, focusOpen, keepAnchor, layoutGraph, zoomAt, BOX_HEAD, type GraphLayout, type Rect, type Viewport } from '../data/graphLayout';
import { api } from './api';
import { labelStyle } from './colors';
import { Icon, itemIcon } from './Icons';
import { OPENS_ITEM } from './outsideClick';
import { useShortcuts } from './keyboard';
import { keyText } from './shortcuts';

/** what the view showed last, kept for this run only (a restart opens at the default view) */
let memory: { view: Viewport; rects: Map<string, Rect>; structure: string; bigBar: boolean; aspect: number } | null = null;
/** tests: start from scratch */
export function forgetGraphView() {
  memory = null;
}

const ZOOM_STEP = 1.2;

/** "18:26", or "11月9日 18:26" when not today */
export function clockText(ms: number, now: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return new Date(now).toDateString() === d.toDateString() ? t : `${d.getMonth() + 1}月${d.getDate()}日 ${t}`;
}

export interface GraphSourceInfo {
  key: string;
  label: string;
  status: SourceStatus | null;
  /** its relations are unknown (cached before relations were read, no full read since) */
  unknown: boolean;
  /** its items with unknown relations */
  unknownItems: number;
}

interface Props {
  model: GraphModel;
  sources: GraphSourceInfo[];
  syncing: boolean;
  now: number;
  dark: boolean;
  onOpen: (key: string) => void;
}

const nodeTone = (n: GraphNode) => stateTone('issue', n.state, n.stateReason, null);

export function GraphView({ model, sources, syncing, now, dark, onOpen: openNow }: Props) {
  // one function for the whole life of the view, so a node whose look did not change is not redrawn
  const openRef = useRef(openNow);
  openRef.current = openNow;
  const onOpen = useMemo(() => (key: string) => openRef.current(key), []);
  const canvas = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize((s) => (s && s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the layout follows the structure only: a state or label change redraws a node in place
  const latest = useRef(model);
  latest.current = model;
  // the window's shape the first layout used (kept with the view: a remembered view fits only the same layout)
  const aspect = useRef<number | null>(memory?.aspect ?? null);
  if (size && aspect.current === null) aspect.current = size.w / size.h;
  const measured = size !== null;
  const layout = useMemo(() => (measured ? layoutGraph(latest.current, aspect.current!) : null), [model.structure, measured]);

  const [view, setView] = useState<Viewport | null>(memory?.view ?? null);
  const [bigBar, setBigBar] = useState(memory?.bigBar ?? false);
  const shownLayout = useRef<{ rects: Map<string, Rect>; structure: string } | null>(memory ? { rects: memory.rects, structure: memory.structure } : null);
  const isBox = (k: string) => (latest.current.nodes.get(k)?.children.length ?? 0) > 0;
  useLayoutEffect(() => {
    if (!layout || !size) return;
    const prev = shownLayout.current;
    if (!prev || !view) {
      const fit = fitView(layout, size.w, size.h);
      const focus = fit.tooBig ? focusOpen(layout, size.w, size.h) : null;
      setView(focus ?? fit.view);
      setBigBar(focus !== null);
    } else if (prev.structure !== model.structure) {
      const v = keepAnchor(prev.rects, layout.rects, view, size.w, size.h, isBox);
      if (v) setView(v);
    }
    shownLayout.current = { rects: layout.rects, structure: model.structure };
  }, [layout, measured]);
  useEffect(() => {
    if (view && shownLayout.current && aspect.current !== null) memory = { view, rects: shownLayout.current.rects, structure: shownLayout.current.structure, bigBar, aspect: aspect.current };
  }, [view, bigBar, layout]);

  const fit = () => {
    if (!layout || !size) return;
    setView(fitView(layout, size.w, size.h).view);
    setBigBar(false);
  };
  const focus = () => {
    if (!layout || !size) return;
    const v = focusOpen(layout, size.w, size.h);
    if (v) setView(v);
  };
  const zoom = (factor: number) => {
    if (size) setView((v) => v && zoomAt(v, factor, size.w / 2, size.h / 2));
  };
  useShortcuts({ graphFit: fit, graphZoomIn: () => zoom(ZOOM_STEP), graphZoomOut: () => zoom(1 / ZOOM_STEP) });

  // wheel: zoom around the pointer (a native listener: React's is passive and cannot stop the page scrolling)
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest?.('.gpop')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      setView((v) => v && zoomAt(v, Math.exp(-dy * 0.0015), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // drag the background (or a node) to pan; a press that did not move is a click
  const moved = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !view) return;
    if ((e.target as Element).closest('.gpop, .gtools, .gmini, .glegend, .gcounts, .gbar')) return;
    moved.current = false;
    const start = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved.current && Math.hypot(dx, dy) < 4) return;
      moved.current = true;
      setView((v) => v && { ...v, tx: start.tx + dx, ty: start.ty + dy });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const [sel, setSel] = useState<string | null>(null);
  const selected = sel && model.nodes.has(sel) ? model.nodes.get(sel)! : null;
  const pick = useMemo(
    () => (key: string) => {
      if (!moved.current) setSel(key);
    },
    [],
  );

  const repoCount = new Map<string, number>();
  for (const n of model.nodes.values()) repoCount.set(n.repo.toLowerCase(), (repoCount.get(n.repo.toLowerCase()) ?? 0) + 1);
  const home = [...repoCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const refOf = (n: GraphNode) => (n.repo.toLowerCase() === home ? `#${n.number}` : `${n.repo} #${n.number}`);

  const ticked = sources;
  const unknownSources = ticked.filter((s) => s.unknown);
  const allUnknown = model.nodes.size === 0 && unknownSources.length > 0 && model.unknown > 0 && model.entries === 0 && model.noRelation === 0;
  const retry = (
    <button className="small-btn" data-testid="graph-retry" onClick={() => api().restartSync()} disabled={false}>
      重试
    </button>
  );

  const boxes = layout ? [...model.nodes.values()].filter((n) => n.children.length > 0 && layout.rects.has(n.key)) : [];
  const depth = (n: GraphNode) => {
    let d = 0;
    for (let p = n.parent; p !== null && d <= model.nodes.size; p = model.nodes.get(p)!.parent) d++;
    return d;
  };
  boxes.sort((a, b) => depth(a) - depth(b));
  const leaves = layout ? [...model.nodes.values()].filter((n) => n.children.length === 0 && layout.rects.has(n.key)) : [];

  return (
    <div className="graph-page" data-testid="graph">
      {ticked
        .filter((s) => !s.unknown && s.status && !s.status.ok)
        .map((s) => (
          <GraphBar key={s.key} testid="graph-stale" source={s.key}>
            「{s.label}」这一轮读取失败（{s.status!.error ?? '原因不明'}）。
            {s.status!.dataFrom ? (
              <>
                图上是 <b data-testid="graph-stale-time">{clockText(s.status!.dataFrom, now)}</b> 读到的数据，
              </>
            ) : (
              '这个来源还没有读到过数据，'
            )}
            每分钟自动重试。
            {retry}
          </GraphBar>
        ))}
      {unknownSources.map((s) => (
        <GraphBar key={s.key} testid="graph-unknown" source={s.key}>
          <b>「{s.label}」的父子 / 阻塞关系还没有读到过</b>（
          {s.status && !s.status.ok && s.status.error ? `本机缓存是升级前写的，之后的读取失败：${s.status.error}` : syncing ? '本机缓存是升级前写的，正在读取' : '本机缓存是升级前写的，还没有整份读取过'}
          ）。这个来源的 {s.unknownItems} 个条目<b>关系未知</b>，没有画在图上——不代表它们之间没有关系。
          {retry}
        </GraphBar>
      ))}
      <div className="graph-canvas" ref={canvas} data-testid="graph-canvas" onPointerDown={onPointerDown} onClick={(e) => !moved.current && !(e.target as Element).closest('.gpop') && setSel(null)}>
        {allUnknown ? (
          <div className="center muted" data-testid="graph-all-unknown">
            所有来源的父子 / 阻塞关系都还没有读到过，画不出图——这不代表条目之间没有关系。读取成功后会自动画出。
          </div>
        ) : model.nodes.size === 0 ? (
          <div className="center muted" data-testid="graph-empty">
            当前来源和筛选下，没有带父子 / 阻塞关系的 issue。
          </div>
        ) : null}
        {layout && view && model.nodes.size > 0 && (
          <div className="graph-world" data-testid="graph-world" data-scale={view.scale.toFixed(3)} style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}>
            {boxes.map((n) => (
              <BoxView key={n.key} n={n} r={layout.rects.get(n.key)!} dark={dark} progress={boxProgress(model, n.key)} refText={refOf(n)} selected={sel === n.key} onPick={pick} onOpen={onOpen} />
            ))}
            <svg className="graph-edges" width={layout.width} height={layout.height} data-testid="graph-edges">
              <defs>
                <marker id="garrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" className="garrow open" />
                </marker>
                <marker id="garrow-done" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" className="garrow done" />
                </marker>
              </defs>
              {model.edges.map((e) => {
                const a = layout.rects.get(e.from);
                const b = layout.rects.get(e.to);
                if (!a || !b) return null;
                const p = edgePath(a, b, isBox(e.from), isBox(e.to));
                const faded = model.nodes.get(e.from)!.dim || model.nodes.get(e.to)!.dim;
                return (
                  <path
                    key={`${e.from}>${e.to}`}
                    d={p.d}
                    className={`gedge ${e.open ? 'open' : 'done'}${faded ? ' faded' : ''}`}
                    markerEnd={`url(#garrow-${e.open ? 'open' : 'done'})`}
                    data-testid="graph-edge"
                    data-from={e.from}
                    data-to={e.to}
                    data-open={e.open ? 'yes' : 'no'}
                  />
                );
              })}
            </svg>
            {leaves.map((n) => (
              <NodeView key={n.key} n={n} r={layout.rects.get(n.key)!} refText={refOf(n)} dark={dark} selected={sel === n.key} onPick={pick} onOpen={onOpen} />
            ))}
          </div>
        )}
        {layout && view && selected && size && (
          <Summary n={selected} model={model} r={layout.rects.get(selected.key)!} view={view} size={size} refOf={refOf} dark={dark} onOpen={onOpen} onClose={() => setSel(null)} />
        )}
        {model.nodes.size > 0 && (
          <div className="glegend">
            <span className="gleg">
              <svg width="34" height="10" aria-hidden="true">
                <path d="M1,5 H27" className="gedge open" />
                <path d="M26,1 L33,5 L26,9 z" className="garrow open" />
              </svg>
              阻塞者未完成
            </span>
            <span className="gleg">
              <svg width="34" height="10" aria-hidden="true">
                <path d="M1,5 H28" className="gedge done" />
                <path d="M28,2 L33,5 L28,8 z" className="garrow done" />
              </svg>
              阻塞者已完成
            </span>
            <span className="gleg">
              <span className="gleg-box" />框 = 父 issue，框里是它的子 issue
            </span>
          </div>
        )}
        {model.nodes.size > 0 && (
          <div className="gtools">
            <div className="seg">
              <button data-testid="graph-focus" onClick={focus} title="停在有未关闭 issue 的那一组">
                进行中
              </button>
              <button data-testid="graph-fit" onClick={fit} title={`整张图放进窗口（${keyText('graphFit')}）`}>
                适应窗口
              </button>
            </div>
            <div className="seg">
              <button data-testid="graph-zoom-out" aria-label="缩小" title={`缩小（${keyText('graphZoomOut')}）`} onClick={() => zoom(1 / ZOOM_STEP)}>
                −
              </button>
              <span className="gzoom" data-testid="graph-zoom">
                {view ? Math.round(view.scale * 100) : 100}%
              </span>
              <button data-testid="graph-zoom-in" aria-label="放大" title={`放大（${keyText('graphZoomIn')}）`} onClick={() => zoom(ZOOM_STEP)}>
                +
              </button>
            </div>
          </div>
        )}
        {bigBar && view && (
          <div className="gbar" data-testid="graph-big">
            整张图放进窗口后字太小，现在停在进行中的部分（{Math.round(view.scale * 100)}%）。
            <button className="small-btn" data-testid="graph-show-all" onClick={fit}>
              看全图
            </button>
          </div>
        )}
        {(model.noRelation > 0 || model.unknown > 0) && (
          <div className="gcounts" data-testid="graph-counts">
            {model.noRelation > 0 && (
              <span data-testid="graph-hidden">另有 {model.noRelation} 个条目没有父子 / 阻塞关系，未显示（在看板 / 表格里看）</span>
            )}
            {model.noRelation > 0 && model.unknown > 0 && ' · '}
            {model.unknown > 0 && (
              <b className="gunknown" data-testid="graph-unknown-count">
                {model.unknown} 个条目关系未知
              </b>
            )}
          </div>
        )}
        {layout && view && size && model.nodes.size > 0 && <Minimap layout={layout} model={model} view={view} size={size} setView={setView} />}
      </div>
    </div>
  );
}

function GraphBar({ testid, source, children }: { testid: string; source: string; children: ReactNode }) {
  return (
    <div className="banner error graph-banner" data-testid={testid} data-source={source}>
      <Icon name="warn" />
      <span className="banner-text">{children}</span>
    </div>
  );
}

function StateMark({ n }: { n: GraphNode }) {
  const tone = nodeTone(n);
  return (
    <span className={`kind issue ${tone}`} data-testid="graph-node-state" data-tone={tone}>
      <Icon name={itemIcon('issue', n.state, n.stateReason)} size={14} />
      Issue · {badgeText('issue', n.state, n.stateReason, null)}
    </span>
  );
}

function Badges({ n }: { n: GraphNode }) {
  return (
    <>
      {n.blockedByOpen > 0 && (
        <span className="gbadge blocked" data-testid="graph-blocked-by">
          被 {n.blockedByOpen} 项挡住
        </span>
      )}
      {n.blockingAhead > 0 && (
        <span className="gbadge ahead" data-testid="graph-blocking-ahead">
          挡住后面 {n.blockingAhead} 项
        </span>
      )}
    </>
  );
}

const OUTSIDE = (
  <span className="gtag" data-testid="graph-outside">
    不在当前来源中
  </span>
);

interface NodeProps {
  n: GraphNode;
  r: Rect;
  refText: string;
  selected: boolean;
  onPick: (key: string) => void;
  onOpen: (key: string) => void;
}

const place = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });
const nodeAttrs = (n: GraphNode, selected: boolean, onPick: (k: string) => void, onOpen: (k: string) => void) => ({
  'data-testid': 'graph-node',
  'data-key': n.key,
  'data-dim': n.dim ? 'yes' : 'no',
  'data-outside': n.item ? 'no' : 'yes',
  'data-selected': selected ? 'yes' : 'no',
  [OPENS_ITEM]: '',
  onClick: (e: React.MouseEvent) => {
    e.stopPropagation();
    onPick(n.key);
  },
  onDoubleClick: (e: React.MouseEvent) => {
    e.stopPropagation();
    if (n.item) onOpen(n.key);
  },
});

/** One node; redrawn only when what it shows changed (`look`), its place or its selection. */
const NodeView = memo(
  function NodeView({ n, r, refText, dark, selected, onPick, onOpen }: NodeProps & { dark: boolean }) {
    return (
      <div className={`gnode${n.dim ? ' dim' : ''}${n.item ? '' : ' outside'}${selected ? ' selected' : ''}`} style={place(r)} {...nodeAttrs(n, selected, onPick, onOpen)}>
        <div className="gnode-head">
          <StateMark n={n} />
          <span className="ref" title={`${n.repo} #${n.number}`}>
            {refText}
          </span>
          <span className="spacer" />
          <Badges n={n} />
        </div>
        <div className="gnode-title" title={n.title} data-testid="graph-node-title">
          {n.title}
        </div>
        <div className="labels gnode-labels">
          {n.item?.labels.map((l) => (
            <span key={l.name} className="label" style={labelStyle(l.color, dark)}>
              {l.name}
            </span>
          ))}
          {!n.item && OUTSIDE}
        </div>
      </div>
    );
  },
  (a, b) => a.n.look === b.n.look && a.n.key === b.n.key && sameRect(a.r, b.r) && a.refText === b.refText && a.dark === b.dark && a.selected === b.selected && a.onOpen === b.onOpen,
);

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const BoxView = memo(
  function BoxView({ n, r, refText, progress, dark, selected, onPick, onOpen }: NodeProps & { dark: boolean; progress: { completed: number; total: number } | null }) {
    return (
      <div className={`gbox${n.dim ? ' dim' : ''}${n.item ? '' : ' outside'}`} style={place(r)} data-testid="graph-box" data-key={n.key}>
        <div className={`gbox-head${selected ? ' selected' : ''}`} style={{ height: BOX_HEAD }} {...nodeAttrs(n, selected, onPick, onOpen)}>
          <div className="gbox-row">
          <StateMark n={n} />
          <span className="ref" title={`${n.repo} #${n.number}`}>
            {refText}
          </span>
          <span className="gbox-title" title={n.title} data-testid="graph-node-title">
            {n.title}
          </span>
          <span className="spacer" />
          <Badges n={n} />
          {progress && (
            <span className="gprogress" data-testid="graph-box-progress">
              {progress.completed} / {progress.total} 子项完成
            </span>
          )}
          </div>
          {/* the same labels row as a plain node: a parent's flow label is on the graph, not only in its summary */}
          <div className="labels gnode-labels">
            {n.item?.labels.map((l) => (
              <span key={l.name} className="label" style={labelStyle(l.color, dark)}>
                {l.name}
              </span>
            ))}
            {!n.item && OUTSIDE}
          </div>
        </div>
      </div>
    );
  },
  (a, b) => a.n.look === b.n.look && a.n.key === b.n.key && sameRect(a.r, b.r) && a.refText === b.refText && a.dark === b.dark && a.selected === b.selected && a.progress?.completed === b.progress?.completed && a.progress?.total === b.progress?.total && a.onOpen === b.onOpen,
);

function Summary({
  n,
  model,
  r,
  view,
  size,
  refOf,
  dark,
  onOpen,
  onClose,
}: {
  n: GraphNode;
  model: GraphModel;
  r: Rect;
  view: Viewport;
  size: { w: number; h: number };
  refOf: (n: GraphNode) => string;
  dark: boolean;
  onOpen: (key: string) => void;
  onClose: () => void;
}) {
  const W = 300;
  const right = (r.x + r.w) * view.scale + view.tx + 10;
  const left = r.x * view.scale + view.tx - W - 10;
  const x = right + W <= size.w || left < 0 ? Math.max(8, Math.min(right, size.w - W - 8)) : left;
  // its real height (GitHub#350 review round 1): it is moved up as far as it needs to stay whole in the
  // canvas; taller than the canvas, it is capped (CSS) and its middle scrolls, the buttons stay in view
  const pop = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = pop.current;
    if (!el) return;
    const measure = () => setH(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n.key]);
  // and below the legend / zoom row, which stays on top (its buttons must stay reachable while a summary is open)
  const TOP_ROW = 48;
  const maxH = Math.max(120, size.h - TOP_ROW - 8);
  const y = Math.max(Math.min(TOP_ROW, size.h - maxH - 8), Math.min(r.y * view.scale + view.ty, size.h - Math.min(h, maxH) - 8));
  const blockers = model.edges.filter((e) => e.to === n.key).map((e) => ({ n: model.nodes.get(e.from)!, open: e.open }));
  const blocked = model.edges.filter((e) => e.from === n.key).map((e) => model.nodes.get(e.to)!);
  const parent = n.parent ? model.nodes.get(n.parent)! : (n.item?.relations?.parent ?? null);
  const line = (x: { repo: string; number: number; title: string }) => `${refOf(x as GraphNode)} ${x.title}`;
  return (
    <div className="gpop" ref={pop} data-testid="graph-summary" data-key={n.key} style={{ left: x, top: y, width: W, maxHeight: maxH }} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="gpop-head">
        <StateMark n={n} />
        <span className="ref">
          {n.repo} #{n.number}
        </span>
        <span className="spacer" />
        <button className="banner-close" aria-label="关闭摘要" data-testid="graph-summary-close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="gpop-body" data-testid="graph-summary-body">
      <div className="gpop-title" data-testid="graph-summary-title">
        {n.title}
      </div>
      {n.item && n.item.labels.length > 0 && (
        <div className="labels">
          {n.item.labels.map((l) => (
            <span key={l.name} className="label" style={labelStyle(l.color, dark)}>
              {l.name}
            </span>
          ))}
        </div>
      )}
      {!n.item && <div className="small muted gpop-outside">{OUTSIDE} GitHub 读关系时顺带给的基本信息；这个仓库没有添加为来源，没有读它的标签和详情。</div>}
      {n.item && (
        <>
          {blockers.length > 0 && (
            <div className="gpop-sec" data-testid="graph-summary-blockers">
              <div className="muted small">被挡住</div>
              {blockers.map((b) => (
                <div key={b.n.key} className="gpop-rel">
                  <span className={`gdot ${b.open ? 'open' : 'done'}`} />
                  {line(b.n)}（{b.open ? '未完成' : '已完成'}）
                </div>
              ))}
            </div>
          )}
          {blocked.length > 0 && (
            <div className="gpop-sec" data-testid="graph-summary-blocking">
              <div className="muted small">挡住</div>
              {blocked.map((b) => (
                <div key={b.key} className="gpop-rel">
                  {line(b)}
                </div>
              ))}
            </div>
          )}
          {parent && (
            <div className="gpop-sec" data-testid="graph-summary-parent">
              <div className="muted small">父 issue</div>
              <div className="gpop-rel">{line(parent)}</div>
            </div>
          )}
        </>
      )}
      </div>
      <div className="row gpop-actions">
        {n.item && (
          <button className="primary" data-testid="graph-summary-open" {...{ [OPENS_ITEM]: '' }} onClick={() => onOpen(n.key)}>
            打开详情
          </button>
        )}
        <button data-testid="graph-summary-web" onClick={() => void api().openExternal(n.url)}>
          在 GitHub 打开
        </button>
      </div>
      {n.item && <div className="small muted">双击节点也可直接打开详情</div>}
    </div>
  );
}

const MINI_W = 168;
const MINI_H = 100;

function Minimap({ layout, model, view, size, setView }: { layout: GraphLayout; model: GraphModel; view: Viewport; size: { w: number; h: number }; setView: (v: Viewport) => void }) {
  const k = Math.min(MINI_W / layout.width, MINI_H / layout.height);
  const w = layout.width * k;
  const h = layout.height * k;
  const vis = { x: (-view.tx / view.scale) * k, y: (-view.ty / view.scale) * k, w: (size.w / view.scale) * k, h: (size.h / view.scale) * k };
  const ref = useRef<SVGSVGElement>(null);
  const centreOn = (clientX: number, clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    const wx = (clientX - r.left) / k;
    const wy = (clientY - r.top) / k;
    setView({ ...view, tx: size.w / 2 - wx * view.scale, ty: size.h / 2 - wy * view.scale });
  };
  const latest = useRef(centreOn);
  latest.current = centreOn;
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    latest.current(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => latest.current(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="gmini" data-testid="graph-minimap">
      <svg ref={ref} width={w} height={h} onPointerDown={onDown}>
        {[...layout.rects].map(([key, r]) => {
          const n = model.nodes.get(key)!;
          return (
            <rect
              key={key}
              x={r.x * k}
              y={r.y * k}
              width={Math.max(1, r.w * k)}
              height={Math.max(1, r.h * k)}
              className={`gmini-node ${nodeTone(n)}${n.children.length ? ' box' : ''}`}
            />
          );
        })}
        <rect x={vis.x} y={vis.y} width={vis.w} height={vis.h} className="gmini-view" data-testid="graph-minimap-view" />
      </svg>
    </div>
  );
}
