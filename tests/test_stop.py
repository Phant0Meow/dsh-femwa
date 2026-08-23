"""stop 修复回归测试：fork 分支协程里的节点在 stop 后必须真正停止。

修复前 stop 只取消 _main_task（asyncio cancel 不级联），fork 分支任务
注册在 engine._active_tasks 但没被取消——狼人杀场景表现为"停止失败、
狼人节点疯狂重复"。本测试：fork 分支进入 human_wait 后 stop，
断言 flow_stopped 且之后无新事件。
"""
import json
import subprocess
import sys
import threading
import time

import pytest

from conftest import ROOT, BRIDGE

STOP_FEMS = """meta:
  name = stop-probe
  session = new
actors:
  human @p = soul:human, source:0
action ask @human(@p):
  prompt: 请说话
mainflow:
  [START] -> fork:
    -> [H]:ask
"""


def run_and_stop(fems_text, wait_for="human_wait", settle=2.0):
    p = subprocess.Popen(
        [sys.executable, BRIDGE, "--fe4m", ROOT],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    events = []
    done = threading.Event()

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
            done.set()

    t = threading.Thread(target=drain, daemon=True)
    t.start()

    def send(obj):
        p.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        p.stdin.flush()

    send({"id": 1, "cmd": "run", "args": {"fems": fems_text, "base_dir": ROOT + r"\python"}})
    deadline = time.time() + 10
    while time.time() < deadline:
        if any(e["event"] == wait_for for e in events):
            break
        time.sleep(0.1)
    send({"id": 2, "cmd": "stop", "args": {}})
    time.sleep(settle)
    send({"id": 9, "cmd": "shutdown", "args": {}})
    time.sleep(0.3)
    p.stdin.close()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()
    return events


class TestStop:
    def test_stop_cancels_fork_branch(self):
        events = run_and_stop(STOP_FEMS)
        types = [e["event"] for e in events]
        assert "human_wait" in types, f"未进入 human_wait: {types}"
        assert "flow_stopped" in types, f"未收到 flow_stopped: {types}"
        # stop 之后不应再有业务事件（分支协程必须被取消）；
        # flow_done/bridge_run_ended 是主流程收尾，允许出现。
        idx = types.index("flow_stopped")
        tail = types[idx + 1:]
        business = [e for e in tail if e not in ("flow_done", "bridge_run_ended")]
        assert business == [], f"stop 后仍有业务事件（分支未停）: {business}"
