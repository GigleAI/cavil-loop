#!/usr/bin/env python3
"""测试里站在远程入口前面的「Tailscale 转发层」替身（GitHub#387），只给测试用。

真的 `tailscale serve` 做三件事：在机器名上终结 HTTPS（证书是发给这个名字的）、把请求转给本机回环端口、
并用自己查到的来访地址覆盖掉请求里带的 X-Forwarded-For / Tailscale-* 头。这里照做：

    front.py --listen PORT --cert CERT.pem --key KEY.pem --backend PORT --caller-file FILE --log FILE
    front.py --listen PORT --cert ... --key ... --impostor --log FILE

  --caller-file  文件内容就是「转发层查到的来访地址」（每个请求现读，测试可以中途换设备）
  --impostor     不转发：冒名顶替的另一台机器（有合法证书、没有钥匙），对任何请求都回一段没有签名的 200
  --log          每个到达的请求记一行 JSON：{method, path, headers, body}——断言「对面收到了什么」用

启动后往 stdout 打一行 `listening <端口>`。
"""
import argparse, http.client, json, ssl, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--listen", type=int, default=0)
ap.add_argument("--cert", required=True)
ap.add_argument("--key", required=True)
ap.add_argument("--backend", type=int, default=0)
ap.add_argument("--caller-file", default="")
ap.add_argument("--impostor", action="store_true")
ap.add_argument("--log", required=True)
a = ap.parse_args()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def handle_any(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        with open(a.log, "a", encoding="utf-8") as f:
            f.write(json.dumps({"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body.decode("utf-8", "replace")}, ensure_ascii=False) + "\n")
        if a.impostor:
            out = json.dumps({"status": {"version": 1, "os": "Linux", "scheduler": "systemd", "projects": [], "daemon": {"entry": "/x", "target": None, "form": "checkout", "version": "f" * 40}, "gh": {"installed": True, "logged_in": True}, "base_deps": {"missing": []}}, "result": "revoked"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        headers = {k: v for k, v in self.headers.items() if k.lower() != "x-forwarded-for" and not k.lower().startswith("tailscale-") and k.lower() not in ("host", "connection")}
        try:
            caller = open(a.caller_file, encoding="utf-8").read().strip()
        except OSError:
            caller = ""
        if caller:
            headers["X-Forwarded-For"] = caller
        conn = http.client.HTTPConnection("127.0.0.1", a.backend, timeout=200)
        conn.request(self.command, self.path, body=body or None, headers=headers)
        r = conn.getresponse()
        out = r.read()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() in ("content-type", "x-cavil-signature", "cache-control"):
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = handle_any
    do_POST = handle_any


httpd = ThreadingHTTPServer(("127.0.0.1", a.listen), H)
httpd.daemon_threads = True
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(a.cert, a.key)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
print("listening %d" % httpd.server_address[1], flush=True)
httpd.serve_forever()
