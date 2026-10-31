#!/usr/bin/env python3
"""tests/requester-bot.test.sh 用的假 webhook：只监听 127.0.0.1，随机端口。

  python3 -I requester-bot-fake-webhook.py <目录>

启动后把端口写进 <目录>/port。每收到一个请求往 <目录>/req.log 追一行 JSON：
  {"method", "path", "headers": {小写名: 值}, "body"}
怎么回由 <目录>/mode 决定（每个请求现读）：
  200 / 500 / 任意三位数 = 回这个状态码；hang = 30 秒不回（测超时）；
  302 = 跳转到 /followed（测「不跟随跳转」：跟了的话 req.log 会多一行）
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

D = sys.argv[1]
LOCK = threading.Lock()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def handle_any(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        rec = {"method": self.command, "path": self.path,
               "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}
        with LOCK, open(os.path.join(D, "req.log"), "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        try:
            mode = open(os.path.join(D, "mode")).read().strip() or "200"
        except OSError:
            mode = "200"
        if mode == "hang":
            time.sleep(30)
            mode = "200"
        code = int(mode) if mode.isdigit() else 200
        self.send_response(code)
        if code == 302:
            self.send_header("Location", "/followed")
        self.send_header("Content-Length", "2")
        self.end_headers()
        try:
            self.wfile.write(b"ok")
        except OSError:
            pass

    do_POST = do_GET = handle_any


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
srv.daemon_threads = True
with open(os.path.join(D, "port.tmp"), "w") as f:
    f.write(str(srv.server_address[1]))
os.replace(os.path.join(D, "port.tmp"), os.path.join(D, "port"))
srv.serve_forever()
