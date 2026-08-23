"""错误三桶分类测试（2026-08-18 模块化）。

- classify_error：FEMTransientError → AGENT；其余（FEMConfigError/编译类/未知）→ FATAL
- handle_error：FATAL → emit flow_error；AGENT/TOLERANT 不 emit
- bridge check 命令：编译成功 ok / 失败带错误细节
"""
import json
import subprocess
import sys
import threading

import pytest

from femCompiler.FEM_errors import (
    ErrorCategory,
    FEMConfigError,
    FEMTransientError,
    classify_error,
)


class TestClassifyError:
    def test_transient_is_agent(self):
        assert classify_error(FEMTransientError("限流")) == ErrorCategory.AGENT

    def test_config_is_fatal(self):
        assert classify_error(FEMConfigError("无 key")) == ErrorCategory.FATAL

    def test_compile_error_is_fatal(self):
        assert classify_error(SyntaxError("bad syntax")) == ErrorCategory.FATAL
        assert classify_error(ValueError("变量未声明")) == ErrorCategory.FATAL

    def test_unknown_is_fatal(self):
        assert classify_error(RuntimeError("未知")) == ErrorCategory.FATAL


GOOD_FEMS = """meta:
  name = check-ok
  session = new
actors:
  ai @a = soul:the1stlittlesoul
action act @ai(@a):
  prompt: hi
mainflow:
  [START] -> act -> [END]
"""

BAD_FEMS = """meta:
  name = check-bad
  session = new
actors:
  ai @a = soul:the1stlittlesoul
action act @ai(@a):
  prompt: hi
mainflow:
  [START] -> par @a:
    -> act ->
  -> [END]
"""


def bridge_check(fems_text):
    """起 bridge 进程发 check 命令，返回 (ok, result_or_error)。"""
    import os
    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    p = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "python", "femwa_bridge.py"), "--fe4m", ROOT],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    response = {}
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
                if obj.get("type") == "response" and obj.get("id") == 1:
                    response["value"] = obj
                    stop.set()
        finally:
            stop.set()

    t = threading.Thread(target=drain, daemon=True)
    t.start()
    p.stdin.write(json.dumps({"id": 1, "cmd": "check", "args": {"fems": fems_text}}) + "\n")
    p.stdin.flush()
    stop.wait(20)
    p.stdin.write(json.dumps({"id": 2, "cmd": "shutdown", "args": {}}) + "\n")
    p.stdin.flush()
    import time
    time.sleep(0.3)
    p.stdin.close()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()
    return response.get("value", {})


class TestBridgeCheck:
    def test_check_ok(self):
        resp = bridge_check(GOOD_FEMS)
        assert resp.get("ok") is True
        assert resp.get("result", {}).get("actions") == 1

    def test_check_compile_error(self):
        resp = bridge_check(BAD_FEMS)
        assert resp.get("ok") is False
        err = resp.get("error", "")
        assert "语法错误" in err, f"错误应含细节: {err}"
