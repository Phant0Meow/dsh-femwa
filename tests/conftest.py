"""pytest 共享 fixture：dsh-femwa 引擎测试。

- conftest 注入仓库根到 sys.path（让 femCompiler 可 import）
- run_script fixture：起 bridge 进程跑剧本，返回事件列表
  （铁律：必须实时 drain stdout，64KB 管道写满会阻塞表现为"引擎卡死"）
"""
import os
import subprocess
import sys
import threading
import json

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

BRIDGE = os.path.join(ROOT, "python", "femwa_bridge.py")
PYTHON_DIR = os.path.join(ROOT, "python")


def run_script(fems_text, base_dir=PYTHON_DIR, timeout=30):
    """起一个 bridge 进程跑剧本，返回事件对象列表。"""
    p = subprocess.Popen(
        [sys.executable, BRIDGE, "--fe4m", ROOT],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    events = []
    stop = threading.Event()

    def drain():
        try:
            for line in p.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "event":
                    events.append(obj)
        finally:
            stop.set()

    t = threading.Thread(target=drain, daemon=True)
    t.start()

    def send(obj):
        p.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        p.stdin.flush()

    send({"id": 1, "cmd": "run", "args": {"fems": fems_text, "base_dir": base_dir}})
    deadline = __import__("time").time() + timeout
    while __import__("time").time() < deadline:
        if any(e["event"] in ("flow_done", "flow_error", "bridge_run_ended") for e in events):
            break
        __import__("time").sleep(0.1)
    send({"id": 2, "cmd": "shutdown", "args": {}})
    __import__("time").sleep(0.3)
    p.stdin.close()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()
    return events


def read_script(name):
    """读取 python/ 下的测试剧本。"""
    with open(os.path.join(PYTHON_DIR, name), encoding="utf-8") as f:
        return f.read()


@pytest.fixture
def run_events():
    """剧本文本 → 事件列表（每次测试独立进程，隔离干净）。"""
    return run_script


@pytest.fixture
def script_text():
    """python/ 下测试剧本读取器。"""
    return read_script
