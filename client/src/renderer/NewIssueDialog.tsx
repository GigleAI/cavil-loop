import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, BoardData, CreateJob, Item } from '../shared/types';
import type { GroupPreset, RepoOptions } from '../shared/actions';
import {
  canPickIteration,
  defaultIterationPick,
  defaultMilestonePick,
  defaultRepo,
  iterationChoices,
  iterationKey,
  milestoneChoices,
  previewCreateWith,
  shownLines,
  type IterationPick,
  type MilestonePick,
  type MilestoneRead,
} from '../data/groupPreset';
import { defaultBoards } from '../data/newIssueBoards';
import { api } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { noteOf, PasteImageNotice, ResultBanner, type ResultNote } from './DetailPanel';
import { LabelPicker } from './LabelPicker';
import { labelStyle, useDarkMode } from './colors';
import { Icon } from './Icons';
import { isImageOnlyPaste, newIssueOnWeb } from './pasteImage';
import { IterationOptions, localToday } from './iterationOptions';
import { currentIterationNames, foldSummary, iterationOptionLabel, iterationPickText, milestoneText } from '../data/newIssueFields';
import { sortRepos } from '../shared/repoOrder';
import { checkHandoff, handoffProblem, handoffSummary, mergeLabels, type Handoff, type HandoffCheck, type LabelRead } from '../shared/handoff';

const HANDOFF_TITLES: Record<Handoff, string> = { none: '只建 issue', agent: '交给 agent', autopilot: '托管（自动合并）' };

/** Repositories a new issue can go to: the repository sources plus every repository seen on the board, in the saved repository order (GitHub#304). */
export function knownRepos(state: AppState, data: BoardData): string[] {
  const out = new Map<string, string>();
  for (const s of state.sources) if (s.kind === 'repo') out.set(`${s.owner}/${s.name}`.toLowerCase(), `${s.owner}/${s.name}`);
  for (const i of data.items) if (!out.has(i.repo.toLowerCase())) out.set(i.repo.toLowerCase(), i.repo);
  return sortRepos([...out.values()], state.repoOrder);
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
  // GitHub#372: the iteration / milestone picked here; null = not touched (what the group gives)
  // a draft given back after a failed create keeps what was picked for it
  const [itPick, setItPick] = useState<IterationPick | null>(draft?.picks?.iteration ?? null);
  const [msPick, setMsPick] = useState<MilestonePick | null>(draft?.picks?.milestone ?? null);
  // GitHub#372: the keyboard starts in the title (after the dialog took it, see ConfirmDialog);
  // a draft given back keeps its title, the caret at its end. Only once, when the dialog opens.
  const titleBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = titleBox.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);
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
  // GitHub#405: labels, milestone and iteration sit in one fold, shut every time the dialog opens
  const [moreOpen, setMoreOpen] = useState(false);
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
    // the milestone belongs to the repository: another repository starts from the default again
    if (!(seq === 1 && (!draft || repo === draft.repo))) setMsPick(null);
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
  // GitHub#276: the plain "新建" is the whole table's "+": a plan too, so the ticked boards get the current
  // iteration. "Today" is fixed when the dialog opens: what it would set never changes behind the dialog.
  const [today] = useState(() => localToday(Date.now()));
  const preset: GroupPreset = group?.preset ?? { by: 'none' };
  // GitHub#372: the iteration picker only shows while a ticked board can take one; hidden, it is not touched
  const showIt = canPickIteration(ticked);
  const preview = previewCreateWith(preset, { iteration: showIt ? itPick : null, milestone: msPick }, ticked, repo, read, allProjects.filter((p) => !projects.includes(p.key)), today);
  const itNow = (showIt ? itPick : null) ?? defaultIterationPick(preset);
  const msNow = msPick ?? defaultMilestonePick(preset);
  const itChoices = iterationChoices(ticked, today);
  const itValue = itNow.kind === 'set' ? iterationKey(itNow) : itNow.kind;
  // the one the picker holds when it is not one of the offered (an ended iteration a group gave)
  const itKept = itNow.kind === 'set' && !itChoices.some((i) => i.id === itValue) ? { id: itValue, title: itNow.title, startDate: itNow.startDate, duration: 0 } : null;
  // what "当前迭代" means here: the one name when every ticked board agrees, else per board
  const currents = currentIterationNames(ticked, today);
  const msChoices = milestoneChoices(read);
  const msValue = msNow.kind === 'set' ? msNow.title : '';
  // GitHub#405: the fold's head line — the iteration / milestone as the pickers show them (one function for both)
  const fold = foldSummary({
    labels,
    labelsRead: !opts ? 'loading' : opts.error ? 'error' : 'ok',
    milestone: milestoneText(read, msValue),
    iteration: showIt ? iterationPickText(itValue, itChoices, itKept, currents, today) : null,
  });
  // GitHub#231: what an iteration / status group sets is about the boards: said right under their boxes
  const boardPreview = preset.by === 'iteration' || preset.by === 'status';
  // GitHub#270: only what will not happen as the group says; the rest is in the title (nothing to say = no box).
  // GitHub#276: a line about one board (the current iteration not set) goes under the boards whatever the group.
  const notes = shownLines(preview);
  const aboutBoard = (target: string) => target !== 'milestone' && (boardPreview || allProjects.some((p) => target === p.key || target === `${p.key}:iteration`));
  const box = (place: 'boards' | 'repo') => {
    const here = notes.filter((l) => aboutBoard(l.target) === (place === 'boards'));
    return here.length > 0 && (
    <div className="preset" data-testid="new-issue-preset" data-blocked={preview.blocked ? 'yes' : 'no'} data-place={place}>
      {here.map((l) => (
        <div key={`${l.target}:${l.text}`} className="small muted" data-testid="new-issue-preset-line" data-target={l.target} data-applies="no">
          {l.text}
        </div>
      ))}
    </div>
    );
  };

  const toggleMore = () => {
    if (moreOpen) setPicking(false);
    setMoreOpen(!moreOpen);
  };

  const colorOf = (name: string) => opts?.labels.find((l) => l.name === name)?.color ?? '';
  const toggleLabel = (name: string) => setLabels((ls) => (ls.includes(name) ? ls.filter((x) => x !== name) : [...ls, name]));

  return (
    <ConfirmDialog
      title={group ? `新建 issue · 加到「${group.title}」` : '新建 issue'}
      confirmLabel="创建"
      busy={busy}
      disabled={!repo || !title.trim() || Boolean(preview.blocked) || handoffWaits}
      dirty={Boolean(title.trim() || body.trim())}
      onCancel={onClose}
      onConfirm={async () => {
        if (!preview.plan) return;
        // GitHub#229: the dialog does not wait for GitHub — the outcome shows above the board,
        // the new issue opens once it exists; only a refusal before anything went out keeps it open
        setBusy(true);
        const used = handoff;
        // remembered by the app once the issue exists, and only when picked by hand here (GitHub#245)
        const r = await api().startCreate({ kind: 'createIssue', repo, title, body, labels, projects: ticked.map((p) => p.key), handoff: used, handoffPicked: picked !== null && picked === used, plan: preview.plan, picks: { iteration: showIt ? itPick : null, milestone: msPick } });
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
        {box('repo')}
        <label>
          标题
          <input data-testid="new-issue-title" ref={titleBox} value={title} onChange={(e) => setTitle(e.target.value)} />
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
          {box('boards')}
        </div>
        <div className={`more-fields${moreOpen ? ' open' : ''}`} data-testid="new-issue-more" data-open={moreOpen ? 'yes' : 'no'}>
          <button
            type="button"
            className="more-head"
            data-testid="new-issue-more-toggle"
            aria-expanded={moreOpen}
            title={moreOpen ? `收起${fold.title}` : `展开${fold.title}`}
            onClick={toggleMore}
            // the dialog lets no plain Enter press one of its buttons (GitHub#192, ConfirmDialog); opening
            // or shutting this fold sends nothing, so Enter does it here (and Space, as on any button)
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
                e.preventDefault();
                toggleMore();
              }
            }}
          >
            <Icon name="chevron" size={14} />
            <span className="more-title">{fold.title}</span>
            {!moreOpen && (
              <span className="more-sum" data-testid="new-issue-more-summary">
                {fold.parts.map((part, i) => (
                  <span key={part.kind === 'labels' ? 'labels' : part.field} className="more-part" data-part={part.kind === 'labels' ? 'labels' : part.field} data-tone={part.kind === 'text' ? part.tone : undefined}>
                    {i > 0 && <span className="sep">·</span>}
                    {part.kind === 'labels' ? (
                      <>
                        {part.names.map((n) => (
                          <span key={n} className="label" data-testid="new-issue-more-label" data-label={n} style={labelStyle(colorOf(n), isDark)}>
                            {n}
                          </span>
                        ))}
                        {part.more > 0 && <span data-testid="new-issue-more-extra">+{part.more}</span>}
                      </>
                    ) : (
                      <span className={part.tone === 'error' ? 'err' : undefined} data-testid={`new-issue-more-${part.field}`}>
                        {part.text}
                      </span>
                    )}
                  </span>
                ))}
              </span>
            )}
          </button>
          {moreOpen && (
            <div className="more-body">
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
                <label>
                  里程碑
                  <select
                    data-testid="new-issue-milestone"
                    data-read={read.state}
                    value={read.state === 'loading' ? '' : msValue}
                    disabled={busy || read.state !== 'ok'}
                    title={read.state === 'error' ? `读不到仓库 ${repo} 的里程碑（${read.error}）` : undefined}
                    onChange={(e) => setMsPick(e.target.value ? { kind: 'set', title: e.target.value } : { kind: 'none' })}
                  >
                    {read.state === 'loading' ? (
                      <option value="">读取里程碑…</option>
                    ) : (
                      <>
                        <option value="">不设里程碑</option>
                        {msValue && !msChoices.includes(msValue) && <option value={msValue}>{msValue}</option>}
                        {msChoices.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                </label>
                {showIt && (
                  <label>
                    迭代（加到勾选的看板上）
                    <select
                      data-testid="new-issue-iteration"
                      value={itValue}
                      disabled={busy}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === 'auto' || v === 'none') return setItPick({ kind: v });
                        const it = itChoices.find((i) => i.id === v) ?? itKept;
                        if (it) setItPick({ kind: 'set', title: it.title, startDate: it.startDate });
                      }}
                    >
                      <option value="auto">{iterationPickText('auto', itChoices, itKept, currents, today)}</option>
                      <option value="none">不设迭代</option>
                      <IterationOptions iterations={itChoices} chosen={itKept} today={today} label={iterationOptionLabel} />
                    </select>
                  </label>
                )}
            </div>
          )}
        </div>
        <ResultBanner note={note} testid="new-issue-result" />
      </div>
    </ConfirmDialog>
  );
}
