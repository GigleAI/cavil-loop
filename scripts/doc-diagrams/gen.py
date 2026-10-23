#!/usr/bin/env python3
"""Generate the animated + static explainer diagrams under docs/images/ (GitHub#76).

Usage: python3 scripts/doc-diagrams/gen.py [out_dir]   (default: docs/images)

Every SVG is generated here, never hand-edited: the zh / en copies and the
animated / static variants must say the same thing, and the only way to keep
eight files in step is to render them from one table. tests/doc-diagrams.test.sh
regenerates into a temp dir and diffs, so an edit made straight to an SVG fails.

Constraints the output must keep (GitHub shows a README SVG as a plain <img>):
  - SMIL <animate> only: no <script>, no element ids (so no url(#...) markers —
    arrowheads are drawn as polygons), no external fonts or references
  - one cycle per image; every animation starts at 0s, shares that cycle, and
    switches discretely, so the frame at 0s (or with animation off) is the full
    diagram with the red box on step 1
  - a caption is visible only while the red box sits on its step, with a blank
    gap at both ends of the stay — never two captions at once
The behavioural checks live in check.py.
"""
import os
import sys
from xml.sax.saxutils import escape

STEP_SECS = 3.5   # stay per step; captions are two short lines
GAP_SECS = 0.25   # caption blank at each end of a stay

FONT = ('-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", '
        '"Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", '
        'Helvetica, Arial, sans-serif')
MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

C = {
    'bg': '#ffffff', 'card': '#f6f8fa', 'card_line': '#d0d7de', 'text': '#1f2328',
    'muted': '#59636e', 'pill': '#ddf4ff', 'pill_text': '#0550ae', 'none_pill': '#eaeef2',
    'opt': '#fff8c5', 'opt_text': '#7d4e00', 'red': '#cf222e', 'arrow': '#818b98',
    'cap_bg': '#f6f8fa',
}

# ── content ────────────────────────────────────────────────────────────────
# Each step: (title, label or None, optional?, [caption lines]). Facts were
# checked against the code when GitHub#76 was designed; keep them in sync with
# docs/architecture.md when the workflow changes.

LIFECYCLE = {
    'zh': {
        'none': '无标签', 'optional': '可选', 'notes': '说明', 'loop': '打回（最多 3 轮）',
        'title': '一个 issue 在 cavil-loop 里走一圈',
        'steps': [
            ('你开 issue', None, False,
             ['新 issue 默认就放着，等你决定要不要交给 AI，守护进程不碰。',
              '（项目开了「不打标签也干」的贪心模式时例外。）']),
            ('你打标签', 'pending/agent', False,
             ['给 issue 打上 pending/agent —— 这就是唯一的开关。']),
            ('守护进程巡检', 'pending/agent', False,
             ['本机后台默认每 60 秒（可配置）查一次 GitHub，久没动静会自动放慢。',
              '巡检只调 GitHub 接口，不调模型，不花 token。']),
            ('起 worker', 'doing/agent', False,
             ['建独立的工作目录（git worktree）+ tmux + agent 会话。',
              '先确认它活着才翻 doing/agent；起不来就翻 pending/human 并留言。']),
            ('先发设计方案', 'pending/review', False,
             ['第一次派工不写代码：把方案和要你拍板的选项发成 issue 评论。这一步总会有。',
              '开了复审关卡就翻 pending/review 交复审；没开就直接翻 pending/human，跳到 ⑦。']),
            ('独立复审', 'pending/human', True,
             ['另一个 agent 审方案：不通过就带意见打回（虚线），worker 重写方案。',
              '最多 3 轮（可配置），通过或轮数用完才交给你。']),
            ('你拍板', 'pending/agent', False,
             ['在评论里勾选项或回意见，再把标签改回 pending/agent。',
              '守护进程下一轮巡检时接着派工。']),
            ('开发并开 PR', 'pending/PR', False,
             ['worker 写代码、跑测试，测试绿了才开 PR；issue 转 pending/PR 跟踪。',
              '开了复审关卡时 PR 也先过一轮复审，再交你 review。']),
            ('你合并', 'Done', False,
             ['合并后 PR 标 Done，issue 随 PR 一起关闭。',
              '守护进程自动清理工作目录、tmux 和会话记录。']),
        ],
    },
    'en': {
        'none': 'no label', 'optional': 'optional', 'notes': 'Notes', 'loop': 'bounced (max 3 rounds)',
        'title': 'One issue, once around cavil-loop',
        'steps': [
            ('You open an issue', None, False,
             ['A new issue just sits there until you decide to hand it to the AI;',
              'the daemon leaves it alone (unless the project runs greedy mode).']),
            ('You add the label', 'pending/agent', False,
             ['Labeling the issue pending/agent is the one and only switch.']),
            ('Daemon polls', 'pending/agent', False,
             ['A local background job checks GitHub every 60 s by default (configurable)',
              'and slows down when idle. It only calls GitHub, never a model.']),
            ('Worker starts', 'doing/agent', False,
             ['Own git worktree + tmux + agent session. The label flips to doing/agent',
              'only once it is confirmed alive; if it dies, pending/human + a comment.']),
            ('Design proposal', 'pending/review', False,
             ['Always comes first: no code, the plan and the choices for you go up as a comment.',
              'With a review gate it goes to pending/review; without, straight to pending/human and 7.']),
            ('Independent review', 'pending/human', True,
             ['Another agent reviews the plan; a fail bounces it back (dashed line).',
              'At most 3 rounds (configurable), then it reaches you either way.']),
            ('You decide', 'pending/agent', False,
             ['Tick the options or reply in a comment, then relabel pending/agent.',
              'The next poll picks it up again.']),
            ('Build + open PR', 'pending/PR', False,
             ['The worker writes code and runs tests; the PR opens only once green.',
              'The issue moves to pending/PR; with a review gate the PR is reviewed first.']),
            ('You merge', 'Done', False,
             ['The PR is labeled Done and the issue closes with it.',
              'The daemon cleans up the worktree, tmux and session records.']),
        ],
    },
}

PROMPT = {
    'zh': {
        'notes': '说明', 'title': '一条评论怎么变成 worker 手里的指令',
        'layers': ['通用工作流', '通用公开经验', '项目复盘经验', '项目增量（冲突时为准）'],
        'steps': [
            ('四层拼装', None, False,
             ['按顺序叠四层：cavil-loop 自带的通用工作流和通用公开经验，项目自己的复盘经验和增量要求。',
              '冲突时以最后一层「项目增量」为准；项目也可以整份替换第一层。']),
            ('合成完整提示词', '再填编号、分支、目录', False,
             ['拼成一份完整提示词，再填上编号、分支、工作目录等。',
              '评论原文不拼进来：worker 自己去 GitHub 读，并且只当数据看，不当指令。']),
            ('会话还活着', '粘贴进 tmux + 回车', False,
             ['worker 的 tmux 会话还在：把提示词粘贴进去再回车，接着原来的上下文干。',
              '复审派工不会粘进写代码的那个会话。']),
            ('会话已退出', '按「编号 + 角色」续上', False,
             ['会话退出了但有记录：按「编号 + 角色」续上原来那条对话。',
              '写代码和复审各续各的，互不串台。']),
            ('第一次派工', '新开一条会话', False,
             ['没有可续的对话（或续上后立刻退出）：新开一条会话，',
              '提示词作为启动参数直接传进去。']),
        ],
    },
    'en': {
        'notes': 'Notes', 'title': 'How a comment becomes the worker\'s instructions',
        'layers': ['Base workflow', 'Public lessons', 'Project lessons', 'Project additions (win)'],
        'steps': [
            ('Four layers', None, False,
             ['Stacked in order: the base workflow and public lessons shipped with cavil-loop,',
              'then the project\'s own lessons and additions. The last layer wins on conflict.']),
            ('One full prompt', '+ number, branch, dir', False,
             ['Joined into one prompt, then filled in with issue number, branch, worktree.',
              'Comment text is not pasted in: the worker reads it from GitHub, as data only.']),
            ('Session alive', 'paste into tmux + Enter', False,
             ['The worker\'s tmux session is still up: paste the prompt and press Enter,',
              'keeping the context. A review dispatch never lands in the coding session.']),
            ('Session exited', 'resume by number + role', False,
             ['The session is gone but recorded: resume that conversation by',
              'issue number + role. Coding and review each resume their own.']),
            ('First dispatch', 'start a new session', False,
             ['Nothing to resume (or the resume dies at once): start a new session',
              'with the prompt passed in as its launch argument.']),
        ],
    },
}

# ── drawing helpers ────────────────────────────────────────────────────────

def text(x, y, s, size=15, weight='normal', fill=None, anchor='start', mono=False):
    cls = ' class="m"' if mono else ''
    return (f'<text{cls} x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill or C["text"]}" text-anchor="{anchor}">{escape(s)}</text>')


def arrow(x1, y1, x2, y2, dashed=False, head=True):
    dash = ' stroke-dasharray="6 5"' if dashed else ''
    out = [f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{C["arrow"]}" stroke-width="2"{dash}/>']
    if head:
        out.append(arrowhead(x2, y2, x2 - x1, y2 - y1))
    return '\n'.join(out)


def arrowhead(x, y, dx, dy):
    n = (dx * dx + dy * dy) ** 0.5 or 1
    ux, uy = dx / n, dy / n
    px, py = -uy, ux
    a = (x - ux * 10 + px * 5, y - uy * 10 + py * 5)
    b = (x - ux * 10 - px * 5, y - uy * 10 - py * 5)
    return (f'<polygon points="{x:g},{y:g} {a[0]:.1f},{a[1]:.1f} {b[0]:.1f},{b[1]:.1f}" '
            f'fill="{C["arrow"]}"/>')


def text_width(s, size):
    # rough: CJK ≈ 1em, ASCII ≈ 0.6em (monospace labels are exactly 0.6em)
    return sum(size if ord(ch) > 0x2e80 else size * 0.6 for ch in s)


def card(i, box, title, label, optional, lang_t, extra=''):
    x, y, w, h = box
    out = [f'<g class="card">',
           f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{C["card"]}" '
           f'stroke="{C["card_line"]}" stroke-width="1.5"/>',
           f'<circle cx="{x + 26}" cy="{y + 28}" r="14" fill="{C["text"]}"/>',
           text(x + 26, y + 33, str(i + 1), size=14, weight='bold', fill='#ffffff', anchor='middle'),
           text(x + 50, y + 34, title, size=17, weight='bold')]
    if optional:
        tw = text_width(lang_t['optional'], 12) + 14
        # on the label row, right-aligned: the title row has no room for it in English
        out.append(f'<rect x="{x + w - tw - 14:.0f}" y="{y + 57}" width="{tw:.0f}" height="20" rx="10" '
                   f'fill="{C["opt"]}"/>')
        out.append(text(x + w - tw / 2 - 14, y + 71, lang_t['optional'], size=12, fill=C['opt_text'],
                        anchor='middle'))
    if label is not None or 'none' in lang_t:
        if label is None:
            s, fill, tc, mono = lang_t['none'], C['none_pill'], C['muted'], False
        elif lang_t.get('plain_sub'):   # diagram 2: a short subtitle, not a GitHub label
            out.append(text(x + 20, y + 70, label, size=14, fill=C['muted']))
            out.append(extra)
            out.append('</g>')
            return '\n'.join(o for o in out if o)
        else:
            s, fill, tc, mono = label, C['pill'], C['pill_text'], True
        pw = text_width(s, 13) + 20
        out.append(f'<rect x="{x + 18}" y="{y + 54}" width="{pw:.0f}" height="26" rx="13" fill="{fill}"/>')
        out.append(text(x + 28, y + 72, s, size=13, fill=tc, mono=mono))
    out.append(extra)
    out.append('</g>')
    return '\n'.join(o for o in out if o)


def focus_box(boxes, cycle, animated):
    """The red box. Its x/y/width/height jump to step i at i*STEP_SECS."""
    pad = 6
    rects = [(x - pad, y - pad, w + 2 * pad, h + 2 * pad) for x, y, w, h in boxes]
    x, y, w, h = rects[0]
    out = [f'<rect class="focus" x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="none" '
           f'stroke="{C["red"]}" stroke-width="3.5">']
    if animated:
        kt = ';'.join(f'{i * STEP_SECS / cycle:.6f}' for i in range(len(rects)))
        for k, attr in enumerate(('x', 'y', 'width', 'height')):
            vals = ';'.join(str(r[k]) for r in rects)
            out.append(f'<animate attributeName="{attr}" dur="{cycle:g}s" repeatCount="indefinite" '
                       f'calcMode="discrete" keyTimes="{kt}" values="{vals}"/>')
    out.append('</rect>')
    return '\n'.join(out)


def caption_block(i, title, lines, x, y):
    out = [text(x, y, f'{i + 1}. {title}', size=16, weight='bold')]
    for j, line in enumerate(lines):
        out.append(text(x, y + 26 + j * 24, line, size=15))
    return '\n'.join(out)


def captions_animated(steps, cycle, x, y):
    out = []
    for i, (title, _l, _o, lines) in enumerate(steps):
        on = (i * STEP_SECS + GAP_SECS) / cycle
        off = ((i + 1) * STEP_SECS - GAP_SECS) / cycle
        out.append(f'<g class="cap" opacity="0">')
        out.append(f'<animate attributeName="opacity" dur="{cycle:g}s" repeatCount="indefinite" '
                   f'calcMode="discrete" keyTimes="0;{on:.6f};{off:.6f}" values="0;1;0"/>')
        out.append(caption_block(i, title, lines, x, y))
        out.append('</g>')
    return '\n'.join(out)


def captions_static(steps, x, y):
    out = []
    for i, (title, _l, _o, lines) in enumerate(steps):
        out.append(f'<g class="cap">')
        out.append(caption_block(i, title, lines, x, y))
        out.append('</g>')
        y += 26 + 24 * len(lines) + 18
    return '\n'.join(out), y


def caption_height(steps):
    return max(26 + 24 * len(s[3]) for s in steps) + 40


def static_height(steps):
    return sum(26 + 24 * len(s[3]) + 18 for s in steps) + 40


def svg_doc(w, h, title, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
            f'role="img">\n<title>{escape(title)}</title>\n'
            f'<style>text{{font-family:{FONT}}} text.m{{font-family:{MONO}}}</style>\n'
            f'<rect x="0" y="0" width="{w}" height="{h}" rx="14" fill="{C["bg"]}"/>\n{body}\n</svg>\n')


def notes_panel(lang_t, x, y, w, h):
    return '\n'.join([
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{C["cap_bg"]}" '
        f'stroke="{C["card_line"]}" stroke-width="1"/>',
        text(x + w - 16, y + 22, lang_t['notes'], size=12, fill=C['muted'], anchor='end'),
    ])

# ── diagram 1: issue lifecycle (3×3 snake) ─────────────────────────────────

def lifecycle(lang, animated):
    t = LIFECYCLE[lang]
    steps = t['steps']
    W, CW, CH = 960, 270, 92
    cols, rows = [30, 345, 660], [30, 182, 334]
    order = [(0, 0), (0, 1), (0, 2), (1, 2), (1, 1), (1, 0), (2, 0), (2, 1), (2, 2)]
    boxes = [(cols[c], rows[r], CW, CH) for r, c in order]
    parts = []
    mid = lambda b: (b[0] + b[2] / 2, b[1] + b[3] / 2)
    for a, b in zip(boxes, boxes[1:]):
        (ax, ay), (bx, by) = mid(a), mid(b)
        if ay == by:   # same row
            if bx > ax:
                parts.append(arrow(a[0] + a[2] + 4, ay, b[0] - 6, by))
            else:
                parts.append(arrow(a[0] - 4, ay, b[0] + b[2] + 6, by))
        else:          # down a column
            parts.append(arrow(ax, a[1] + a[3] + 4, bx, b[1] - 6))
    # dashed bounce ⑥ → ⑤, through the gap under row 2
    r6, r5 = boxes[5], boxes[4]
    gy = r6[1] + r6[3] + 30
    x6, x5 = r6[0] + r6[2] - 70, r5[0] + 70
    parts.append(arrow(x6, r6[1] + r6[3] + 4, x6, gy, dashed=True, head=False))
    parts.append(arrow(x6, gy, x5, gy, dashed=True, head=False))
    parts.append(arrow(x5, gy, x5, r5[1] + r5[3] + 6, dashed=True))
    parts.append(text((x6 + x5) / 2, gy - 7, t['loop'], size=12, fill=C['muted'], anchor='middle'))
    for i, (b, (title, label, opt, _)) in enumerate(zip(boxes, steps)):
        parts.append(card(i, b, title, label, opt, t))
    return finish(t, steps, boxes, parts, W, rows[2] + CH, animated)


# ── diagram 2: prompt assembly ─────────────────────────────────────────────

def prompt(lang, animated):
    t = PROMPT[lang]
    steps = t['steps']
    W = 960
    b1 = (30, 30, 270, 312)
    b2 = (350, 140, 250, 92)
    right = [(650, 30 + k * 110, 280, 92) for k in range(3)]
    boxes = [b1, b2] + right
    parts = [arrow(b1[0] + b1[2] + 4, b2[1] + b2[3] / 2, b2[0] - 6, b2[1] + b2[3] / 2)]
    sx, sy = b2[0] + b2[2] + 4, b2[1] + b2[3] / 2
    for r in right:
        parts.append(arrow(sx, sy, r[0] - 6, r[1] + r[3] / 2))
    # layer strips inside card 1, top to bottom = order they are stacked in
    strips = []
    for k, name in enumerate(t['layers']):
        ly = b1[1] + 62 + k * 56
        last = k == len(t['layers']) - 1
        strips.append(f'<rect x="{b1[0] + 18}" y="{ly}" width="{b1[2] - 36}" height="44" rx="8" '
                      f'fill="{C["pill"] if last else "#ffffff"}" stroke="{C["card_line"]}" stroke-width="1"/>')
        strips.append(text(b1[0] + 32, ly + 28, name, size=14,
                           weight='bold' if last else 'normal', fill=C['pill_text'] if last else C['text']))
    nolabel = dict(t, plain_sub=True)   # prompt cards carry a plain subtitle, no label pill
    for i, (b, (title, label, opt, _)) in enumerate(zip(boxes, steps)):
        parts.append(card(i, b, title, label, opt, nolabel, extra='\n'.join(strips) if i == 0 else ''))
    return finish(t, steps, boxes, parts, W, b1[1] + b1[3], animated)


def finish(t, steps, boxes, parts, W, content_bottom, animated):
    py = content_bottom + 40
    if animated:
        cycle = STEP_SECS * len(steps)
        ph = caption_height(steps)
        parts.append(notes_panel(t, 30, py, W - 60, ph))
        parts.append(captions_animated(steps, cycle, 54, py + 34))
        parts.append(focus_box(boxes, cycle, True))
        H = py + ph + 30
    else:
        ph = static_height(steps)
        parts.append(notes_panel(t, 30, py, W - 60, ph))
        body, _ = captions_static(steps, 54, py + 34)
        parts.append(body)
        H = py + ph + 30
    return svg_doc(W, H, t['title'], '\n'.join(parts))


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
