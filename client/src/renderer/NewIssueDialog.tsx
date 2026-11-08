import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, BoardData, CreateJob, Item } from '../shared/types';
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
import { checkHandoff, handoffProblem, handoffSummary, mergeLabels, type Handoff, type HandoffCheck, type LabelRead } from '../shared/handoff';

const HANDOFF_TITLES: Record<Handoff, string> = { none: '只建 issue', agent: '交给 agent', autopilot: '托管（自动合并）' };

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
  draft,
  onClose,
}: {
  state: AppState;
  data: BoardData;
  group?: GroupSeed;
  /** GitHub#229: a draft given back after a create that surely created nothing */
  draft?: CreateJob['draft'];
  onClose: () => void;
}) {
  const repos = useMemo(() => knownRepos(state, data), [state, data]);
  const [repo, setRepo] = useState(() => (draft ? draft.repo : group ? defaultRepo(group.preset, group.items, repos) : (repos[0] ?? '')));
  const [title, setTitle] = useState(draft?.title ?? '');
  const [body, setBody] = useState(draft?.body ?? '');
  const [labels, setLabels] = useState<string[]>(draft?.labels ?? []);
  const [opts, setOpts] = useState<RepoOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ResultNote | null>(null);
  const [picking, setPicking] = useState(false);
  const allProjects = data.allProjects ?? data.projects;
  // GitHub#231: the same rule for both ways in (the "新建" button and a table group's "+"): the board
  // holding the most of this repository's items, judged on every configured board whatever the view
  // shows. It follows the repository picked and each finished sync — until a box is ticked or
  // unticked by hand (`manual`), which is then kept as it is. GitHub#229: a draft given back after a
  // create that surely created nothing keeps the boards it had (as if ticked by hand).
  const defaults = defaultBoards(data.boardRepos ?? [], allProjects, repo);
  const [manual, setManual] = useState<string[] | null>(draft?.projects ?? null);
  const projects = manual ?? defaults.ticked;
  // a board is "added" when it is a source, whether or not it was read completely yet
  const configured = allProjects.length > 0 || (data.boardRepos ?? []).length > 0;
  const [pasted, setPasted] = useState<{ copied: boolean | null } | null>(null);
  const isDark = useDarkMode();
  // GitHub#245: who the new issue is handed to. `picked` = clicked in this dialog (null = not touched):
  // only a choice made here and actually used for a created issue is remembered — a fallback to
  // "只建 issue" because the labels are unknown / missing never overwrites what was remembered
  // a draft given back after a failed create keeps the hand-over picked for it
  const [picked, setPicked] = useState<Handoff | null>(draft?.handoffPicked && draft.handoff ? draft.handoff : null);
  const hb = state.handBack;

  // every pick of a repository is a read of its own: only the latest one may land. Compared by
  // read, not by repository name — after A → B → A the first read of A is as stale as B's.
  const readSeq = useRef(0);
  useEffect(() => {
    const seq = ++readSeq.current;
    // a draft given back keeps its labels for the repository it was written for
    if (!(draft && seq === 1 && repo === draft.repo)) setLabels([]);
    setOpts(null);
    setPicking(false);
    // read now, never from this run's earlier read (GitHub#214: the milestone it will carry must be GitHub's current one)
    if (repo)
      api()
        .repoOptions(repo, true)
        .then((o) => {
          if (seq === readSeq.current) setOpts(o);
        });
  }, [repo]);
  const read: MilestoneRead = !opts ? { state: 'loading' } : opts.error ? { state: 'error', error: opts.error } : { state: 'ok', milestones: opts.milestones };
  const labelRead: LabelRead = !opts ? { state: 'loading' } : opts.error ? { state: 'error', error: opts.error } : { state: 'ok', names: opts.labels.map((l) => l.name) };
  const choices: Handoff[] = hb.autopilot.trim() ? ['none', 'agent', 'autopilot'] : ['none', 'agent'];
  const checks = Object.fromEntries(choices.map((h) => [h, checkHandoff(h, hb, labelRead)])) as Record<Handoff, HandoffCheck>;
  const wanted = picked ?? state.newIssueHandoff;
  const wantedCheck = checks[wanted] ?? checkHandoff(wanted, hb, labelRead);
  // still reading: the wanted choice stays shown (creating waits); unknown / missing / unset: this time a plain issue
  const handoff: Handoff = wantedCheck.state === 'ok' || wantedCheck.state === 'loading' ? wanted : 'none';
  const handoffWaits = handoff !== 'none' && wantedCheck.state === 'loading';
  const handoffLabels = wantedCheck.state === 'ok' && handoff !== 'none' ? wantedCheck.labels : [];
  const fellBack = handoff !== wanted ? handoffProblem(repo, wantedCheck) : '';
  // the Projects ticked in the dialog, in the order they are listed: the ones the issue joins, and what a group's "+" fills in (GitHub#214)
  const ticked = allProjects.filter((p) => projects.includes(p.key));
  // GitHub#258: the boards left unticked are watched for taking the issue in by themselves
  const preview = group ? previewCreate(group.preset, ticked, repo, read, allProjects.filter((p) => !projects.includes(p.key))) : null;
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
      disabled={!repo || !title.trim() || Boolean(preview?.blocked) || handoffWaits}
      dirty={Boolean(title.trim() || body.trim())}
      onCancel={onClose}
      onConfirm={async () => {
        if (preview && !preview.plan) return;
        // GitHub#229: the dialog does not wait for GitHub — the outcome shows above the board,
        // the new issue opens once it exists; only a refusal before anything went out keeps it open
        setBusy(true);
        const used = handoff;
        // remembered by the app once the issue exists, and only when picked by hand here (GitHub#245)
        const r = await api().startCreate({ kind: 'createIssue', repo, title, body, labels, projects: ticked.map((p) => p.key), handoff: used, handoffPicked: picked !== null && picked === used, ...(preview?.plan ? { plan: preview.plan } : {}) });
        setBusy(false);
        if (r.ok) return onClose();
        setNote(noteOf({ ok: false, error: r.error, warning: null }, ''));
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
            // the same wait as 创建: a hand-over whose labels are still being read is not sent as "no labels"
            webBlocked={handoffWaits ? handoffProblem(repo, wantedCheck) : ''}
            onWeb={() => {
              if (handoffWaits) return;
              // the web page's new-issue form, filled with what was typed here
              void api().openExternal(newIssueOnWeb('https://github.com', repo, title, body, mergeLabels(handoffLabels, labels)));
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
        <div data-testid="new-issue-handoff" data-handoff={handoff} data-wanted={wanted}>
          建好后
          <div className="handoff-picks">
            {choices.map((h) => {
              const c = checks[h];
              const usable = c.state === 'ok' || (c.state === 'loading' && h === wanted);
              return (
                <label key={h} title={handoffProblem(repo, c)}>
                  <input
                    type="radio"
                    name="new-issue-handoff"
                    data-testid="new-issue-handoff-choice"
                    data-choice={h}
                    data-state={c.state}
                    checked={handoff === h}
                    disabled={busy || !usable}
                    onChange={() => setPicked(h)}
                  />
                  {HANDOFF_TITLES[h]}
                </label>
              );
            })}
          </div>
          {handoffSummary(handoff, handoffLabels) && (
            <div className="small muted" data-testid="new-issue-handoff-summary">
              {handoffSummary(handoff, handoffLabels)}
            </div>
          )}
          {handoffWaits && (
            <div className="small muted" data-testid="new-issue-handoff-wait">
              {handoffProblem(repo, wantedCheck)}
            </div>
          )}
          {!fellBack &&
            !handoffWaits &&
            [...new Set(choices.filter((h) => h !== handoff && checks[h].state !== 'ok' && checks[h].state !== 'loading').map((h) => handoffProblem(repo, checks[h])))].map((why) => (
              <div key={why} className="small muted" data-testid="new-issue-handoff-why">
                {why}
              </div>
            ))}
          {fellBack && (
            <div className="small muted" data-testid="new-issue-handoff-fallback" data-reason={wantedCheck.state}>
              {wantedCheck.state === 'error' ? fellBack : `${fellBack}，本次只建普通 issue，记住的「${HANDOFF_TITLES[wanted]}」不变`}
            </div>
          )}
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
            </div>
          ) : configured ? (
            // boards are added but none was read completely yet: not "no board added" (PR #241 review round 1)
            <p className="small muted" data-testid="new-issue-projects-none-synced">
              已添加的看板都还没同步完，现在没法勾选；同步完后这里会列出来
            </p>
          ) : (
            <p className="small muted" data-testid="new-issue-projects-none">还没有添加看板来源，建好后不加入任何看板</p>
          )}
          {manual === null &&
            defaults.unsynced.map((b) => (
              <div key={b.key} className="small muted" data-testid="new-issue-project-unsynced" data-project={b.key}>
                看板「{b.title}」还没同步完，默认勾选没把它算进去
              </div>
            ))}
          {preview && boardPreview && previewBox}
        </div>
        <ResultBanner note={note} testid="new-issue-result" />
      </div>
    </ConfirmDialog>
  );
}
