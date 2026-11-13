import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLayer, useShortcuts } from './keyboard';
import { keyText } from './shortcuts';

/**
 * A modal question. Nothing is sent to GitHub until "confirm" is clicked (or ⌘↩, which clicks it).
 * Esc cancels — except while `dirty`: a typed-in text is never dropped by a key (GitHub#192).
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  disabled,
  dirty,
  actions,
  footnote,
  confirmKey,
  wide,
  covered,
  focusCancel,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
  /** has text the user typed that "cancel" would throw away */
  dirty?: boolean;
  /**
   * GitHub#450: more buttons in the action row, left of the confirm button (the new-issue dialog's
   * 交给 agent / 托管). Given, the row is laid out like the detail panel's: 取消 on the left, the rest on the right.
   */
  actions?: ReactNode;
  /** a line under the action row (why one of `actions` is greyed) */
  footnote?: ReactNode;
  /** the confirm button carries its key (⌘↩), the way the detail panel's buttons do */
  confirmKey?: boolean;
  /** a wider dialog (GitHub#450: four buttons in one row) */
  wide?: boolean;
  /**
   * GitHub#450 (PR #459 review round 1): another dialog is open on top of this one. This one is then
   * `inert` — nothing in it can take the focus or a click — so Tab / Shift+Tab cannot reach a covered button.
   */
  covered?: boolean;
  /** the keyboard starts on 取消 instead of the dialog itself (GitHub#450: the autopilot confirmation over a new issue) */
  focusCancel?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useLayer('dialog');
  const [kept, setKept] = useState(false);
  useEffect(() => {
    if (!dirty) setKept(false);
  }, [dirty]);
  useShortcuts({
    confirm: () => {
      if (!busy && !disabled) onConfirm();
    },
    cancel: () => {
      if (busy) return;
      if (dirty) return setKept(true);
      onCancel();
    },
  });
  // The keyboard moves into the dialog: a stray Enter then reaches nothing behind it. A plain Enter
  // on one of the dialog's buttons does nothing either — only a click or ⌘↩ confirms (GitHub#192).
  const box = useRef<HTMLDivElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => (focusCancel ? cancelBtn.current : box.current)?.focus(), []);
  return (
    <div className="modal-back" data-testid="confirm-dialog" data-covered={covered ? 'yes' : undefined} inert={covered || undefined} onClick={busy ? undefined : onCancel}>
      <div
        className={wide ? 'modal wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={box}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && (e.target as HTMLElement).tagName === 'BUTTON') e.preventDefault();
          // GitHub#450 (PR #459 review round 1): Tab / Shift+Tab go round inside the dialog, never out of it
          if (e.key === 'Tab' && box.current) trapTab(e, box.current);
        }}
      >
        <h3>{title}</h3>
        {children}
        {kept && dirty && (
          <div className="small warn-text" data-testid="dialog-esc-hint">
            有没提交的内容，按 Esc 不会丢掉；点「取消」才会丢掉。
          </div>
        )}
        <div className={actions ? 'row dialog-actions' : 'row end'}>
          <button data-testid="confirm-cancel" ref={cancelBtn} onClick={onCancel} disabled={busy} title="取消（Esc）">
            取消
          </button>
          {actions && <div className="spacer" />}
          {actions}
          <button data-testid="confirm-ok" className={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy || disabled} title={`${confirmLabel}（${keyText('confirm')}）`}>
            {busy ? '正在提交…' : confirmLabel}
            {confirmKey && !busy && <kbd>{keyText('confirm')}</kbd>}
          </button>
        </div>
        {footnote}
      </div>
    </div>
  );
}

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';

/** Keep Tab / Shift+Tab inside `box`: from its last control to its first and back (the dialog itself counts as before the first). */
function trapTab(e: { shiftKey: boolean; preventDefault: () => void }, box: HTMLElement): void {
  const list = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
  const now = document.activeElement;
  if (!list.length) return e.preventDefault();
  const first = list[0];
  const last = list[list.length - 1];
  const at = list.indexOf(now as HTMLElement);
  if (e.shiftKey && (at <= 0)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (at === -1 ? now !== box : at === list.length - 1)) {
    e.preventDefault();
    first.focus();
  }
}
