#!/usr/bin/env python3
"""Check the explainer SVGs in a directory behave the way GitHub#76 promised.

Usage: python3 scripts/doc-diagrams/check.py <dir>     exit 0 = all good

It does not look at how the SVG is written; it evaluates the animation the way a
player would — samples the whole cycle and reads every caption's opacity and the
red box's position at each instant — so any authoring that breaks a promise fails:

  - no script / foreignObject / external reference / element id / non-zero begin
  - one shared cycle; every animation repeats forever and switches discretely
  - at every instant at most one caption is visible
  - while a caption is visible, the red box is on that caption's card
  - every step gets its caption shown for a readable stretch
  - the static twin shows the same captions word for word, all at once
  - no host names or URLs anywhere
"""
import os
import re
import sys
import xml.etree.ElementTree as ET

NS = '{http://www.w3.org/2000/svg}'
SAMPLE = 0.05
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


def value_at(anim, t, cycle):
    """Discrete SMIL: the value of the last keyTime <= t (within the cycle)."""
    f = (t % cycle) / cycle
    kts = [float(k) for k in anim.get('keyTimes').split(';')]
    vals = anim.get('values').split(';')
    cur = vals[0]
    for k, v in zip(kts, vals):
        if k <= f + 1e-9:
            cur = v
    return cur


def attr_at(el, name, t, cycle):
    for a in el:
        if tag(a) == 'animate' and a.get('attributeName') == name:
            return value_at(a, t, cycle)
    return el.get(name)


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
        if tag(a) != 'animate':
            err(path, f'<{tag(a)}> is not allowed (only <animate>)')
        if a.get('begin') not in (None, '0s', '0'):
            err(path, f'animation begins at {a.get("begin")}, not 0s')
        if a.get('repeatCount') != 'indefinite':
            err(path, 'animation does not repeat forever')
        if a.get('calcMode') != 'discrete':
            err(path, 'animation is not discrete (captions could cross-fade)')
        kts = [float(k) for k in (a.get('keyTimes') or '').split(';') if k]
        vals = (a.get('values') or '').split(';')
        if not kts or kts[0] != 0 or kts != sorted(kts) or kts[-1] > 1 or len(kts) != len(vals):
            err(path, f'bad keyTimes/values on {a.get("attributeName")}')
            return None

    cards = [g for g in root.iter(NS + 'g') if 'card' in classes(g)]
    caps = [g for g in root.iter(NS + 'g') if 'cap' in classes(g)]
    focus = [r for r in root.iter(NS + 'rect') if 'focus' in classes(r)]
    if len(focus) != 1:
        err(path, f'expected one red box, found {len(focus)}')
        return None
    if not cards or len(caps) != len(cards):
        err(path, f'{len(cards)} cards but {len(caps)} captions')
        return None
    focus = focus[0]
    card_rects = [g.find(NS + 'rect') for g in cards]

    shown = [0.0] * len(caps)
    focused = set()
    steps = int(round(cycle / SAMPLE))
    for s in range(steps):
        t = s * SAMPLE + SAMPLE / 2   # mid-sample, never exactly on a switch
        vis = [i for i, c in enumerate(caps) if float(attr_at(c, 'opacity', t, cycle) or 1) > 0]
        fx, fy, fw, fh = (float(attr_at(focus, n, t, cycle)) for n in ('x', 'y', 'width', 'height'))
        on = [i for i, r in enumerate(card_rects)
              if fx <= float(r.get('x')) and fy <= float(r.get('y'))
              and float(r.get('x')) + float(r.get('width')) <= fx + fw
              and float(r.get('y')) + float(r.get('height')) <= fy + fh]
        if len(on) != 1:
            err(path, f't={t:.2f}s: red box surrounds {len(on)} cards')
            return None
        focused.add(on[0])
        if len(vis) > 1:
            err(path, f't={t:.2f}s: captions {[v + 1 for v in vis]} visible at once')
            return None
        if vis and vis[0] != on[0]:
            err(path, f't={t:.2f}s: caption {vis[0] + 1} shown while the red box is on card {on[0] + 1}')
            return None
        for v in vis:
            shown[v] += SAMPLE
    for i, d in enumerate(shown):
        if d < MIN_VISIBLE:
            err(path, f'caption {i + 1} is visible only {d:.2f}s per cycle')
    if len(focused) != len(cards):
        err(path, f'red box never visits cards {sorted(set(range(len(cards))) - focused)}')
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
