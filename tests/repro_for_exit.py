#!/usr/bin/env python3
"""跑 for-exit-verify.fems，检查 for 循环出口边不再吞掉循环后的首个动作节点（零 LLM）。

背景 bug（2026-08-25 修复）：_run_for_loop 在网关只有无条件出边时把全部出边
当成循环体入口，exit_edge=None，循环结束后「顺藤摸瓜」直接跳到出口节点的
下一个节点——夹在 for 与后续节点之间的动作节点（如 [judge]:评审、[final]:定稿）
被静默跳过不执行。
"""
import subprocess, sys, json, time, os, threading

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE = os.path.join(ROOT, "python", "femwa_bridge.py")

def run_script(fname):
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
                if not line: continue
                try: obj = json.loads(line)
                except json.JSONDecodeError: continue
                if obj.get("type") == "event": events.append(obj)
        finally:
            done.set()
    t = threading.Thread(target=drain, daemon=True); t.start()
    def send(obj):
        p.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n"); p.stdin.flush()
    fems = open(os.path.join(ROOT, "python", fname), encoding="utf-8").read()
    send({"id": 1, "cmd": "run", "args": {"fems": fems, "base_dir": os.path.join(ROOT, "python")}})
    deadline = time.time() + 30
    while time.time() < deadline:
        if any(e["event"] in ("flow_done", "flow_error", "bridge_run_ended") for e in events):
            break
        time.sleep(0.1)
    send({"id": 2, "cmd": "shutdown", "args": {}})
    time.sleep(0.3); p.stdin.close()
    try: p.wait(timeout=10)
    except subprocess.TimeoutExpired: p.kill()
    return events

events = run_script("for-exit-verify.fems")
seq = []
good_hits = None
for e in events:
    if e["event"] == "assign_result":
        d = e.get("data", {})
        seq.append(d.get("node_name") or "?")
        out = d.get("output") or {}
        if "good_hits" in out:
            good_hits = out["good_hits"]

print("assign 序列:", " -> ".join(seq))
# 只有 @assign 动作产生事件；10 个动作 = 开场1 + 构思2 + 提案2 + 评审1 + 颁奖1 + 感言2 + 定稿1
ok = good_hits == 1 and len(seq) == 10 and seq.count("[judge]") == 1 and seq.count("[final]") == 1
if ok:
    print(f"✅ PASS：循环后动作节点全部执行（评审 good_hits={good_hits}，含定稿）")
else:
    print(f"❌ FAIL：good_hits={good_hits}，序列长度={len(seq)}（应为 10）")
    sys.exit(1)
