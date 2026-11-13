// GitHub#490: the way out a notice offers that leads to GitHub's page, shared by an operation's and a
// send's notice. Which one is shown (and whether at all) is decided by the shared rules
// (shared/ops.ts: opActions, shared/sends.ts: sendActions); this only carries it out and says what
// did not work next to the button.
//   - 「到 GitHub 上处理」: copies the kept text (if any) and opens the item's page. Unlocks nothing.
//   - 「到 GitHub 上核对」, two steps in one place: the first press copies the kept text and opens the
//     page (a page that did not open stays on the first step, with the reason); once it opened, the same
//     place says 「已在 GitHub 上核对过，解除锁定」 and only that press unlocks (local only, nothing is sent).
// A copy that failed says so: the text is still shown in the notice and the record keeps it.

import { useState } from 'react';
import { api } from './api';
import { t } from '../shared/i18n';
import { copyText } from './pasteImage';

export function itemPageUrl(repo: string, number: number): string {
  // GitHub sends /issues/N of a PR on to the PR itself
  return `https://github.com/${repo}/issues/${number}`;
}

/** copy (when there is a text), then open the page */
async function copyAndOpen(copy: string | null, url: string): Promise<{ opened: boolean; copyFailed: boolean; openError: string | null }> {
  const copyFailed = copy !== null && !(await copyText(copy));
  try {
    await api().openExternal(url);
    return { opened: true, copyFailed, openError: null };
  } catch (e) {
    return { opened: false, copyFailed, openError: (e as Error)?.message ?? String(e) };
  }
}

export function WebButton({
  kind,
  url,
  copy,
  webOpened,
  onOpened,
  onUnlock,
  testid,
}: {
  kind: 'handleWeb' | 'checkWeb';
  url: string;
  /** the text the press copies first (null = nothing to copy) */
  copy: string | null;
  /** checkWeb: the page was opened before (the second step shows) */
  webOpened: boolean;
  onOpened: () => void;
  onUnlock: () => void;
  testid: string;
}) {
  const [result, setResult] = useState<{ copied: boolean; copyFailed: boolean; openError: string | null } | null>(null);
  const press = async () => {
    setResult(null);
    const out = await copyAndOpen(copy, url);
    setResult({ copied: copy !== null && !out.copyFailed, copyFailed: out.copyFailed, openError: out.openError });
    if (out.opened && kind === 'checkWeb') onOpened();
  };
  const step = kind === 'checkWeb' && webOpened ? 'confirm' : 'open';
  const problems = [
    ...(result?.copyFailed ? [t('复制失败，原文仍在这里')] : []),
    ...(result?.openError ? [t('没能打开 GitHub 页面：{reason}', { reason: result.openError })] : []),
  ];
  return (
    <>
      {step === 'confirm' ? (
        <button className="link" data-testid={testid} data-step="confirm" title={t('只解开这里的锁定，不会往 GitHub 发任何请求')} onClick={onUnlock}>
          {t('已在 GitHub 上核对过，解除锁定')}
        </button>
      ) : (
        <button
          className="link"
          data-testid={testid}
          data-step="open"
          title={copy !== null ? t('先把原文复制到剪贴板，再打开这一条的 GitHub 页面') : t('打开这一条的 GitHub 页面')}
          onClick={() => void press()}
        >
          {kind === 'checkWeb' ? t('到 GitHub 上核对') : t('到 GitHub 上处理')}
        </button>
      )}
      {result?.copied && (
        <span className="small muted" data-testid={`${testid}-copied`}>
          {' '}
          {t('原文已复制')}
        </span>
      )}
      {problems.length > 0 && (
        <span className="small err" data-testid={`${testid}-problem`}>
          {' '}
          {problems.join(t('；'))}
        </span>
      )}
    </>
  );
}
