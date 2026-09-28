"""Unit tests for sandboxd's HTTP protocol, run on the host against a temp work dir."""

import base64
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

SANDBOXD = Path(__file__).resolve().parents[1] / "sandboxd.py"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def sandboxd(tmp_path):
    port = free_port()
    work = tmp_path / "work"
    work.mkdir()
    env = {**os.environ, "ANTHROPIC_API_KEY": "sk-ant-should-never-leak"}
    proc = subprocess.Popen(
        [sys.executable, str(SANDBOXD), "--host", "127.0.0.1", "--port", str(port), "--work", str(work), "--max-procs", "0"],
        env=env,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            urllib.request.urlopen(base + "/healthz", timeout=0.2)
            break
        except OSError:
            time.sleep(0.05)
    yield base, work
    proc.kill()
    proc.wait()


def call(base, method, path, body=None, headers=None):
    data = json.dumps(body).encode() if isinstance(body, dict) else body
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def run(base, command, **kw):
    status, raw = call(base, "POST", "/exec", {"command": command, **kw}, {"content-type": "application/json"})
    assert status == 200, raw
    out, end = b"", None
    for line in raw.decode().splitlines():
        msg = json.loads(line)
        if "data" in msg:
            out += base64.b64decode(msg["data"])
        else:
            end = msg
    return out.decode(), end


def test_healthz(sandboxd):
    base, _ = sandboxd
    status, raw = call(base, "GET", "/healthz")
    assert status == 200
    assert json.loads(raw)["ok"] is True


def test_exec_streams_output_and_exit_code(sandboxd):
    base, work = sandboxd
    out, end = run(base, "echo hi; echo err >&2; pwd; exit 3")
    assert "hi\n" in out and "err\n" in out
    assert str(work) in out
    assert end == {"exit": 3}


def test_exec_uses_a_fixed_minimal_env_never_the_parent_one(sandboxd):
    base, work = sandboxd
    out, _ = run(base, "env | sort")
    names = {line.split("=", 1)[0] for line in out.splitlines() if "=" in line}
    assert "ANTHROPIC_API_KEY" not in names
    assert "sk-ant" not in out
    assert {"PATH", "HOME", "PYTHONDONTWRITEBYTECODE", "TMPDIR"} <= names
    assert f"HOME={work}" in out


def test_exec_timeout_kills_the_process_group(sandboxd):
    base, _ = sandboxd
    t0 = time.time()
    out, end = run(base, "sleep 30 & sleep 30; echo never", timeout_s=1)
    assert time.time() - t0 < 5
    assert end["timed_out"] is True
    assert "never" not in out


def test_exec_rejects_missing_command(sandboxd):
    base, _ = sandboxd
    status, _ = call(base, "POST", "/exec", {"cwd": "/"}, {"content-type": "application/json"})
    assert status == 400


def test_files_roundtrip_and_errors(sandboxd):
    base, work = sandboxd
    p = f"{work}/sub/dir/a.txt"
    assert call(base, "PUT", f"/files?path={p}", b"hello\n")[0] == 204
    assert call(base, "GET", f"/files?path={p}") == (200, b"hello\n")
    assert call(base, "GET", f"/access?path={p}&mode=rw")[0] == 204
    assert call(base, "GET", f"/files?path={work}/missing")[0] == 404
    assert call(base, "GET", f"/access?path={work}/missing&mode=r")[0] == 404
    assert call(base, "GET", "/files?path=relative.txt")[0] == 400
    assert call(base, "GET", f"/files?path={work}")[0] == 400


def test_reset_clears_work(sandboxd):
    base, work = sandboxd
    (work / "x.txt").write_text("x")
    (work / "d").mkdir()
    assert call(base, "POST", "/reset")[0] == 204
    assert list(work.iterdir()) == []
