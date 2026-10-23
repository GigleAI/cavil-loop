#!/usr/bin/env python3
"""Generate the animated + static explainer diagrams under docs/images/ (GitHub#76).

Usage: python3 scripts/doc-diagrams/gen.py [out_dir]   (default: docs/images)

Every SVG is generated here, never hand-edited: the zh / en copies and the
animated / static variants must say the same thing, and the only way to keep
eight files in step is to render them from one table. tests/doc-diagrams.test.sh
regenerates into a temp dir and diffs, so an edit made straight to an SVG fails.

The visual design (layout, palette, a red box that slides between steps and
resizes to frame a group, captions that fade) follows the reference diagrams the
maintainer asked for on PR #77; captions were corrected where they disagreed
with the code (the review gate is optional, the hook column is project-side).

Constraints the output must keep (GitHub shows a README SVG as a plain <img>):
  - SMIL <animate> only: no <script>, no element ids (so no url(#...) markers —
    arrowheads are drawn as paths), no external fonts or references
  - one cycle per image; every animation starts at 0s and shares that cycle, so
    the frame at 0s (or with animation off) is the full diagram, the red box on
    step 1 and step 1's caption showing
  - a caption is visible only while the red box sits on its step; it fades in
    after the box arrives and finishes fading out while the box moves away, so
    two captions never overlap
The behavioural checks live in check.py; step k's framed elements carry class
"card s<k>" so the checker can tell which step the box is on.
"""
import os
import sys
from xml.sax.saxutils import escape

MOVE_SECS = 0.5    # red box slide between steps
FADE_SECS = 0.25   # caption fade, inside the stay (in) and inside the slide (out)
EASE = '0.42 0 0.58 1'

SANS = "system-ui, 'PingFang SC', 'Noto Sans CJK SC', sans-serif"
SERIF = "Georgia, 'Noto Serif CJK SC', 'Songti SC', serif"
MONO = 'ui-monospace, Menlo, monospace'

INK, MUTED, PAPER, CARD, LINE, RED = '#1F1D1A', '#7A746A', '#F6F2EA', '#FFFDF8', '#CFC7B8', '#C2412D'
PANEL = '#EFE9DD'
# label pill colours: who moves next
PILL = {
    'agent':  ('#DCE6F2', '#2F5D8A'),   # waits for an agent
    'doing':  ('#F6E7C8', '#8A5A12'),   # agent working
    'review': ('#E7E0F2', '#5B3F8E'),   # waits for review
    'human':  ('#DCEEDF', '#2F6A40'),   # waits for you
    'track':  ('#E3E0DA', '#4A4640'),   # tracking / closed
    'none':   ('#EDE8DE', '#7A746A'),   # no label yet
}
CIRCLED = '①②③④⑤⑥⑦⑧⑨'

# ── content ────────────────────────────────────────────────────────────────
# Facts were checked against the code (dispatch scripts, prompt templates,
# config defaults); keep them in sync with docs/architecture.md.

LIFECYCLE = {
    'zh': {
        'title': '一个 issue 在 cavil-loop 里走一圈',
        'subtitle': '全程靠 GitHub 标签接力：标签在谁手里，就轮到谁。红框走到哪一步，下面就讲哪一步。',
        'subtitle_static': '全程靠 GitHub 标签接力：标签在谁手里，就轮到谁。每一步的说明都列在下面。',
        'now': '此时标签', 'none': '还没有', 'optional': '可选', 'bounce': '打回',
        'legend': ['标签 = 下一步谁动', '蓝：等 agent　琥珀：agent 在干', '紫：等复审　绿：等你'],
        'steps': [
            ('你开 issue', None, 'none', False,
             ['在 GitHub 上新开一个 issue，写清要做什么。',
              '新 issue 默认等你分派，守护进程不会碰它（项目开了「不打标签也干」的贪心模式时例外）。']),
            ('你打标签', 'pending/agent', 'agent', False,
             ['给 issue 打上 pending/agent，意思是「交给 agent」。',
              '这是唯一的开关：不打这个标签，什么都不会发生。']),
            ('守护进程巡检', 'pending/agent', 'agent', False,
             ['本机定时器默认每 60 秒叫醒一次巡检（可配置）；仓库久没动静会自动放慢。',
              '巡检只调 GitHub 接口、不调模型，所以空闲时不花模型的钱。']),
            ('起 worker', 'doing/agent', 'doing', False,
             ['给这个 issue 建独立的 worktree、tmux 会话和一个 agent 会话。',
              '先确认它真的活着，才把标签翻成 doing/agent；起不来就翻 pending/human 交给你。']),
            ('先发设计方案', 'pending/review', 'review', False,
             ['worker 先读代码，把方案发到 issue 评论里，列出要你拍板的选项。这一步不写代码，每个项目都有。',
              '开了复审关卡就翻 pending/review 交给复审；没开就直接翻 pending/human，跳到 ⑦。']),
            ('codex 复审', 'pending/human', 'human', True,
             ['另一个模型（默认 codex，可配置）独立审方案：不通过就打回，worker 回到 ⑤ 重写，最多 3 轮。',
              '通过了（或轮数用完）才翻 pending/human，方案这才到你面前。这一步可选，项目没开复审关卡就没有。']),
            ('你拍板', 'pending/agent', 'agent', False,
             ['你在评论里勾选项，或者直接回一句修改意见，',
              '再把标签改回 pending/agent，守护进程下一轮巡检时 worker 接着干。']),
            ('开发并开 PR', 'pending/PR', 'track', False,
             ['worker 先写测试再写代码，整条测试链跑绿后开 PR；issue 转成 pending/PR。',
              '开了复审关卡时，PR 同样先过一轮复审，再交给你验收。']),
            ('你合并', 'Done', 'track', False,
             ['你合并 PR 后，守护进程自动清理 worktree 和 tmux 会话。',
              'PR 打上 Done，issue 随 PR 关闭。']),
        ],
    },
    'en': {
        'title': 'One issue, once around cavil-loop',
        'subtitle': 'GitHub labels pass the baton: whoever the label points to moves next. The red box marks the step explained below.',
        'subtitle_static': 'GitHub labels pass the baton: whoever the label points to moves next. Every step is explained below.',
        'now': 'label now', 'none': 'none yet', 'optional': 'optional', 'bounce': 'bounce',
        'legend': ['Label = who moves next', 'Blue: waits for agent', 'Amber: agent working',
                   'Purple: waits for review', 'Green: waits for you'],
        'steps': [
            ('Open an issue', None, 'none', False,
             ['Open a new issue on GitHub and say what you want done.',
              'A new issue waits for you to hand it over; the daemon leaves it alone (unless the project runs greedy mode).']),
            ('You label it', 'pending/agent', 'agent', False,
             ['Label the issue pending/agent, meaning "hand this to the agent".',
              'It is the one and only switch: without this label nothing happens.']),
            ('Daemon polls', 'pending/agent', 'agent', False,
             ['A local timer wakes the poller every 60 s by default (configurable); a quiet repo slows it down.',
              'Polling only calls the GitHub API, never a model, so idle time costs no model spend.']),
            ('Worker starts', 'doing/agent', 'doing', False,
             ['The issue gets its own worktree, tmux session and agent session.',
              'Only once it is confirmed alive does the label flip to doing/agent; if it dies, pending/human.']),
            ('Design proposal', 'pending/review', 'review', False,
             ['The worker reads the code and posts a plan with the choices for you. No code yet; every project has this step.',
              'With a review gate it flips to pending/review for review; without one, straight to pending/human and step 7.']),
            ('codex review', 'pending/human', 'human', True,
             ['Another model (codex by default, configurable) reviews the plan; a fail bounces it back to 5, at most 3 rounds.',
              'Only a pass (or the last round) flips it to pending/human for you. Optional: no review gate, no step 6.']),
            ('You decide', 'pending/agent', 'agent', False,
             ['Tick the options in the comment, or reply with changes,',
              'then relabel pending/agent; the worker carries on at the next poll.']),
            ('Build + open PR', 'pending/PR', 'track', False,
             ['The worker writes tests first, then code; the PR opens once the tests are green. The issue moves to pending/PR.',
              'With a review gate the PR is reviewed first, then handed to you.']),
            ('You merge', 'Done', 'track', False,
             ['Once you merge, the daemon cleans up the worktree and tmux session.',
              'The PR is labeled Done and the issue closes with it.']),
        ],
    },
}

PROMPT = {
    'zh': {
        'title': '一条评论，怎么变成 worker 手里的指令',
        'subtitle': '提示词分层拼装；会话活着就粘贴进去，退出了就按角色续上；项目侧可选：改文件前再补规矩。',
        'layers': [('通用工作流', '决策树、标签怎么翻'), ('通用公开经验', '跨项目都成立的原则'),
                   ('项目复盘经验', '合并后复盘攒的硬规则'), ('本项目附加要求', '冲突时以这一层为准')],
        'compose': ['合成一份', '完整提示词'],
        'alive': ('会话还活着', '粘贴进 tmux，再按回车'),
        'exited': ('会话已经退出', '按「编号 + 角色」续上原对话'),
        'hook_title': '项目侧钩子示例（非 cavil-loop 自带）',
        'hook_edit': 'Edit / Write：src/feature/x.ts',
        'hook_files': ['AGENTS.md（根目录）', 'src/AGENTS.md', 'src/feature/AGENTS.md'],
        'hook_out': ['执行这次改动前塞进上下文', '同一会话塞过的不再重复'],
        'steps': [
            ('① 四层拼装',
             ['通用工作流 → 通用公开经验 → 项目复盘经验 → 本项目附加要求，按顺序首尾相接。',
              '越往后越具体；冲突时以最后一层「本项目附加要求」为准。']),
            ('② 合成一份完整提示词',
             ['再填上这条 issue / PR 的编号、分支、工作目录，',
              '就是 worker 这一轮拿到的全部指令。评论原文只当数据，不当指令。']),
            ('③ 会话还活着：直接粘贴',
             ['这个编号的 tmux 会话还在，就把提示词整段粘贴进去，再按一次回车提交。',
              '模型沿用原来的对话，前面干过什么都还记得。']),
            ('④ 会话已经退出：按角色续上',
             ['按「编号 + 角色」找回原来那条对话续上，找不到才全新开一条。',
              '写代码的和复审的各记各的，复审不会续到写代码那条，保证复审独立。']),
            ('⑤ 项目侧钩子（示例，非 cavil-loop 自带）：沿路径找规矩文件',
             ['worker 用 Edit / Write 改某个文件前，钩子从该文件所在目录一路往上找 AGENTS.md，',
              '只挑本会话还没塞过的。用 Bash 改文件不触发；codex 复审也不走这个钩子。']),
            ('⑥ 项目侧钩子（示例）：改动执行前就塞进上下文',
             ['找到的规矩文件在这次改动执行之前就交给模型，不用等下一轮。',
              '同一会话里塞过的不再重复，避免把上下文撑大。']),
        ],
    },
    'en': {
        'title': 'How a comment becomes the worker\'s instructions',
        'subtitle': 'Layers stack into one prompt; a live session gets it pasted, an exited one is resumed by role; optional, project-side: add rules before edits.',
        'layers': [('Base workflow', 'decision tree, label flips'), ('Public lessons', 'principles that hold everywhere'),
                   ('Project lessons', 'hard rules from retrospectives'), ('Project additions', 'this layer wins on conflict')],
        'compose': ['One complete', 'prompt'],
        'alive': ('Session alive', 'paste into tmux, press Enter'),
        'exited': ('Session exited', 'resume by number + role'),
        'hook_title': 'Project-side hook (example only)',
        'hook_edit': 'Edit / Write: src/feature/x.ts',
        'hook_files': ['AGENTS.md (repo root)', 'src/AGENTS.md', 'src/feature/AGENTS.md'],
        'hook_out': ['Injected before the edit runs', 'not repeated within a session'],
        'steps': [
            ('1  Four layers',
             ['Base workflow → public lessons → project lessons → project additions, joined end to end.',
              'Each layer is more specific than the last; on conflict the last one, project additions, wins.']),
            ('2  One complete prompt',
             ['Fill in this issue / PR\'s number, branch and working directory,',
              'and that is everything the worker gets this round. Comment text is data, never instructions.']),
            ('3  Session alive: paste',
             ['If this number\'s tmux session is still up, the whole prompt is pasted in and Enter submits it.',
              'The model keeps its conversation and remembers what it already did.']),
            ('4  Session exited: resume by role',
             ['The conversation recorded for number + role is resumed; only if there is none does a new one start.',
              'Coding and review keep separate records, so a review never resumes the coding conversation.']),
            ('5  Project-side hook (example, not part of cavil-loop): find rule files',
             ['Before the worker edits a file with Edit / Write, the hook walks up from that file\'s directory for AGENTS.md,',
              'picking only those not yet sent this session. Edits via Bash do not trigger it; nor does codex review.']),
            ('6  Project-side hook (example): inject before the edit',
             ['The rule files found reach the model before this edit runs, not a round later.',
              'Files already sent in this session are not repeated, so the context does not balloon.']),
        ],
    },
}

# ── drawing helpers ────────────────────────────────────────────────────────

def text(x, y, s, size, fill=INK, font=SANS, weight=400, anchor='start'):
    return (f'<text x="{x}" y="{y}" font-family="{font}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}" text-anchor="{anchor}">{escape(s)}</text>')


def width(s, size):
    # rough: CJK ≈ 1em, ASCII ≈ 0.6em (monospace labels are exactly 0.6em)
    return sum(size if ord(ch) > 0x2e80 else size * 0.6 for ch in s)


def line_arrow(x1, y1, x2, y2):
    """Straight arrow; the head is an open chevron path at (x2, y2)."""
    out = [f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{INK}" stroke-width="2"/>']
    out.append(chevron(x2, y2, x2 - x1, y2 - y1))
    return '\n'.join(out)


def chevron(x, y, dx, dy, color=INK):
    n = (dx * dx + dy * dy) ** 0.5 or 1
    ux, uy = dx / n, dy / n
    px, py = -uy, ux
    tip = (x + ux * 8, y + uy * 8)
    a = (x - ux * 2 + px * 6, y - uy * 2 + py * 6)
    b = (x - ux * 2 - px * 6, y - uy * 2 - py * 6)
    return (f'<path d="M{a[0]:g},{a[1]:g} L{tip[0]:g},{tip[1]:g} L{b[0]:g},{b[1]:g}" fill="none" '
            f'stroke="{color}" stroke-width="2"/>')


def pill(x, y, s, kind, mono=True):
    bg, fg = PILL[kind]
    w = round(width(s, 13) + 22)
    return (f'<rect x="{x}" y="{y}" width="{w}" height="24" rx="12" fill="{bg}"/>\n'
            + text(x + 10, y + 17, s, 13, fill=fg, font=MONO if mono else SANS))


def animate(attr, kts, vals, cycle):
    kt = ';'.join(f'{k:.6f}' for k in kts)
    vs = ';'.join(f'{v:g}' for v in vals)
    sp = ';'.join([EASE] * (len(kts) - 1))
    return (f'<animate attributeName="{attr}" values="{vs}" keyTimes="{kt}" keySplines="{sp}" '
            f'dur="{cycle:g}s" begin="0s" repeatCount="indefinite" calcMode="spline"/>')


def schedule(n, step_secs):
    """Per step i: the box arrives at i*D and leaves at (i+1)*D - MOVE_SECS."""
    cycle = n * step_secs
    arrive = [i * step_secs / cycle for i in range(n)]
    leave = [((i + 1) * step_secs - MOVE_SECS) / cycle for i in range(n)]
    return cycle, arrive, leave, FADE_SECS / cycle


def focus_box(rects, step_secs):
    n = len(rects)
    cycle, arrive, leave, _ = schedule(n, step_secs)
    kts, frames = [], []
    for i in range(n):
        kts += [arrive[i], leave[i]]
        frames += [rects[i], rects[i]]
    kts.append(1.0)
    frames.append(rects[0])
    x, y, w, h = rects[0]
    out = [f'<rect class="focus" x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="none" '
           f'stroke="{RED}" stroke-width="3">']
    for k, attr in enumerate(('x', 'y', 'width', 'height')):
        out.append(animate(attr, kts, [f[k] for f in frames], cycle))
    out.append('</rect>')
    return '\n'.join(out)


def caption(head, lines, x, y):
    out = [text(0, 0, head, 22, fill=RED, font=SERIF)]
    for j, s in enumerate(lines):
        out.append(text(0, 40 + 30 * j, s, 17))
    return out


def captions(caps, step_secs, x, y, animated):
    """Animated: stacked in one panel, each fading with its step. Static: listed."""
    n = len(caps)
    out = []
    if animated:
        cycle, arrive, leave, fade = schedule(n, step_secs)
        for i, (head, lines) in enumerate(caps):
            if i == 0:   # showing at 0s, so a frame with animation off reads step 1
                kts, vals = [0, leave[0], leave[0] + fade, 1], [1, 1, 0, 0]
            else:
                kts = [0, arrive[i], arrive[i] + fade, leave[i], leave[i] + fade, 1]
                vals = [0, 0, 1, 1, 0, 0]
            out.append(f'<g class="cap" transform="translate({x} {y})" opacity="{vals[0]}">')
            out.append(animate('opacity', kts, vals, cycle))
            out += caption(head, lines, x, y)
            out.append('</g>')
    else:
        for i, (head, lines) in enumerate(caps):
            out.append(f'<g class="cap" transform="translate({x} {y + i * STATIC_PITCH})">')
            out += caption(head, lines, x, y)
            out.append('</g>')
    return '\n'.join(out)


STATIC_PITCH = 120   # one caption block in the static list


def frame(t, body, caps, step_secs, rects, animated):
    W = 1280
    if animated:
        H, panel_h = 640, 150
    else:
        panel_h = 46 + STATIC_PITCH * len(caps)
        H = 456 + panel_h + 34
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img">',
           f'<title>{escape(t["title"])}</title>',
           f'<rect width="{W}" height="{H}" fill="{PAPER}"/>',
           text(40, 70, t['title'], 32, font=SERIF),
           text(40, 104, t['subtitle'] if animated else t.get('subtitle_static', t['subtitle']), 16, fill=MUTED),
           body]
    if animated:
        out.append(focus_box(rects, step_secs))
    out.append(f'<rect x="40" y="456" width="1200" height="{panel_h}" rx="12" fill="{PANEL}"/>')
    out.append(captions(caps, step_secs, 72, 502, animated))
    out.append('</svg>')
    return '\n'.join(out) + '\n'

# ── diagram 1: issue lifecycle ─────────────────────────────────────────────

def lifecycle(lang, animated):
    t = LIFECYCLE[lang]
    steps = t['steps']
    # top row ①–⑤ left to right, bottom row ⑥–⑨ right to left
    pos = [(40, 160), (276, 160), (512, 160), (748, 160), (984, 160),
           (984, 330), (748, 330), (512, 330), (276, 330)]
    CW, CH = 200, 84
    parts = []
    for a, b in zip(pos, pos[1:]):
        if a[1] == b[1] and b[0] > a[0]:
            parts.append(line_arrow(a[0] + CW + 4, a[1] + 42, b[0] - 12, b[1] + 42))
        elif a[1] == b[1]:
            parts.append(line_arrow(a[0] - 4, a[1] + 42, b[0] + CW + 12, b[1] + 42))
        else:
            parts.append(line_arrow(a[0] + 100, a[1] + CH + 6, b[0] + 100, b[1] - 14))
    # dashed bounce ⑥ → ⑤ on the right edge
    parts.append(f'<path d="M1188,360 C1250,330 1250,244 1188,220" fill="none" stroke="{RED}" '
                 f'stroke-width="2" stroke-dasharray="6 5"/>')
    parts.append(f'<path d="M1198,214 L1188,220 L1198,228" fill="none" stroke="{RED}" stroke-width="2"/>')
    parts.append(text(1244, 290, t['bounce'], 13, fill=RED, anchor='end'))
    for i, ((x, y), (title, label, kind, optional, _)) in enumerate(zip(pos, steps)):
        g = [f'<g class="card s{i + 1}" transform="translate({x} {y})">',
             f'<rect width="{CW}" height="{CH}" rx="10" fill="{CARD}" stroke="{LINE}"/>',
             text(14, 32, CIRCLED[i], 24, fill=RED, font=SERIF),
             text(46, 31, title, 17, weight=600),
             pill(14, 46, label or t['none'], kind, mono=label is not None)]
        if optional:
            ow = round(width(t['optional'], 12) + 14)
            # a badge straddling the top edge: the label row has no room for it in English
            g.append(f'<rect x="{CW - ow - 12}" y="-10" width="{ow}" height="20" rx="10" fill="#F6E7C8" '
                     f'stroke="{LINE}"/>')
            g.append(text(CW - ow / 2 - 12, 4, t['optional'], 12, fill='#8A5A12', anchor='middle'))
        g.append('</g>')
        parts.append('\n'.join(g))
    for j, s in enumerate(t['legend']):
        parts.append(text(40, 360 + (24 if j else 0) + max(j - 1, 0) * 19, s, 15 if j == 0 else 13,
                          fill=INK if j == 0 else MUTED, weight=600 if j == 0 else 400))
    # a step with the "optional" badge gets a taller frame so the badge sits inside it
    rects = [(x - 6, y - 16 if st[3] else y - 6, CW + 12, CH + 22 if st[3] else CH + 12)
             for (x, y), st in zip(pos, steps)]
    caps = [(f'{CIRCLED[i]} {title}　·　{t["now"]}：{label or t["none"]}' if lang == 'zh'
             else f'{i + 1}  {title}  ·  {t["now"]}: {label or t["none"]}', lines)
            for i, (title, label, _k, _o, lines) in enumerate(steps)]
    return frame(t, '\n'.join(parts), caps, 3.0, rects, animated)

# ── diagram 2: prompt assembly ─────────────────────────────────────────────

def prompt(lang, animated):
    t = PROMPT[lang]
    parts = []
    for k, (name, sub) in enumerate(t['layers']):
        parts.append('\n'.join([
            f'<g class="card s1" transform="translate(40 {140 + 72 * k})">',
            f'<rect width="280" height="62" rx="8" fill="{CARD}" stroke="{LINE}"/>',
            text(14, 26, name, 16, weight=600), text(14, 48, sub, 13, fill=MUTED), '</g>']))
    parts.append(line_arrow(330, 280, 376, 280))
    parts.append('\n'.join([
        '<g class="card s2" transform="translate(390 220)">',
        f'<rect width="180" height="120" rx="10" fill="{INK}"/>',
        text(90, 52, t['compose'][0], 19, fill=CARD, font=SERIF, anchor='middle'),
        text(90, 82, t['compose'][1], 19, fill=CARD, font=SERIF, anchor='middle'), '</g>']))
    for y in (196, 364):
        c = 196 if y == 196 else 364
        parts.append(f'<path d="M574,280 C610,280 610,{c} 650,{c}" fill="none" stroke="{INK}" stroke-width="2"/>')
        parts.append(f'<path d="M640,{c - 6} L650,{c} L640,{c + 6}" fill="none" stroke="{INK}" stroke-width="2"/>')
    for step, y, (name, sub) in ((3, 161, t['alive']), (4, 329, t['exited'])):
        parts.append('\n'.join([
            f'<g class="card s{step}" transform="translate(656 {y})">',
            f'<rect width="220" height="70" rx="8" fill="{CARD}" stroke="{LINE}"/>',
            text(14, 28, name, 16, weight=600), text(14, 52, sub, 13, fill=MUTED), '</g>']))
        parts.append(line_arrow(882, y + 35, 922, y + 35))
    parts.append(text(940, 150, t['hook_title'], 15, weight=600))
    parts.append('\n'.join([
        '<g class="card s5" transform="translate(940 162)">',
        '<rect width="300" height="32" rx="6" fill="#EDE8DE"/>',
        text(12, 21, t['hook_edit'], 12, font=MONO), '</g>']))
    for k, f in enumerate(t['hook_files']):
        parts.append('\n'.join([
            f'<g class="card s5" transform="translate(940 {206 + 42 * k})">',
            f'<rect width="300" height="32" rx="16" fill="{PILL["agent"][0]}"/>',
            text(14, 21, f, 13, fill=PILL['agent'][1]), '</g>']))
    parts.append('\n'.join([
        '<g class="card s6" transform="translate(940 340)">',
        f'<rect width="300" height="54" rx="8" fill="{INK}"/>',
        text(150, 24, t['hook_out'][0], 14, fill=CARD, anchor='middle'),
        text(150, 44, t['hook_out'][1], 12, fill=LINE, anchor='middle'), '</g>']))
    rects = [(34, 134, 292, 290), (384, 214, 192, 132), (650, 155, 232, 82),
             (650, 323, 232, 82), (934, 156, 312, 170), (934, 334, 312, 66)]
    return frame(t, '\n'.join(parts), t['steps'], 4.0, rects, animated)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', '..', 'docs', 'images')
    os.makedirs(out, exist_ok=True)
    for lang in ('en', 'zh'):
        for name, fn in (('issue-lifecycle', lifecycle), ('prompt-assembly', prompt)):
            for animated, suffix in ((True, ''), (False, '.static')):
                path = os.path.join(out, f'{name}.{lang}{suffix}.svg')
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(fn(lang, animated))


if __name__ == '__main__':
    main()
