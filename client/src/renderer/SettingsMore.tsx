// GitHub#514: the longer explanation of a Settings card, folded under one line at the bottom of the card.
// The card itself keeps one short line; the full rules stay here word for word, one click away.

import { useState, type ReactNode } from 'react';
import { Icon } from './Icons';
import { t } from '../shared/i18n';

export function SettingsMore({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <details className="set-more" data-testid={testid ?? 'set-more'}>
      <summary className="muted small">{title}</summary>
      <div className="set-more-body muted small">{children}</div>
    </details>
  );
}

/**
 * GitHub#591: a card's less used options, under one 「高级」 line inside the card. Folded each time Settings opens;
 * `held` keeps it open (and says why) while something in it needs to be seen — a failed check, a Client ID that
 * does not fit — so a fold never hides a problem.
 */
export function CardMore({ what, held, testid, children }: { what: ReactNode; held?: ReactNode; testid: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const shown = open || !!held;
  return (
    <div className="card-more" data-testid={testid} data-open={String(shown)}>
      <button type="button" className="fold-toggle" aria-expanded={shown} data-testid={`${testid}-toggle`} onClick={() => !held && setOpen(!open)}>
        <Icon name="chevron" size={14} />
        <b>{t('高级')}</b>
        <span>{what}</span>
        {held && <span data-testid={`${testid}-held`}>{held}</span>}
      </button>
      {shown && <div className="card-more-body">{children}</div>}
    </div>
  );
}
