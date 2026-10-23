#!/usr/bin/env python3
"""Check the explainer SVGs in a directory behave the way GitHub#76 promised.

Usage: python3 scripts/doc-diagrams/check.py <dir>     exit 0 = all good

It does not look at how the SVG is written; it evaluates the animation the way a
player would. The cycle is cut at the union of every animation's keyTimes; inside
each piece every animation is either constant (discrete, or two equal values) or
moves monotonically between two values (linear, or a spline whose control points
stay within 0..1). So one look at each piece's two end values says exactly which
captions are visible anywhere in it and whether the red box is parked or moving,
however short the piece is. Fixed-interval sampling was the first version and
missed a 0.01 s overlap that fell between two samples (review on PR #77).

Which step the red box is on is decided by geometry: step k's elements carry
class "card s<k>", and a parked box must enclose all of them and no other step's
group. Any authoring that breaks a promise fails:

  - no script / foreignObject / external reference / element id / non-zero begin
  - one shared cycle; every animation repeats forever; discrete / linear / spline only
  - at every instant at most one caption is visible
  - a caption is visible only while the red box is parked on its step, or while
    the box is sliding away from it (the fade-out); never while it slides in
  - the red box visits the steps in order, starting on step 1 at 0 s
  - every step gets its caption shown for a readable stretch
  - the static twin shows the same captions word for word, all at once
  - no host names or URLs anywhere
"""
import os
import re
import sys
import xml.etree.ElementTree as ET

NS = '{http://www.w3.org/2000/svg}'
MIN_VISIBLE = 2.0   # seconds a caption must stay up per cycle
FORBIDDEN_TAGS = {'script', 'foreignObject', 'image', 'use', 'a', 'iframe', 'link'}
DOMAIN = re.compile(r'\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|dev|app|local|lan|internal|cn)\b', re.I)

errors = []


def err(path, msg):
    errors.append(f'{os.path.basename(path)}: {msg}')


def tag(el):
    return el.tag[len(NS):] if el.tag.startswith(NS) else el.tag


def classes(el):
    return (el.get('class') or '').split()


TRANSLATE = re.compile(r'^translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)$')


def floats(text):
    return [float(v) for v in text.split(';')]


def anim_of(el, name):
    for a in el:
        if tag(a) == 'animate' and a.get('attributeName') == name:
            return a
    return None


def span(el, name, f):
    """(value at the start, value at the end) of the piece starting at cycle fraction
    f. f is always one of the parsed keyTimes (or 0), so the comparison is exact."""
    a = anim_of(el, name)
    if a is None:
        v = float(el.get(name, 1 if name == 'opacity' else 0))
        return v, v
    kts, vals = floats(a.get('keyTimes')), floats(a.get('values'))
    i = max(j for j, k in enumerate(kts) if k <= f)
    if i == len(kts) - 1 or a.get('calcMode') == 'discrete':
        return vals[i], vals[i]
    return vals[i], vals[i + 1]


def bbox(groups):
    xs0, ys0, xs1, ys1 = [], [], [], []
    for g in groups:
        tx = ty = 0.0
        if g.get('transform'):
            m = TRANSLATE.match(g.get('transform'))
            if not m:
                return None
            tx, ty = float(m.group(1)), float(m.group(2))
        for r in g.iter(NS + 'rect'):
            x, y = tx + float(r.get('x', 0)), ty + float(r.get('y', 0))
            xs0.append(x); ys0.append(y)
            xs1.append(x + float(r.get('width'))); ys1.append(y + float(r.get('height')))
    return (min(xs0), min(ys0), max(xs1), max(ys1)) if xs0 else None


def encloses(r, b):
    x, y, w, h = r
    return x <= b[0] and y <= b[1] and b[2] <= x + w and b[3] <= y + h


def caption_texts(cap):
    return [''.join(t.itertext()) for t in cap.iter(NS + 'text')]


def check_common(path, raw, root):
    stripped = raw.replace('http://www.w3.org/2000/svg', '')
    if 'http' in stripped or 'url(' in stripped or '@import' in stripped:
        err(path, 'external reference (http / url( / @import)')
    m = DOMAIN.search(stripped)
    if m:
        err(path, f'looks like a host name: {m.group(0)}')
    for el in root.iter():
        if tag(el) in FORBIDDEN_TAGS:
            err(path, f'forbidden element <{tag(el)}>')
        for k in el.attrib:
            if k == 'id' or k.endswith('}id') or 'href' in k:
                err(path, f'forbidden attribute {k} on <{tag(el)}>')
            if k.startswith('on'):
                err(path, f'event handler {k} on <{tag(el)}>')


def check_animated(path, root):
    anims = [a for a in root.iter() if tag(a) in ('animate', 'animateTransform', 'animateMotion', 'set')]
    if not anims:
        err(path, 'no animation at all')
        return None
    durs = {a.get('dur') for a in anims}
    if len(durs) != 1:
        err(path, f'animations do not share one cycle: {sorted(durs)}')
        return None
    cycle = float(durs.pop().rstrip('s'))
    for a in anims:
        name = a.get('attributeName')
        if tag(a) != 'animate':
            err(path, f'<{tag(a)}> is not allowed (only <animate>)')
            return None
        if a.get('begin') not in (None, '0s', '0'):
            err(path, f'animation begins at {a.get("begin")}, not 0s')
        if a.get('repeatCount') != 'indefinite':
            err(path, 'animation does not repeat forever')
        mode = a.get('calcMode', 'linear')
        if mode not in ('discrete', 'linear', 'spline'):
            err(path, f'calcMode {mode} on {name} is not allowed (timing would not follow keyTimes)')
            return None
        try:
            kts, vals = floats(a.get('keyTimes') or ''), floats(a.get('values') or '')
        except ValueError:
            err(path, f'unreadable keyTimes/values on {name}')
            return None
        if not kts or kts[0] != 0 or kts != sorted(kts) or kts[-1] > 1 or len(kts) != len(vals):
            err(path, f'bad keyTimes/values on {name}')
            return None
        if mode == 'spline':
            splines = [s.split() for s in (a.get('keySplines') or '').split(';')]
            if len(splines) != len(kts) - 1 or any(len(c) != 4 or not all(0 <= float(v) <= 1 for v in c)
                                                   for c in splines):
                # a control point outside 0..1 overshoots: the value leaves its two end values
                err(path, f'keySplines on {name} missing or outside 0..1')
                return None
        if name == 'opacity' and not all(0 <= v <= 1 for v in vals):
            err(path, 'opacity outside 0..1')
            return None

    caps = [g for g in root.iter(NS + 'g') if 'cap' in classes(g)]
    focus = [r for r in root.iter(NS + 'rect') if 'focus' in classes(r)]
    if len(focus) != 1:
        err(path, f'expected one red box, found {len(focus)}')
        return None
    focus = focus[0]
    n = len(caps)
    steps = [bbox([g for g in root.iter(NS + 'g') if 'card' in classes(g) and f's{k + 1}' in classes(g)])
             for k in range(n)]
    if not n or None in steps:
        err(path, f'{n} captions, but not every step has its "card s<k>" elements')
        return None

    def step_of(r):
        hit = [k for k, b in enumerate(steps) if encloses(r, b)]
        return hit[0] if len(hit) == 1 else None

    shown = [0.0] * n
    stops = []
    cuts = sorted({0.0, *(k for a in anims for k in floats(a.get('keyTimes')))})
    for f, nxt in zip(cuts, cuts[1:] + [1.0]):
        if nxt <= f:
            continue
        t = f * cycle
        box = [span(focus, a, f) for a in ('x', 'y', 'width', 'height')]
        start, end = tuple(v[0] for v in box), tuple(v[1] for v in box)
        here = step_of(start)
        if here is None:
            err(path, f't={t:.4f}s: red box does not frame exactly one step')
            return None
        parked = start == end
        if not parked and step_of(end) is None:
            err(path, f't={t:.4f}s: red box slides towards something that is not a step')
            return None
        ops = [span(c, 'opacity', f) for c in caps]
        vis = [i for i, o in enumerate(ops) if max(o) > 0]
        if len(vis) > 1:
            err(path, f't={t:.4f}s: captions {[v + 1 for v in vis]} visible at once')
            return None
        if vis and vis[0] != here:
            what = 'is on' if parked else 'is leaving'
            err(path, f't={t:.4f}s: caption {vis[0] + 1} shown while the red box {what} step {here + 1}')
            return None
        if parked:
            if not stops or stops[-1] != here:
                stops.append(here)
            if vis and ops[vis[0]] == (1.0, 1.0):
                shown[here] += (nxt - f) * cycle
    if stops != list(range(n)):
        err(path, f'red box stops at steps {[s + 1 for s in stops]}, expected 1..{n} in order')
    for i, d in enumerate(shown):
        if d < MIN_VISIBLE:
            err(path, f'caption {i + 1} is fully visible only {d:.2f}s per cycle')
    return [caption_texts(c) for c in caps]


def check_static(path, root):
    if any(tag(a).startswith('animate') or tag(a) == 'set' for a in root.iter()):
        err(path, 'static version contains animation')
    caps = [g for g in root.iter(NS + 'g') if 'cap' in classes(g)]
    for i, c in enumerate(caps):
        if c.get('opacity') not in (None, '1'):
            err(path, f'caption {i + 1} is hidden in the static version')
    return [caption_texts(c) for c in caps]


def main():
    d = sys.argv[1]
    files = sorted(f for f in os.listdir(d) if f.endswith('.svg'))
    texts = {}
    for f in files:
        path = os.path.join(d, f)
        raw = open(path, encoding='utf-8').read()
        try:
            root = ET.fromstring(raw)
        except ET.ParseError as e:
            err(path, f'not well-formed XML: {e}')
            continue
        check_common(path, raw, root)
        texts[f] = check_static(path, root) if '.static.' in f else check_animated(path, root)
    for f in files:
        if '.static.' in f:
            continue
        twin = f.replace('.svg', '.static.svg')
        if twin not in texts:
            err(f, f'missing static twin {twin}')
        elif texts[f] is not None and texts[f] != texts[twin]:
            err(f, f'captions differ from {twin}')
    if not files:
        errors.append(f'no SVG in {d}')
    for e in errors:
        print('FAIL', e)
    print(f'{len(files)} files checked, {len(errors)} problems')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
