"""sandboxd: the sandbox's exec service (ADR 0001).

The harness reaches the no-network sandbox only through this small HTTP API on an internal network:

  GET  /healthz                     -> {"ok": true, ...}
  POST /exec {command, cwd, timeout_s} -> NDJSON stream: {"data": <base64>} ... then {"exit": n} or {"exit": null, "timed_out": true}
  GET  /files?path=/abs              -> file bytes
  PUT  /files?path=/abs  (body)      -> 204 (parents created)
  GET  /access?path=/abs&mode=r|rw   -> 204 / 404 / 403
  POST /reset                        -> 204 (empties the work dir)

Commands run under a fixed minimal environment built here, never the caller's or this process's.
Standard library only.
"""

import argparse
import base64
import errno
import json
import os
import select
import socket
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MAX_TIMEOUT_S = 120
# Per-command process/thread cap (RLIMIT_NPROC, per uid), kept below the container's pids limit (128)
# so a fork bomb can't starve sandboxd of the threads it needs to report and kill it.
MAX_PROCS = 96
MAX_BODY = 32 * 1024 * 1024
WORK = "/work"


def command_env():
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": WORK,
        "TMPDIR": os.path.join(WORK, ".tmp"),
        "MPLCONFIGDIR": os.path.join(WORK, ".tmp"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "LANG": "C.UTF-8",
    }


def status_for(exc):
    if isinstance(exc, FileNotFoundError):
        return 404
    if isinstance(exc, (IsADirectoryError, NotADirectoryError)):
        return 400
    if isinstance(exc, PermissionError) or getattr(exc, "errno", None) in (errno.EROFS, errno.EACCES, errno.EPERM):
        return 403
    return 500


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "sandboxd/0.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("sandboxd %s %s\n" % (self.command, self.path.split("?")[0]))

    def reply(self, code, body=b"", ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        if code != 204:
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(body)))
        self.end_headers()
        if code != 204:
            self.wfile.write(body)

    def error(self, code, message):
        self.reply(code, {"error": message})

    def query_path(self):
        q = parse_qs(urlparse(self.path).query)
        p = (q.get("path") or [""])[0]
        if not os.path.isabs(p):
            self.error(400, "path must be absolute")
            return None, q
        return os.path.normpath(p), q

    def body(self):
        n = int(self.headers.get("content-length") or 0)
        if n > MAX_BODY:
            raise ValueError("body too large")
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        route = urlparse(self.path).path
        if route == "/healthz":
            return self.reply(200, {"ok": True, "python": sys.version.split()[0], "work": WORK})
        if route == "/files":
            path, _ = self.query_path()
            if path is None:
                return
            try:
                with open(path, "rb") as f:
                    data = f.read()
            except OSError as e:
                return self.error(status_for(e), str(e))
            return self.reply(200, data, "application/octet-stream")
        if route == "/access":
            path, q = self.query_path()
            if path is None:
                return
            mode = os.R_OK | (os.W_OK if (q.get("mode") or ["r"])[0] == "rw" else 0)
            if not os.path.exists(path):
                return self.error(404, f"{path} does not exist")
            if not os.access(path, mode):
                return self.error(403, f"{path} is not accessible for {'read/write' if mode & os.W_OK else 'read'}")
            return self.reply(204)
        self.error(404, "no such route")

    def do_PUT(self):
        if urlparse(self.path).path != "/files":
            return self.error(404, "no such route")
        path, _ = self.query_path()
        if path is None:
            return
        try:
            data = self.body()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)
        except ValueError as e:
            return self.error(413, str(e))
        except OSError as e:
            return self.error(status_for(e), str(e))
        self.reply(204)

    def do_POST(self):
        route = urlparse(self.path).path
        if route == "/reset":
            for name in os.listdir(WORK):
                p = os.path.join(WORK, name)
                shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) and not os.path.islink(p) else os.unlink(p)
            return self.reply(204)
        if route != "/exec":
            return self.error(404, "no such route")
        try:
            req = json.loads(self.body() or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self.error(400, "invalid JSON")
        command = req.get("command")
        if not isinstance(command, str) or not command:
            return self.error(400, "command is required")
        cwd = req.get("cwd") or WORK
        timeout = min(float(req.get("timeout_s") or MAX_TIMEOUT_S), MAX_TIMEOUT_S)
        if not os.path.isdir(cwd):
            return self.error(400, f"cwd {cwd} is not a directory")
        os.makedirs(command_env()["TMPDIR"], exist_ok=True)
        self.exec_stream(command, cwd, timeout)

    def exec_stream(self, command, cwd, timeout):
        # Start every helper thread before the command runs: once it forks, threads may be unavailable.
        state = {"proc": None}
        timed_out = threading.Event()
        done = threading.Event()

        def kill_group():
            proc = state["proc"]
            if proc is None:
                return
            # Repeat: a fork racing the first SIGKILL can leave survivors (e.g. a fork bomb).
            for _ in range(50):
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    return  # group gone (macOS reports EPERM for a reaped group)
                time.sleep(0.02)

        def on_timeout():
            timed_out.set()
            kill_group()

        def watch_client():
            # A silent command never writes, so detect the caller hanging up (abort) by watching the socket.
            sock = self.connection
            while not done.wait(0.2):
                try:
                    readable, _, _ = select.select([sock], [], [], 0)
                    if readable and sock.recv(1, socket.MSG_PEEK) == b"":
                        kill_group()
                        return
                except OSError:
                    kill_group()
                    return

        timer = threading.Timer(timeout, on_timeout)
        timer.start()
        threading.Thread(target=watch_client, daemon=True).start()
        proc = subprocess.Popen(
            ["/bin/bash", "-c", f"ulimit -u {MAX_PROCS}\n{command}" if MAX_PROCS else command],
            cwd=cwd,
            env=command_env(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        state["proc"] = proc
        self.send_response(200)
        self.send_header("content-type", "application/x-ndjson")
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()

        def chunk(obj):
            line = (json.dumps(obj) + "\n").encode()
            self.wfile.write(b"%x\r\n%s\r\n" % (len(line), line))
            self.wfile.flush()

        try:
            fd = proc.stdout.fileno()
            while True:
                data = os.read(fd, 65536)
                if not data:
                    break
                chunk({"data": base64.b64encode(data).decode()})
            code = proc.wait()
            # Reap anything left in the group (backgrounded children) once the shell exits.
            kill_group()
            if timed_out.is_set():
                chunk({"exit": None, "timed_out": True})
            else:
                chunk({"exit": code if code >= 0 else 128 - code})
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            kill_group()  # the caller went away (e.g. the user aborted): stop the command
        finally:
            done.set()
            timer.cancel()
            proc.stdout.close()
            if proc.poll() is None:
                kill_group()
                proc.wait()


def main():
    global WORK, MAX_PROCS
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--work", default="/work")
    ap.add_argument("--max-procs", type=int, default=MAX_PROCS, help="RLIMIT_NPROC for commands; 0 disables (it is per uid, host-wide)")
    args = ap.parse_args()
    WORK = os.path.abspath(args.work)
    MAX_PROCS = args.max_procs
    os.makedirs(WORK, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    sys.stderr.write(f"sandboxd listening on {args.host}:{args.port}, work={WORK}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
