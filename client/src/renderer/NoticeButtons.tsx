// GitHub#490: the way out a notice offers that leads to GitHub's page, shared by an operation's and a
// send's notice. Which one is shown (and whether at all) is decided by the shared rules
// (shared/ops.ts: opActions, shared/sends.ts: sendActions); this only carries it out and says what
// did not work next to the button.
//   - 「到 GitHub 上处理」: copies the kept text (if any) and opens the item's page. Unlocks nothing.
//   - 「到 GitHub 上核对」, two steps in one place: the first press copies the kept text and opens the
//     page (a page that did not open stays on the first step, with the reason); once it opened, the same
//     place says 「已在 GitHub 上核对过，解除锁定」 and only that press unlocks (local only, nothing is sent).
// A copy that failed says 「复制失败」: the text is still shown in the notice and the record keeps it.

import { useState } from 'react';
import { api } from './api';
import { copyText } from './pasteImage';

export function itemPageUrl(repo: string, number: number): string {
  // GitHub sends /issues/N of a PR on to the PR itself
  return `https://github.com/${repo}/issues/${number}`;
}

/** copy (when there is a text), then open the page; what failed, in words (null = both worked) */
async function copyAndOpen(copy: string | null, url: string): Promise<{ opened: boolean; problem: string | null }> {
  const problems: string[] = [];
  if (copy !== null && !(await copyText(copy))) problems.push('复制失败，原文仍在这里');
  let opened = true;
  try {
    await api().openExternal(url);
  } catch (e) {
    opened = false;
    problems.push(`没能打开 GitHub 页面：${(e as Error)?.message ?? String(e)}`);
  }
  return { opened, problem: problems.length ? problems.join('；') : null };
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
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const press = async () => {
    setProblem(null);
    const out = await copyAndOpen(copy, url);
    setProblem(out.problem);
    setCopied(copy !== null && out.problem?.startsWith('复制失败') !== true);
    if (out.opened && kind === 'checkWeb') onOpened();
  };
  const step = kind === 'checkWeb' && webOpened ? 'confirm' : 'open';
  return (
    <>
      {step === 'confirm' ? (
        <button className="link" data-testid={testid} data-step="confirm" title="只解开这里的锁定，不会往 GitHub 发任何请求" onClick={onUnlock}>
          已在 GitHub 上核对过，解除锁定
        </button>
      ) : (
        <button
          className="link"
          data-testid={testid}
          data-step="open"
          title={copy !== null ? '先把原文复制到剪贴板，再打开这一条的 GitHub 页面' : '打开这一条的 GitHub 页面'}
          onClick={() => void press()}
        >
          {kind === 'checkWeb' ? '到 GitHub 上核对' : '到 GitHub 上处理'}
        </button>
      )}
      {copied && !problem && (
        <span className="small muted" data-testid={`${testid}-copied`}>
          {' '}
          原文已复制
        </span>
      )}
      {problem && (
        <span className="small err" data-testid={`${testid}-problem`}>
          {' '}
          {problem}
        </span>
      )}
    </>
  );
}
