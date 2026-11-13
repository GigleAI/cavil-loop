// The label / milestone picker (GitHub#192): type to filter, ↑↓ to choose, Enter to add or remove
// the chosen one, Esc to put it away. Every Enter (or click) is one change, sent at once through the
// panel's own add / remove (never "write the whole list": that would wipe a label someone else just
// added). While a change is being sent, or offline, the list is greyed and Enter does nothing.
// GitHub#496: what the item carried when the picker opened is listed first, then the `pinned` labels;
// the order is fixed while it is open (a click only moves the tick), see shared/pickOrder.ts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { pickOrder } from '../shared/pickOrder';
import { useLayer, useShortcuts } from './keyboard';

export type PickItem = { name: string; color?: string; checked: boolean };

export function LabelPicker({
  title,
  hint,
  items,
  disabled,
  testid,
  pinned,
  onToggle,
  onClose,
}: {
  title: string;
  hint?: string;
  items: PickItem[];
  /** sending, or offline: nothing can be changed right now */
  disabled: boolean;
  testid: string;
  /** names kept near the top, right after what is checked (GitHub#496); missing from `items` = not listed */
  pinned?: readonly string[];
  onToggle: (item: PickItem) => void;
  onClose: () => void;
}) {
  useLayer('picker');
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  // taken once, when the picker opens: a click while it is open must not move rows (GitHub#496)
  const [checkedAtOpen] = useState(() => new Set(items.filter((i) => i.checked).map((i) => i.name)));
  const ordered = useMemo(() => pickOrder(items, checkedAtOpen, pinned), [items, checkedAtOpen, pinned]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? ordered.filter((i) => i.name.toLowerCase().includes(f)) : ordered;
  }, [ordered, filter]);
  const at = Math.min(active, Math.max(0, shown.length - 1));
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);
  // a click anywhere outside puts it away (the click itself still does its own thing)
  useEffect(() => {
    const out = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', out);
    return () => document.removeEventListener('mousedown', out);
  }, [onClose]);
  useEffect(() => {
    box.current?.querySelector('[data-active="yes"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [at]);
  const toggle = (i: PickItem | undefined) => {
    if (i && !disabled) onToggle(i);
  };
  useShortcuts({
    pickerUp: () => setActive(Math.max(0, at - 1)),
    pickerDown: () => setActive(Math.min(shown.length - 1, at + 1)),
    pickerToggle: () => toggle(shown[at]),
    pickerClose: onClose,
  });
  return (
    <div className="picker" data-testid={testid} data-disabled={disabled ? 'yes' : 'no'} ref={box}>
      <div className="picker-head">
        {title}
        {hint && <span className="muted small">{hint}</span>}
      </div>
      <input
        ref={input}
        data-testid="picker-filter"
        value={filter}
        placeholder="筛选"
        onChange={(e) => {
          setFilter(e.target.value);
          setActive(0);
        }}
      />
      <ul aria-disabled={disabled}>
        {shown.map((i, n) => (
          <li
            key={i.name}
            data-testid="picker-item"
            data-name={i.name}
            data-checked={i.checked ? 'yes' : 'no'}
            data-active={n === at ? 'yes' : 'no'}
            className={`${n === at ? 'active' : ''}${disabled ? ' disabled' : ''}`}
            onMouseEnter={() => setActive(n)}
            onClick={() => toggle(i)}
          >
            <span className="chk">{i.checked ? '✓' : ''}</span>
            {i.color !== undefined && <span className="dot" style={{ background: `#${i.color || 'ddd'}` }} />}
            {i.name}
          </li>
        ))}
        {shown.length === 0 && <li className="muted">没有匹配的</li>}
      </ul>
      <div className="picker-foot small muted">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> 选择
        </span>
        <span>
          <kbd>↩</kbd> 加上 / 去掉
        </span>
        <span>
          <kbd>Esc</kbd> 收起
        </span>
      </div>
    </div>
  );
}
