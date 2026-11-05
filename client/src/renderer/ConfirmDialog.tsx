import type { ReactNode } from 'react';

/** A modal question. Nothing is sent to GitHub until "confirm" is clicked. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  disabled,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-back" data-testid="confirm-dialog" onClick={busy ? undefined : onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
        <div className="row end">
          <button data-testid="confirm-cancel" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button data-testid="confirm-ok" className={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy || disabled}>
            {busy ? '正在提交…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
