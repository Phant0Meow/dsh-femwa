#!/usr/bin/env python3
"""剧本语法测试 runner：依次跑三个测试剧本，断言事件流与变量结果。

用法：python tests/run-script-tests.py
（零 LLM 调用——全部 @assign 逻辑，不烧 token）
"""
import subprocess
import sys
import json
import time
import os
import threading

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE = os.path.join(ROOT, "python", "femwa_bridge.py")

SCRIPTS = [
    ("test-if-fork-join.fems", "if 条件分支 + fork + join(all)"),
    ("test-for-if.fems", "for 顺序循环 + if"),
    ("test-par.fems", "par 并发循环"),
]

def run_script(fems_path):
    """跑一个剧本并收集事件。必须实时读取 stdout——桥的 stdout 是管道，
    引擎 print 洪流 + 事件会在 64KB 缓冲区写满后阻塞 write（不读就卡死）。"""
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
        p.stdin.write(json.dumps(obj) + "\n")
        p.stdin.flush()
    fems = open(fems_path, encoding="utf-8").read()
    send({"id": 1, "cmd": "run", "args": {"fems": fems, "base_dir": os.path.dirname(fems_path)}})
    # 轮询直到 flow_done / flow_error / bridge_run_ended，或超时
    deadline = time.time() + 30
    while time.time() < deadline:
        if any(e["event"] in ("flow_done", "flow_error", "bridge_run_ended") for e in events):
            break
        time.sleep(0.1)
    send({"id": 2, "cmd": "shutdown", "args": {}})
    time.sleep(0.5)
    p.stdin.close()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()
    return events

passed = 0
for fname, desc in SCRIPTS:
    path = os.path.join(ROOT, "python", fname)
    print(f"\n===== {fname} — {desc} =====")
    events = run_script(path)
    types = [e["event"] for e in events]
    print("事件序列:", " -> ".join(types))
    # 断言：必须 flow_done 且无 flow_error
    if "flow_error" in types:
        err = next((e["data"] for e in events if e["event"] == "flow_error"), {})
        print(f"❌ FAIL: flow_error: {err}")
        continue
    if "flow_done" not in types:
        print(f"❌ FAIL: 未见 flow_done（事件: {types}）")
        continue
    # 打印 assign_result 看变量
    for e in events:
        if e["event"] == "assign_result":
            print(f"  assign_result[{e['data'].get('node_name')}]: {e['data'].get('output')}")
    print(f"✅ PASS: flow_done")
    passed += 1

print(f"\n===== 结果: {passed}/{len(SCRIPTS)} 通过 =====")
sys.exit(0 if passed == len(SCRIPTS) else 1)
