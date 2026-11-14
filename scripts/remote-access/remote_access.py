#!/usr/bin/env python3
"""远程入口（GitHub#387）：让配对过的桌面客户端经 Tailscale 看这台机器上的 daemon。

只用标准库。由 scripts/remote-access.sh 调用，不直接给人用：

    remote_access.py serve     --state DIR --port N --skill DIR   常驻服务（只监听 127.0.0.1）
    remote_access.py pair-code --state DIR                        生成一个配对码，打印到 stdout
    remote_access.py list      --state DIR                        列出已配对设备
    remote_access.py revoke    --state DIR --target <设备名或编号>          撤销一台设备

这台机器对外只经 `tailscale serve`（HTTPS，仅本 Tailscale 网络）把请求转给本服务。规则：

  · 每个请求先过「来访者是不是 Tailscale 设备」：转发层给的来访地址必须是一个 Tailscale 地址，
    且本机 `tailscale whois` 查得到它是谁；带公网入口标记、查不到、查询失败，一律拒绝——
    「查不到」绝不当成「匿名但放行」。
  · 配对：一次性 8 位配对码（10 分钟、错 5 次作废）换一把随机长钥匙。钥匙只在这一次传回。
  · 之后的每个请求带签名（时间 + 一次性随机数 + 请求内容），回复也带签名；钥匙不再传输。
    处理过的请求记在盘上，服务重启后重放同一个请求照样被拒。
    设备的 Tailscale 身份必须等于配对时记下的那台。
  · 能做的只有固定几件事：读状态（scripts/install-status.sh 原样）、停 / 启一个项目
    （scripts/project-service.sh）、读一个项目轮询日志的最后 200 行、读 / 改一个项目的常用配置
    （scripts/project-config.sh，GitHub#530：只有它登记为可改的那几项）、撤销本设备。

状态目录（权限 700，文件 600）：devices.json 已配对设备；pairing.json 当前配对码（只存散列）；
nonces.json 最近处理过的请求（防重放，重启后仍然认得）。
"""
import argparse
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 1
PAIR_TTL = 600          # 配对码有效期（秒）
PAIR_MAX_TRIES = 5      # 连续输错这么多次，当前配对码作废
CLOCK_WINDOW = 120      # 请求时间与本机相差超过它就拒绝
BODY_LIMIT = 64 * 1024
LOG_LINES = 200
LOG_TAIL_BYTES = 512 * 1024
TAILSCALE_NETS = (ipaddress.ip_network("100.64.0.0/10"), ipaddress.ip_network("fd7a:115c:a1e0::/48"))
KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
# 改配置的请求体（GitHub#530）。和客户端后端 daemon_config.rs 的 valid_setting / valid_value / valid_rev
# 是同一条规则，两边用同一张样例表对拍（tests/fixtures/config-request-shapes.json）。
SETTING_RE = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
VALUE_RE = re.compile(r"[A-Za-z0-9._:/@,+-]{0,200}")
REV_RE = re.compile(r"[0-9a-f]{64}")
CONFIG_MAX_VALUES = 64
T_CONFIG_GET = 60       # 项目配置脚本 get 的时限（秒）
T_CONFIG_SET = 120      # set：等另一个保存的锁最多 15 秒，再加载配置几次


def config_request_problem(rev, values):
    """保存请求体的形状对不对。→ None，或给人看的原因（这时读、写脚本都不调用）。"""
    if not isinstance(rev, str) or not REV_RE.fullmatch(rev):
        return "指纹不合规：先重新读取配置"
    if not isinstance(values, dict) or not 0 < len(values) <= CONFIG_MAX_VALUES:
        return "没有要改的配置项"
    for name, v in values.items():
        if not isinstance(name, str) or not SETTING_RE.fullmatch(name):
            return "配置项的名字不合规"
        if not isinstance(v, str):
            return "%s 的值不是文本" % name
        if not VALUE_RE.fullmatch(v):
            return "%s 的值里有不能写进配置文件的字符" % name
    return None


# ── 状态文件 ──

class State:
    def __init__(self, root):
        self.root = root
        os.makedirs(root, mode=0o700, exist_ok=True)
        os.chmod(root, 0o700)

    def _path(self, name):
        return os.path.join(self.root, name)

    def lock(self):
        f = open(self._path("lock"), "a+")
        fcntl.flock(f, fcntl.LOCK_EX)
        return f

    def read(self, name, default):
        """读不到文件 = 默认值；文件在但读不懂 = 抛错（不把坏文件当成「没有设备」）。"""
        try:
            with open(self._path(name), encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return default

    def write(self, name, value):
        tmp = self._path(name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, indent=1)
            f.write("\n")
        os.replace(tmp, self._path(name))

    def remove(self, name):
        try:
            os.remove(self._path(name))
        except FileNotFoundError:
            pass

    def devices(self):
        d = self.read("devices.json", [])
        if not isinstance(d, list):
            raise ValueError("devices.json 不是列表")
        return d


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def new_pair_code(state):
    """→ (配对码, 失效时刻)。新码顶替旧码：同一时刻只有一个码能用。"""
    code = "".join(secrets.choice("0123456789") for _ in range(8))
    expires = int(time.time()) + PAIR_TTL
    with state.lock():
        state.write("pairing.json", {"hash": sha256_hex(code.encode()), "expires": expires, "tries": 0})
    return code, expires


def cancel_pair_code(state):
    """作废等待中的配对码（没有也算成功：结果都是「现在没有能用的码」）。"""
    with state.lock():
        state.remove("pairing.json")


def redeem_pair_code(state, code, node, node_name, name):
    """→ (device, None) 或 (None, (http 状态, 错误码, 给人看的话))。"""
    with state.lock():
        p = state.read("pairing.json", None)
        if not isinstance(p, dict) or "hash" not in p:
            return None, (403, "pairing_closed", "这台机器现在没有等待中的配对码，请在这台机器上重新生成一个")
        if time.time() > float(p.get("expires", 0)):
            state.remove("pairing.json")
            return None, (403, "pairing_expired", "配对码已过期，请在那台机器上重新生成一个")
        if not hmac.compare_digest(str(p["hash"]), sha256_hex(code.encode())):
            tries = int(p.get("tries", 0)) + 1
            if tries >= PAIR_MAX_TRIES:
                state.remove("pairing.json")
                return None, (403, "pairing_locked", "配对码连续输错 %d 次，已作废，请在那台机器上重新生成一个" % PAIR_MAX_TRIES)
            p["tries"] = tries
            state.write("pairing.json", p)
            return None, (403, "pairing_wrong", "配对码不对")
        state.remove("pairing.json")
        devices = state.devices()
        dev = {
            "id": secrets.token_hex(8),
            "name": name or node_name,
            "node": node,
            "node_name": node_name,
            "key": secrets.token_hex(32),
            "paired_at": int(time.time()),
        }
        devices.append(dev)
        state.write("devices.json", devices)
        return dev, None


def revoke(state, which):
    """按编号或名字撤销。→ 被撤销的设备列表（名字重复时全部撤销）。"""
    with state.lock():
        devices = state.devices()
        gone = [d for d in devices if which in (d.get("id"), d.get("name"), d.get("node_name"))]
        if gone:
            state.write("devices.json", [d for d in devices if d not in gone])
        return gone


# ── 来访者是谁 ──

def tailscale_address(text):
    """转发层给的来访地址：恰好一个、且在 Tailscale 地址段内才算数。"""
    if not text or "," in text:
        return None
    try:
        ip = ipaddress.ip_address(text.strip())
    except ValueError:
        return None
    return str(ip) if any(ip in n for n in TAILSCALE_NETS) else None


def whois(ip):
    """→ (设备的稳定编号, 设备名) 或 None（查不到 / 查询失败 / 输出认不出）。"""
    try:
        out = subprocess.run(["tailscale", "whois", "--json", ip], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    try:
        node = json.loads(out.stdout).get("Node") or {}
    except (ValueError, AttributeError):
        return None
    sid = node.get("StableID")
    if not isinstance(sid, str) or not sid:
        return None
    name = node.get("ComputedName") or node.get("Name") or sid
    return sid, str(name).rstrip(".")[:64]


# ── 服务 ──

class Service:
    def __init__(self, state, skill):
        self.state = state
        self.skill = skill
        self.mu = threading.Lock()
        # 已处理过的请求（设备编号:随机数 → 处理时间），落盘在 nonces.json，重启后照样认得。
        # 一个请求只在「它的时间与本机相差不超过 CLOCK_WINDOW」时被接受，所以处理过的记录留
        # 2 × CLOCK_WINDOW 就够：再晚，同一个请求会先被时间那一关拒掉。
        # 文件在但读不懂时不知道刚才处理过什么：这段时间里一律不接受签名请求（quarantine），
        # 等到重启前可能处理过的请求全都过了时间那一关为止——不把「读不到」当成「没处理过」。
        self.quarantine_until = 0.0
        try:
            saved = state.read("nonces.json", {})
            if not isinstance(saved, dict) or not all(isinstance(v, (int, float)) for v in saved.values()):
                raise ValueError("nonces.json 的内容不是「随机数 → 时间」")
            self.nonces = {str(k): float(v) for k, v in saved.items()}
        except (ValueError, OSError) as e:
            sys.stderr.write("读不懂已处理请求的记录（%s）：%d 秒内不接受签名请求\n" % (e, 2 * CLOCK_WINDOW))
            self.nonces = {}
            self.quarantine_until = time.time() + 2 * CLOCK_WINDOW

    def script(self, name, args, timeout, input_text=None):
        path = os.path.join(self.skill, "scripts", name)
        feed = {"stdin": subprocess.DEVNULL} if input_text is None else {"input": input_text}
        try:
            return subprocess.run(["bash", path, *args], capture_output=True, text=True, timeout=timeout, **feed)
        except subprocess.TimeoutExpired:
            return subprocess.CompletedProcess([], 124, "", "%s 超过 %d 秒没有结束" % (name, timeout))
        except OSError as e:
            return subprocess.CompletedProcess([], 127, "", "%s 没能启动：%s" % (name, e))

    def status(self):
        """→ (状态对象, None) 或 (None, 原因)。只认 version = 1 且带 projects 列表的输出。"""
        out = self.script("install-status.sh", [], 90)
        if out.returncode != 0:
            return None, "状态脚本退出码 %s：%s" % (out.returncode, (out.stderr or out.stdout).strip()[-2000:])
        try:
            st = json.loads(out.stdout)
        except ValueError as e:
            return None, "状态脚本输出的不是 JSON（%s）" % e
        if not isinstance(st, dict) or st.get("version") != 1 or not isinstance(st.get("projects"), list):
            return None, "状态脚本输出的格式认不出"
        return st, None

    def config_read(self, key):
        """项目配置脚本的 get。→ ("ok", 它的 JSON) 或 (结果词, 给人看的原因)。
        结果词只有 ok / not_found / unreadable：读不懂的输出一律是 unreadable，绝不当成「什么都没设」。"""
        out = self.script("project-config.sh", ["get", key], T_CONFIG_GET)
        try:
            v = json.loads(out.stdout)
        except ValueError:
            text = ((out.stdout or "") + (out.stderr or "")).strip()
            return "unreadable", "读不到这个项目的配置：%s" % (text[-2000:] or "脚本没有输出")
        if not isinstance(v, dict) or v.get("version") != 1:
            return "unreadable", "配置脚本输出的格式认不出"
        state = v.get("state")
        if state == "ok" and out.returncode == 0 and isinstance(v.get("fields"), list) and isinstance(v.get("rev"), str):
            return "ok", v
        if state == "not_found":
            return "not_found", str(v.get("reason") or "那台机器上没有接入这个项目")
        return "unreadable", str(v.get("reason") or (out.stderr or "").strip()[-2000:] or "配置读不出")

    def config_save(self, key, rev, values):
        """→ 回复对象。先核对请求体、再读一次配置只放行此刻可改的项，最后才调用 set。"""
        why = config_request_problem(rev, values)
        if why:
            return {"result": "refused", "output": why}
        word, now = self.config_read(key)
        if word != "ok":
            return {"result": "refused", "output": "保存前重新读取配置失败，没有保存：%s" % now}
        editable = {f.get("name") for f in now["fields"] if isinstance(f, dict) and f.get("mode") == "edit" and f.get("editable") is True}
        for name in values:
            if name not in editable:
                return {"result": "refused", "output": "%s 不是能在这里改的配置项，没有保存" % name}
        out = self.script("project-config.sh", ["set", key, "--rev", rev], T_CONFIG_SET, json.dumps(values))
        lines = [l for l in (out.stdout or "").splitlines() if l.strip()]
        text = ((out.stdout or "") + (out.stderr or "")).strip()
        m = re.fullmatch(r"RESULT=(\w+)", lines[-1]) if lines else None
        detail = {}
        for l in reversed(lines):
            if l.startswith("DETAIL="):
                try:
                    d = json.loads(l[len("DETAIL="):])
                except ValueError:
                    d = None
                detail = d if isinstance(d, dict) else {}
                break
        shown = "\n".join(l for l in text.splitlines() if not re.match(r"^(RESULT|DETAIL)=", l)).strip()
        if m is None:
            # 没有最终结果（被杀、超时、半途失败）：改没改不知道，不往脚本自己的词上靠
            return {"result": "unconfirmed", "detail": detail, "output": "配置脚本没有给出最终结果（退出码 %s），配置文件可能已经改了、也可能没改：\n%s" % (out.returncode, shown[-20000:])}
        return {"result": m.group(1), "detail": detail, "output": shown[-20000:]}

    def fresh_nonce(self, device_id, nonce, now):
        """这个请求没处理过 → 先记下（落盘）再返回 "new"；处理过 → "seen"；记不下来 → "unsaved"（不处理）。"""
        key = "%s:%s" % (device_id, nonce)
        with self.mu:
            if key in self.nonces:
                return "seen"
            kept = {k: t for k, t in self.nonces.items() if now - t <= 2 * CLOCK_WINDOW}
            kept[key] = now
            try:
                self.state.write("nonces.json", kept)
            except OSError:
                return "unsaved"
            self.nonces = kept
            return "new"


def request_signature(key_hex, method, path, when, nonce, body):
    msg = "\n".join([method, path, when, nonce, sha256_hex(body)]).encode()
    return hmac.new(bytes.fromhex(key_hex), msg, hashlib.sha256).hexdigest()


def response_signature(key_hex, nonce, status, body):
    msg = "\n".join(["resp", nonce, str(status), sha256_hex(body)]).encode()
    return hmac.new(bytes.fromhex(key_hex), msg, hashlib.sha256).hexdigest()


class Handler(BaseHTTPRequestHandler):
    server_version = "cavil-loop-remote"
    protocol_version = "HTTP/1.1"
    svc = None  # 由 serve() 填

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), fmt % args))

    def reply(self, status, obj, device=None, nonce=""):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if device is not None:
            self.send_header("X-Cavil-Signature", response_signature(device["key"], nonce, status, body))
        self.end_headers()
        self.wfile.write(body)

    def deny(self, status, code, message, device=None, nonce=""):
        self.reply(status, {"error": code, "message": message}, device, nonce)

    def visitor(self):
        """来访者的 Tailscale 身份；不是就已经回了拒绝，返回 None。"""
        if self.headers.get("Tailscale-Funnel-Request") is not None:
            self.deny(403, "funnel", "这个入口不接受经公网入口进来的请求")
            return None
        ip = tailscale_address(self.headers.get("X-Forwarded-For"))
        if ip is None:
            self.deny(403, "not_tailscale", "来访地址不是 Tailscale 地址")
            return None
        who = whois(ip)
        if who is None:
            self.deny(403, "unknown_device", "本机 Tailscale 查不到来访设备是谁")
            return None
        return who

    def body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n < 0 or n > BODY_LIMIT:
            self.deny(400, "bad_request", "请求体长度不对")
            return None
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def handle_any(self, method):
        try:
            self.route(method)
        except Exception as e:  # 任何没料到的错都按「服务端出错」回，不让连接悬着
            try:
                self.deny(500, "internal", "远程入口内部出错：%s" % e)
            except Exception:
                pass

    def route(self, method):
        path = self.path.split("?", 1)[0]
        if method == "GET" and path == "/v1/hello":
            return self.reply(200, {"service": "cavil-loop-remote", "version": VERSION})
        who = self.visitor()
        if who is None:
            return
        node, node_name = who
        body = self.body()
        if body is None:
            return
        if method == "POST" and path == "/v1/pair":
            return self.pair(body, node, node_name)
        device, nonce = self.signed(method, path, body, node)
        if device is None:
            return
        svc = self.svc
        if method == "GET" and path == "/v1/status":
            st, why = svc.status()
            if st is None:
                return self.deny(502, "status_failed", why, device, nonce)
            return self.reply(200, {"status": st}, device, nonce)
        m = re.match(r"^/v1/projects/([^/]+)/(stop|start|log|config)$", path)
        if m and KEY_RE.match(m.group(1)):
            key, what = m.group(1), m.group(2)
            if what == "log" and method == "GET":
                return self.log(key, device, nonce)
            if what == "config" and method == "GET":
                word, v = svc.config_read(key)
                return self.reply(200, {"result": "ok", "config": v} if word == "ok" else {"result": word, "output": v}, device, nonce)
            if what == "config" and method == "POST":
                try:
                    req = json.loads(body or b"{}")
                except ValueError:
                    req = None
                if not isinstance(req, dict):
                    return self.reply(200, {"result": "refused", "output": "请求体不是 JSON 对象"}, device, nonce)
                return self.reply(200, svc.config_save(key, req.get("rev"), req.get("values")), device, nonce)
            if what in ("stop", "start") and method == "POST":
                return self.service(key, what, device, nonce)
        if method == "POST" and path == "/v1/unpair":
            # 先撤销，再用还在手里的钥匙给回复签名：对面凭签名确认「确实撤销了」
            gone = revoke(svc.state, device["id"])
            return self.reply(200, {"result": "revoked" if gone else "absent"}, device, nonce)
        return self.deny(404, "not_found", "没有这个请求", device, nonce)

    def pair(self, body, node, node_name):
        try:
            req = json.loads(body or b"{}")
            code = re.sub(r"\s+", "", str(req.get("code", "")))
            name = str(req.get("name", "")).strip()
        except (ValueError, AttributeError):
            return self.deny(400, "bad_request", "请求体不是 JSON 对象")
        name = "".join(c for c in name if c.isprintable())[:64]
        dev, err = redeem_pair_code(self.svc.state, code, node, node_name, name)
        if err:
            return self.deny(*err)
        self.reply(200, {"version": VERSION, "id": dev["id"], "key": dev["key"], "name": dev["name"]})

    def signed(self, method, path, body, node):
        """核对签名。→ (设备, 随机数)；不过就已经回了拒绝，返回 (None, "")。"""
        h = self.headers
        dev_id, when, nonce, sig = (h.get("X-Cavil-Device") or "", h.get("X-Cavil-Time") or "", h.get("X-Cavil-Nonce") or "", h.get("X-Cavil-Signature") or "")
        device = next((d for d in self.svc.state.devices() if d.get("id") == dev_id), None)
        if device is None:
            self.deny(401, "revoked", "这台设备没有配对，或配对已被撤销")
            return None, ""
        if device.get("node") != node:
            self.deny(403, "device_mismatch", "来访设备不是配对时的那一台")
            return None, ""
        if not re.fullmatch(r"[0-9a-f]{16,64}", nonce) or not when.isdigit():
            self.deny(400, "bad_request", "签名字段不全")
            return None, ""
        if not hmac.compare_digest(request_signature(device["key"], method, path, when, nonce, body), sig):
            self.deny(403, "signature", "签名不对")
            return None, ""
        now = time.time()
        if now < self.svc.quarantine_until:
            self.deny(503, "not_ready", "这台机器的远程入口刚重启、读不到之前处理过哪些请求，约 %d 秒后恢复" % (int(self.svc.quarantine_until - now) + 1), device, nonce)
            return None, ""
        if abs(now - int(when)) > CLOCK_WINDOW:
            self.deny(403, "clock", "请求时间和这台机器相差太多（这台机器现在是 %s）" % time.strftime("%Y-%m-%d %H:%M:%S %z"), device, nonce)
            return None, ""
        fresh = self.svc.fresh_nonce(device["id"], nonce, now)
        if fresh == "seen":
            self.deny(403, "replay", "这个请求已经处理过一次")
            return None, ""
        if fresh != "new":
            self.deny(503, "not_ready", "这台机器记不下已处理的请求（状态目录写不进去），没有执行", device, nonce)
            return None, ""
        return device, nonce

    def service(self, key, action, device, nonce):
        out = self.svc.script("project-service.sh", [key, action], 120)
        text = (out.stdout or "") + (out.stderr or "")
        result = (re.findall(r"^RESULT=(\w+)$", text, re.M) or ["failed"])[-1]
        state = (re.findall(r"^STATE=(\w+)$", text, re.M) or ["unknown"])[-1]
        shown = "\n".join(l for l in text.splitlines() if not re.match(r"^(RESULT|STATE)=", l)).strip()
        self.reply(200, {"result": result, "state": state, "output": shown[-20000:]}, device, nonce)

    def log(self, key, device, nonce):
        st, why = self.svc.status()
        if st is None:
            return self.deny(502, "status_failed", why, device, nonce)
        proj = next((p for p in st["projects"] if p.get("key") == key), None)
        if proj is None:
            return self.deny(404, "no_project", "那台机器上没有接入项目 %s" % key, device, nonce)
        state_dir = proj.get("state_dir")
        if not isinstance(state_dir, str) or not state_dir:
            return self.deny(502, "no_log", "读不出 %s 的状态目录（项目配置读不出）" % key, device, nonce)
        path = os.path.join(state_dir, "poll.log")
        try:
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - LOG_TAIL_BYTES))
                data = f.read()
        except FileNotFoundError:
            return self.reply(200, {"path": path, "exists": False, "text": ""}, device, nonce)
        except OSError as e:
            return self.deny(502, "no_log", "读不了 %s：%s" % (path, e), device, nonce)
        lines = data.decode("utf-8", "replace").splitlines()
        self.reply(200, {"path": path, "exists": True, "text": "\n".join(lines[-LOG_LINES:])}, device, nonce)


def serve(state, port, skill):
    Handler.svc = Service(state, skill)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    sys.stderr.write("cavil-loop 远程入口：监听 127.0.0.1:%d\n" % httpd.server_address[1])
    sys.stderr.flush()
    httpd.serve_forever()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["serve", "pair-code", "pair-cancel", "list", "revoke"])
    ap.add_argument("--expiry", action="store_true", help="pair-code：第二行给出失效时刻（秒）")
    ap.add_argument("--target", default="")
    ap.add_argument("--state", required=True)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--skill", default="")
    a = ap.parse_args()
    state = State(a.state)
    if a.command in ("list", "revoke"):
        try:
            state.devices()
        except (ValueError, OSError) as e:   # 读不懂 ≠ 没有设备
            sys.stderr.write("读不懂已配对设备清单：%s\n" % e)
            sys.exit(2)
    if a.command == "serve":
        if not a.skill:
            ap.error("serve 需要 --skill")
        serve(state, a.port, a.skill)
    elif a.command == "pair-code":
        code, expires = new_pair_code(state)
        print(code)
        if a.expiry:
            print(expires)
    elif a.command == "pair-cancel":
        cancel_pair_code(state)
    elif a.command == "list":
        for d in state.devices():
            print("%s\t%s\t%s\t%s" % (d.get("id"), d.get("name"), d.get("node_name"), time.strftime("%Y-%m-%d %H:%M", time.localtime(d.get("paired_at", 0)))))
    elif a.command == "revoke":
        if not a.target:
            ap.error("revoke 需要设备名或编号")
        gone = revoke(state, a.target)
        for d in gone:
            print("%s\t%s" % (d.get("id"), d.get("name")))
        sys.exit(0 if gone else 1)


if __name__ == "__main__":
    main()
