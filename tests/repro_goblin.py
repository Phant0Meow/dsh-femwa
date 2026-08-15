#!/usr/bin/env python3
"""复现 goblin-demo.fems 的 accept_quest human 节点输入问题。

模拟前端赋值框：收到 human_wait 后发 human_input（chat_text + variables），
观察 player_choice 赋值、fork 分支走向与最终事件流。
"""
import subprocess, sys, json, time, os, threading

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE = os.path.join(ROOT, "python", "femwa_bridge.py")
FEMS = os.path.join(ROOT, "python", "goblin-demo.fems")

p = subprocess.Popen(
    [sys.executable, BRIDGE, "--fe4m", ROOT],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, encoding="utf-8", errors="replace", bufsize=1,
)
events = []
waits = []
done = threading.Event()

def drain():
    try:
        for line in p.stdout:
            line = line.strip()
            if not line: continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "event":
                events.append(obj)
                if obj["event"] == "human_wait":
                    waits.append(obj["data"])
    finally:
        done.set()

t = threading.Thread(target=drain, daemon=True)
t.start()

def send(obj):
    p.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
    p.stdin.flush()

fems = open(FEMS, encoding="utf-8").read()
print(f"=== 发送 run（剧本 {len(fems)} 字符）===")
send({"id": 1, "cmd": "run", "args": {"fems": fems, "base_dir": os.path.dirname(FEMS)}})

# 等第一次 human_wait（最多 15s）
deadline = time.time() + 15
while time.time() < deadline and not waits:
    if any(e["event"] in ("flow_error", "bridge_run_ended", "flow_done") for e in events):
        break
    time.sleep(0.1)

if not waits:
    types = [e["event"] for e in events]
    print("!! 未见 human_wait")
    print("事件序列:", " -> ".join(types))
    for e in events:
        if e["event"] in ("flow_error", "bridge_run_ended", "flow_start", "node_enter"):
            print(" ", json.dumps(e, ensure_ascii=False)[:400])
    send({"id": 2, "cmd": "shutdown", "args": {}})
    time.sleep(0.3); p.stdin.close()
    try: p.wait(timeout=10)
    except subprocess.TimeoutExpired: p.kill()
    sys.exit(1)

w = waits[0]
print(f"=== human_wait: node={w.get('node_name')} wait_key={w.get('wait_key')}")
print(f"    out_vars={w.get('out_vars')}")
print(f"    prompt={w.get('prompt')!r}")

# 模拟前端赋值框提交
body = {"chat_text": "接受", "variables": {"player_choice": "接受"}}
print(f"=== 发送 human_input: {body}")
send({"id": 3, "cmd": "human_input", "args": {"wait_key": w["wait_key"], "body": body}})

# 继续收事件直到终止
deadline = time.time() + 30
while time.time() < deadline:
    if any(e["event"] in ("flow_done", "flow_error", "bridge_run_ended") for e in events):
        break
    time.sleep(0.1)

types = [e["event"] for e in events]
print("=== 事件序列 ===")
print(" -> ".join(types))
print("\n=== 关键事件详情 ===")
for e in events:
    ev = e["event"]
    if ev in ("flow_error", "bridge_run_ended", "human_done", "assign_result", "node_enter", "branch_taken"):
        print(f"[{ev}] {json.dumps(e.get('data', {}), ensure_ascii=False)[:300]}")

send({"id": 2, "cmd": "shutdown", "args": {}})
time.sleep(0.3)
p.stdin.close()
try: p.wait(timeout=10)
except subprocess.TimeoutExpired: p.kill()
