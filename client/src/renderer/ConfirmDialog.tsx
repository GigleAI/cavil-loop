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
  useEffect(() => box.current?.focus(), []);
  return (
    <div className="modal-back" data-testid="confirm-dialog" onClick={busy ? undefined : onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={box}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && (e.target as HTMLElement).tagName === 'BUTTON') e.preventDefault();
        }}
      >
        <h3>{title}</h3>
        {children}
        {kept && dirty && (
          <div className="small warn-text" data-testid="dialog-esc-hint">
            有没提交的内容，按 Esc 不会丢掉；点「取消」才会丢掉。
          </div>
        )}
        <div className="row end">
          <button data-testid="confirm-cancel" onClick={onCancel} disabled={busy} title="取消（Esc）">
            取消
          </button>
          <button data-testid="confirm-ok" className={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy || disabled} title={`${confirmLabel}（${keyText('confirm')}）`}>
            {busy ? '正在提交…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
