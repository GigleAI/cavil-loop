// GitHub#514: the longer explanation of a Settings card, folded under one line at the bottom of the card.
// The card itself keeps one short line; the full rules stay here word for word, one click away.

import type { ReactNode } from 'react';

export function SettingsMore({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <details className="set-more" data-testid={testid ?? 'set-more'}>
      <summary className="muted small">{title}</summary>
      <div className="set-more-body muted small">{children}</div>
    </details>
  );
}
