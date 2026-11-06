import { useEffect, useMemo, useState } from 'react';
import type { AppState, BoardData } from '../shared/types';
import type { RepoOptions } from '../shared/actions';
import { api } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { noteOf, PasteImageNotice, ResultBanner, type ResultNote } from './DetailPanel';
import { LabelPicker } from './LabelPicker';
import { labelStyle, useDarkMode } from './colors';
import { Icon } from './Icons';
import { isImageOnlyPaste, newIssueOnWeb } from './pasteImage';

/** Repositories a new issue can go to: the repository sources plus every repository seen on the board. */
export function knownRepos(state: AppState, data: BoardData): string[] {
  const out = new Map<string, string>();
  for (const s of state.sources) if (s.kind === 'repo') out.set(`${s.owner}/${s.name}`.toLowerCase(), `${s.owner}/${s.name}`);
  for (const i of data.items) if (!out.has(i.repo.toLowerCase())) out.set(i.repo.toLowerCase(), i.repo);
  return [...out.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * GitHub#205 (maintainer's choice C): which Projects are ticked when the dialog opens — the
 * ones the view is narrowed to (that this account may change); none when the view shows every source
 * (nothing ticked off at the top, or every source ticked one by one).
 */
export function defaultProjects(state: AppState, data: BoardData): string[] {
  const sel = state.view.selected;
  const everything = sel === null || state.sources.every((s) => sel.includes(s.key));
  return everything ? [] : data.projects.filter((p) => p.viewerCanUpdate).map((p) => p.key);
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
  const [picking, setPicking] = useState(false);
  const allProjects = data.allProjects ?? data.projects;
  // decided once, when the dialog opens: a sync round meanwhile does not re-tick what the user unticked
  const [projects, setProjects] = useState<string[]>(() => defaultProjects(state, data));
  const [pasted, setPasted] = useState<{ copied: boolean | null } | null>(null);
  const isDark = useDarkMode();

  useEffect(() => {
    setLabels([]);
    setOpts(null);
    setPicking(false);
    if (repo) api().repoOptions(repo).then(setOpts);
  }, [repo]);

  const colorOf = (name: string) => opts?.labels.find((l) => l.name === name)?.color ?? '';
  const toggleLabel = (name: string) => setLabels((ls) => (ls.includes(name) ? ls.filter((x) => x !== name) : [...ls, name]));

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
        const r = await api().act({ kind: 'createIssue', repo, title, body, labels, projects: allProjects.filter((p) => projects.includes(p.key)).map((p) => p.key) });
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
          <textarea
            data-testid="new-issue-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onPaste={(e) => {
              if (!isImageOnlyPaste(e.clipboardData)) return;
              e.preventDefault();
              setPasted({ copied: null });
            }}
          />
        </label>
        {pasted && (
          <PasteImageNotice
            copied={pasted.copied}
            webLabel="到 GitHub 网页上继续新建"
            onWeb={() => {
              // the web page's new-issue form, filled with what was typed here
              void api().openExternal(newIssueOnWeb('https://github.com', repo, title, body, labels));
              setPasted({ copied: null });
            }}
            onDismiss={() => setPasted(null)}
          />
        )}
        <div>
          标签
          <div className="chosen-labels" data-testid="new-issue-labels">
            {labels.map((n) => (
              <span key={n} className="label" data-testid="new-issue-label-chip" data-label={n} style={labelStyle(colorOf(n), isDark)}>
                {n}
                <button className="label-x" data-testid="new-issue-label-remove" data-label={n} title={`去掉「${n}」`} onClick={() => toggleLabel(n)}>
                  <Icon name="x" size={10} />
                </button>
              </span>
            ))}
            <span className="picker-anchor">
              <button className="label-plus" data-testid="new-issue-label-add" disabled={!opts || Boolean(opts.error)} onClick={() => setPicking(!picking)}>
                {opts ? '+ 加标签' : '读取标签…'}
              </button>
              {picking && opts && (
                <LabelPicker
                  title="选择标签"
                  hint={repo}
                  testid="new-issue-label-picker"
                  disabled={false}
                  items={opts.labels.map((l) => ({ name: l.name, color: l.color, checked: labels.includes(l.name) }))}
                  onToggle={(l) => toggleLabel(l.name)}
                  onClose={() => setPicking(false)}
                />
              )}
            </span>
            {opts?.error && <span className="err small">{opts.error}</span>}
          </div>
        </div>
        <div data-testid="new-issue-projects">
          建好后加入这些看板
          {allProjects.length ? (
            <div className="project-picks">
              {allProjects.map((p) => (
                <label key={p.key}>
                  <input
                    type="checkbox"
                    data-testid="new-issue-project"
                    data-project={p.key}
                    checked={projects.includes(p.key)}
                    disabled={!p.viewerCanUpdate}
                    onChange={(e) => setProjects((ps) => (e.target.checked ? [...ps, p.key] : ps.filter((x) => x !== p.key)))}
                  />
                  「{p.title}」
                  {!p.viewerCanUpdate && <span className="small muted">（这个账号不能修改它）</span>}
                </label>
              ))}
              <span className="small muted" data-testid="new-issue-projects-hint">
                {projects.length ? `会加入 ${projects.length} 个看板` : '一个都不勾 = 不加入任何看板'}
              </span>
            </div>
          ) : (
            <p className="small muted">还没有添加看板来源，建好后不加入任何看板</p>
          )}
        </div>
        <ResultBanner note={note} testid="new-issue-result" />
      </div>
    </ConfirmDialog>
  );
}
