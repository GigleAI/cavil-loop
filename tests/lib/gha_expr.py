#!/usr/bin/env python3
"""Evaluate a workflow's own GitHub Actions expressions, and simulate which jobs of a run run
(GitHub#628: the client workflow's triggers, gates and concurrency are tested by evaluating what the
yml says, never by matching its text).

The expression language, the part workflows here use, with GitHub's semantics
(docs.github.com → "Evaluate expressions in workflows and actions"):
  literals      'string' ('' escapes a quote), numbers, true, false, null
  contexts      github.…, inputs.…, needs.<job>.result / .outputs.…, vars.…; `needs.*.result` is
                the list of every needed job's result; a missing property is null
  operators     ( ) ! && || == != < <= > >=   — && / || return an operand, not a boolean
  functions     always() cancelled() success() failure() contains(a, b) format(s, …)
  equality      strings compare ignoring case; operands of different types are compared as
                numbers (null → 0, true → 1, '' → 0, a non-numeric string → NaN, NaN equals nothing)
  falsy         false, 0, -0, '', null, NaN
A job `if` with no status function is `success() && (if)`; no `if` at all is `success()`.
`${{ … }}` around an expression is optional; a string with several `${{ … }}` in it is
interpolated (the concurrency group).

Anything outside this subset raises: a test must never pass because an expression was misread.

  python3 gha_expr.py simulate <workflow.yml> <scenario.json>
  → {"jobs": {job: "success" | "failure" | "skipped"}, "group": …, "cancel": …}
  scenario: {"github": {...}, "inputs": {...}, "vars": {...}, "cancelled": false,
             "results": {job: "failure", …}   # a job that runs ends with this instead of success
             "outputs": {job: {...}}}          # the outputs a job that runs gives its dependants
"""
import json
import math
import re
import sys

TOKEN = re.compile(r"\s*(?:(?P<str>'(?:[^']|'')*')|(?P<num>-?\d+(?:\.\d+)?)|(?P<op>&&|\|\||==|!=|<=|>=|[()!<>,])|(?P<id>[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:[A-Za-z_*][A-Za-z0-9_-]*|\*))*))")


class ExprError(Exception):
    pass


def tokens(src):
    out, i = [], 0
    while i < len(src):
        if src[i:].strip() == "":
            break
        m = TOKEN.match(src, i)
        if not m or m.end() == i:
            raise ExprError(f"cannot read expression at {src[i:]!r}")
        i = m.end()
        kind = m.lastgroup
        out.append((kind, m.group(kind)))
    return out


def num(v):
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return 0.0
        try:
            return float(s)
        except ValueError:
            return math.nan
    return math.nan


def truthy(v):
    if v is None or v is False or v == "":
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return not (v == 0 or math.isnan(v))
    return True


def equal(a, b):
    if isinstance(a, str) and isinstance(b, str):
        return a.lower() == b.lower()
    if type(a) is type(b) and not isinstance(a, (int, float, str)):
        return a == b
    x, y = num(a), num(b)
    return not math.isnan(x) and not math.isnan(y) and x == y


class Parser:
    def __init__(self, src, ctx):
        self.t = tokens(src)
        self.i = 0
        self.ctx = ctx

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def take(self, want=None):
        k, v = self.peek()
        if k is None or (want is not None and v != want):
            raise ExprError(f"expected {want!r}, got {v!r}")
        self.i += 1
        return k, v

    def parse(self):
        v = self.orx()
        if self.i != len(self.t):
            raise ExprError(f"left over: {self.t[self.i:]}")
        return v

    def orx(self):
        v = self.andx()
        while self.peek()[1] == "||":
            self.take()
            r = self.andx()
            v = v if truthy(v) else r
        return v

    def andx(self):
        v = self.cmp()
        while self.peek()[1] == "&&":
            self.take()
            r = self.cmp()
            v = r if truthy(v) else v
        return v

    def cmp(self):
        v = self.unary()
        while self.peek()[1] in ("==", "!=", "<", "<=", ">", ">="):
            _, op = self.take()
            r = self.unary()
            if op == "==":
                v = equal(v, r)
            elif op == "!=":
                v = not equal(v, r)
            else:
                x, y = num(v), num(r)
                v = {"<": x < y, "<=": x <= y, ">": x > y, ">=": x >= y}[op]
        return v

    def unary(self):
        if self.peek()[1] == "!":
            self.take()
            return not truthy(self.unary())
        return self.atom()

    def atom(self):
        k, v = self.take()
        if v == "(":
            r = self.orx()
            self.take(")")
            return r
        if k == "str":
            return v[1:-1].replace("''", "'")
        if k == "num":
            return float(v)
        if k == "id":
            if v in ("true", "false"):
                return v == "true"
            if v == "null":
                return None
            if self.peek()[1] == "(":
                self.take("(")
                args = []
                if self.peek()[1] != ")":
                    args.append(self.orx())
                    while self.peek()[1] == ",":
                        self.take()
                        args.append(self.orx())
                self.take(")")
                return self.call(v, args)
            return self.lookup(v)
        raise ExprError(f"unexpected {v!r}")

    def call(self, name, args):
        c = self.ctx
        if name == "always":
            return True
        if name == "cancelled":
            return bool(c.get("cancelled"))
        if name == "success":
            return not c.get("cancelled") and all(n.get("result") == "success" for n in c.get("needs", {}).values())
        if name == "failure":
            return any(n.get("result") == "failure" for n in c.get("needs", {}).values())
        if name == "contains":
            hay, needle = args
            if isinstance(hay, list):
                return any(equal(x, needle) for x in hay)
            if isinstance(hay, str):
                return str(needle).lower() in hay.lower()
            return False
        if name == "format":
            s, rest = args[0], args[1:]
            return re.sub(r"\{(\d+)\}", lambda m: "" if rest[int(m.group(1))] is None else str(rest[int(m.group(1))]), s)
        raise ExprError(f"unknown function {name}()")

    def lookup(self, path):
        parts = path.split(".")
        if parts[0] not in ("github", "inputs", "needs", "vars", "env"):
            raise ExprError(f"unknown context {parts[0]}")
        cur = [self.ctx.get(parts[0], {})]
        star = False
        for p in parts[1:]:
            nxt = []
            for x in cur:
                if p == "*":
                    star = True
                    nxt.extend(x.values() if isinstance(x, dict) else [])
                else:
                    nxt.append(x.get(p) if isinstance(x, dict) else None)
            cur = nxt
        return cur if star else cur[0]


def strip(expr):
    s = str(expr).strip()
    m = re.fullmatch(r"\$\{\{(.*)\}\}", s, re.S)
    return m.group(1) if m and "${{" not in m.group(1) else s


def evaluate(expr, ctx):
    return Parser(strip(expr), ctx).parse()


def interpolate(s, ctx):
    def one(m):
        v = evaluate(m.group(1), ctx)
        if v is None:
            return ""
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, float) and v.is_integer():
            return str(int(v))
        return str(v)
    return re.sub(r"\$\{\{(.*?)\}\}", one, str(s))


def value(v, ctx):
    """A yml value that may be a plain value, one expression, or a string with expressions in it."""
    if isinstance(v, bool) or v is None:
        return v
    s = str(v)
    if re.fullmatch(r"\s*\$\{\{(.*?)\}\}\s*", s):
        return evaluate(s, ctx)
    return interpolate(s, ctx) if "${{" in s else v


STATUS = re.compile(r"\b(always|cancelled|success|failure)\s*\(")


def job_if(cond, ctx):
    if cond is None:
        return Parser("success()", ctx).parse()
    src = strip(cond)
    if not STATUS.search(src):
        src = f"success() && ({src})"
    return truthy(Parser(src, ctx).parse())


def simulate(wf, sc):
    jobs = wf["jobs"]
    base = {"github": sc.get("github", {}), "inputs": sc.get("inputs", {}), "vars": sc.get("vars", {}), "env": {}}
    results, outputs, left = {}, {}, list(jobs)
    while left:
        progressed = False
        for jn in list(left):
            needs = jobs[jn].get("needs", [])
            needs = [needs] if isinstance(needs, str) else needs
            if any(n not in results for n in needs):
                continue
            ctx = dict(base, cancelled=sc.get("cancelled", False),
                       needs={n: {"result": results[n], "outputs": outputs.get(n, {})} for n in needs})
            if job_if(jobs[jn].get("if"), ctx):
                results[jn] = sc.get("results", {}).get(jn, "success")
                outputs[jn] = sc.get("outputs", {}).get(jn, {}) if results[jn] == "success" else {}
            else:
                results[jn] = "skipped"
                outputs[jn] = {}
            left.remove(jn)
            progressed = True
        if not progressed:
            raise ExprError(f"jobs whose needs never resolve: {left}")
    conc = wf.get("concurrency") or {}
    ctx = dict(base, cancelled=False, needs={})
    return {"jobs": results, "group": value(conc.get("group"), ctx), "cancel": value(conc.get("cancel-in-progress"), ctx)}


def main():
    import yaml
    if sys.argv[1:2] == ["simulate"]:
        wf = yaml.safe_load(open(sys.argv[2]))
        sc = json.load(open(sys.argv[3]))
        print(json.dumps(simulate(wf, sc), sort_keys=True))
    elif sys.argv[1:2] == ["eval"]:
        print(json.dumps(evaluate(sys.argv[2], json.loads(sys.argv[3]))))
    else:
        sys.exit("usage: gha_expr.py simulate <workflow.yml> <scenario.json> | eval <expr> <ctx json>")


if __name__ == "__main__":
    main()
