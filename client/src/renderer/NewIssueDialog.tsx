import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, BoardData, Item } from '../shared/types';
import type { GroupPreset, RepoOptions } from '../shared/actions';
import { defaultRepo, previewCreate, type MilestoneRead } from '../data/groupPreset';
import { defaultBoards } from '../data/newIssueBoards';
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

/** A new issue from a table group's "+" (GitHub#214): the group's value, its title, the items in it. */
export interface GroupSeed {
  preset: GroupPreset;
  title: string;
  items: Item[];
}

export function NewIssueDialog({
  state,
  data,
  group,
  onClose,
  onCreated,
}: {
  state: AppState;
  data: BoardData;
  group?: GroupSeed;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const repos = useMemo(() => knownRepos(state, data), [state, data]);
  const [repo, setRepo] = useState(() => (group ? defaultRepo(group.preset, group.items, repos) : (repos[0] ?? '')));
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [opts, setOpts] = useState<RepoOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ResultNote | null>(null);
  const [picking, setPicking] = useState(false);
  const allProjects = data.allProjects ?? data.projects;
  // GitHub#231: the same rule for both ways in (the "新建" button and a table group's "+"): the board
  // holding the most of this repository's items, judged on every configured board whatever the view
  // shows. It follows the repository picked and each finished sync — until a box is ticked or
  // unticked by hand (`manual`), which is then kept as it is.
  const defaults = defaultBoards(data.boardRepos ?? [], allProjects, repo);
  const [manual, setManual] = useState<string[] | null>(null);
  const projects = manual ?? defaults.ticked;
  const [pasted, setPasted] = useState<{ copied: boolean | null } | null>(null);
  const isDark = useDarkMode();

  // every pick of a repository is a read of its own: only the latest one may land. Compared by
  // read, not by repository name — after A → B → A the first read of A is as stale as B's.
  const readSeq = useRef(0);
  useEffect(() => {
    const seq = ++readSeq.current;
    setLabels([]);
    setOpts(null);
    setPicking(false);
    if (repo)
      api()
        .repoOptions(repo)
        .then((o) => {
          if (seq === readSeq.current) setOpts(o);
        });
  }, [repo]);
  const read: MilestoneRead = !opts ? { state: 'loading' } : opts.error ? { state: 'error', error: opts.error } : { state: 'ok', milestones: opts.milestones };
  // the Projects ticked in the dialog, in the order they are listed: the ones the issue joins, and what a group's "+" fills in (GitHub#214)
  const ticked = allProjects.filter((p) => projects.includes(p.key));
  const preview = group ? previewCreate(group.preset, ticked, repo, read) : null;
  // GitHub#231: what an iteration / status group sets is about the boards: said right under their boxes
  const boardPreview = group?.preset.by === 'iteration' || group?.preset.by === 'status';
  const previewBox = preview && (
    <div className="preset" data-testid="new-issue-preset" data-blocked={preview.blocked ? 'yes' : 'no'} data-place={boardPreview ? 'boards' : 'repo'}>
      <div className="small muted">会带上：</div>
      {preview.lines.map((l) => (
        <div key={l.target} className={l.applies ? 'small' : 'small muted'} data-testid="new-issue-preset-line" data-target={l.target} data-applies={l.applies ? 'yes' : 'no'}>
          {l.applies ? '✓ ' : '– '}
          {l.text}
        </div>
      ))}
    </div>
  );

  const colorOf = (name: string) => opts?.labels.find((l) => l.name === name)?.color ?? '';
  const toggleLabel = (name: string) => setLabels((ls) => (ls.includes(name) ? ls.filter((x) => x !== name) : [...ls, name]));

  return (
    <ConfirmDialog
      title={group ? `新建 issue · 加到「${group.title}」` : '新建 issue'}
      confirmLabel="创建"
      busy={busy}
      disabled={!repo || !title.trim() || Boolean(preview?.blocked)}
      dirty={Boolean(title.trim() || body.trim())}
      onCancel={onClose}
      onConfirm={async () => {
        if (preview && !preview.plan) return;
        setBusy(true);
        const r = await api().act({ kind: 'createIssue', repo, title, body, labels, projects: ticked.map((p) => p.key), ...(preview?.plan ? { plan: preview.plan } : {}) });
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
        {preview && !boardPreview && previewBox}
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
                    onChange={(e) => setManual(e.target.checked ? [...projects.filter((x) => x !== p.key), p.key] : projects.filter((x) => x !== p.key))}
                  />
                  「{p.title}」
                  {!p.viewerCanUpdate && <span className="small muted">（这个账号不能修改它）</span>}
                </label>
              ))}
              <span className="small muted" data-testid="new-issue-projects-hint">
                {projects.length ? `会加入 ${projects.length} 个看板` : '一个都不勾 = 不加入任何看板'}
              </span>
              {manual === null &&
                defaults.unsynced.map((b) => (
                  <span key={b.key} className="small muted" data-testid="new-issue-project-unsynced" data-project={b.key}>
                    看板「{b.title}」还没同步完，默认勾选没把它算进去
                  </span>
                ))}
            </div>
          ) : (
            <p className="small muted">还没有添加看板来源，建好后不加入任何看板</p>
          )}
          {preview && boardPreview && previewBox}
        </div>
        <ResultBanner note={note} testid="new-issue-result" />
      </div>
    </ConfirmDialog>
  );
}
