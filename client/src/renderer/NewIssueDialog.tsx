import { useEffect, useMemo, useState } from 'react';
import type { AppState, BoardData } from '../shared/types';
import type { RepoOptions } from '../shared/actions';
import { api } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { noteOf, ResultBanner, type ResultNote } from './DetailPanel';

/** Repositories a new issue can go to: the repository sources plus every repository seen on the board. */
export function knownRepos(state: AppState, data: BoardData): string[] {
  const out = new Map<string, string>();
  for (const s of state.sources) if (s.kind === 'repo') out.set(`${s.owner}/${s.name}`.toLowerCase(), `${s.owner}/${s.name}`);
  for (const i of data.items) if (!out.has(i.repo.toLowerCase())) out.set(i.repo.toLowerCase(), i.repo);
  return [...out.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

export function NewIssueDialog({ state, data, onClose, onCreated }: { state: AppState; data: BoardData; onClose: () => void; onCreated: (key: string) => void }) {
  const repos = useMemo(() => knownRepos(state, data), [state, data]);
  const [repo, setRepo] = useState(repos[0] ?? '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [opts, setOpts] = useState<RepoOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ResultNote | null>(null);

  useEffect(() => {
    setLabels([]);
    setOpts(null);
    if (repo) api().repoOptions(repo).then(setOpts);
  }, [repo]);

  return (
    <ConfirmDialog
      title="新建 issue"
      confirmLabel="创建"
      busy={busy}
      disabled={!repo || !title.trim()}
      dirty={Boolean(title.trim() || body.trim())}
      onCancel={onClose}
      onConfirm={async () => {
        setBusy(true);
        const r = await api().act({ kind: 'createIssue', repo, title, body, labels });
        setBusy(false);
        if (r.ok && r.createdKey) {
          onCreated(r.createdKey);
          if (!r.warning) return onClose();
        }
        setNote(noteOf(r, 'issue 已建好'));
      }}
    >
      <div className="form" data-testid="new-issue">
        <label>
          仓库
          <select data-testid="new-issue-repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          标题
          <input data-testid="new-issue-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          正文
          <textarea data-testid="new-issue-body" value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div>
          标签
          <div className="labels pick">
            {!opts && <span className="muted small">读取标签…</span>}
            {opts?.error && <span className="err small">{opts.error}</span>}
            {opts?.labels.map((l) => (
              <label key={l.name} className="chip">
                <input
                  type="checkbox"
                  data-testid="new-issue-label"
                  data-label={l.name}
                  checked={labels.includes(l.name)}
                  onChange={(e) => setLabels(e.target.checked ? [...labels, l.name] : labels.filter((x) => x !== l.name))}
                />
                {l.name}
              </label>
            ))}
          </div>
        </div>
        <p className="small muted" data-testid="new-issue-projects">
          {data.projects.length ? `建好后自动加入当前勾选的看板：${data.projects.map((p) => `「${p.title}」`).join('、')}` : '当前没有勾选看板，建好后不加入任何看板'}
        </p>
        <ResultBanner note={note} testid="new-issue-result" />
      </div>
    </ConfirmDialog>
  );
}
