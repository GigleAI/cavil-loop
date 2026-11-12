#!/usr/bin/env python3
"""远程入口的参考客户端（GitHub#387），只给测试用。

照 docs/operations.md「远程入口」一节的协议说明独立写成，**不 import 服务端的代码**——
它是服务端签名规则的对拍方。直接连 127.0.0.1:<端口>，自己扮演转发层（加来访地址头）。

    client.py --port P [--xff IP | --no-xff] [--funnel] pair <配对码> [设备名]
    client.py --port P [...] call <GET|POST> <路径> --id ID --key KEY
                [--time T] [--nonce N] [--bad-sig] [--body 文本]

输出一行 JSON：{status, body, signed}。signed = 回复的签名用这把钥匙验得过。
"""
import argparse, hashlib, hmac, http.client, json, secrets, sys, time

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--xff", default="100.64.0.7")
ap.add_argument("--no-xff", action="store_true")
ap.add_argument("--funnel", action="store_true")
sub = ap.add_subparsers(dest="cmd", required=True)
p = sub.add_parser("pair"); p.add_argument("code"); p.add_argument("name", nargs="?", default="test-mac")
c = sub.add_parser("call"); c.add_argument("method"); c.add_argument("path")
c.add_argument("--id", required=True); c.add_argument("--key", required=True)
c.add_argument("--time"); c.add_argument("--nonce"); c.add_argument("--bad-sig", action="store_true"); c.add_argument("--body", default="")
a = ap.parse_args()

headers = {}
if not a.no_xff:
    headers["X-Forwarded-For"] = a.xff
if a.funnel:
    headers["Tailscale-Funnel-Request"] = "?1"

def sha(b): return hashlib.sha256(b).hexdigest()

if a.cmd == "pair":
    method, path, body, key, nonce = "POST", "/v1/pair", json.dumps({"code": a.code, "name": a.name}).encode(), None, ""
else:
    method, path, body, key = a.method, a.path, a.body.encode(), a.key
    when = a.time or str(int(time.time())); nonce = a.nonce or secrets.token_hex(16)
    sig = hmac.new(bytes.fromhex(key), "\n".join([method, path, when, nonce, sha(body)]).encode(), hashlib.sha256).hexdigest()
    if a.bad_sig:
        sig = sig[:-1] + ("0" if sig[-1] != "0" else "1")
    headers.update({"X-Cavil-Device": a.id, "X-Cavil-Time": when, "X-Cavil-Nonce": nonce, "X-Cavil-Signature": sig})

conn = http.client.HTTPConnection("127.0.0.1", a.port, timeout=150)
conn.request(method, path, body=body or None, headers=headers)
r = conn.getresponse(); raw = r.read()
signed = False
if key and r.getheader("X-Cavil-Signature"):
    want = hmac.new(bytes.fromhex(key), "\n".join(["resp", nonce, str(r.status), sha(raw)]).encode(), hashlib.sha256).hexdigest()
    signed = hmac.compare_digest(want, r.getheader("X-Cavil-Signature"))
try:
    parsed = json.loads(raw)
except ValueError:
    parsed = raw.decode("utf-8", "replace")
print(json.dumps({"status": r.status, "body": parsed, "signed": signed}, ensure_ascii=False))
