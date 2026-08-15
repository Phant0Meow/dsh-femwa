#!/usr/bin/env python3
"""跑 goblin-mini.fems（零 token 全结构复刻），观察 fork/for/module 行为。"""
import subprocess, sys, json, time, os, threading

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE = os.path.join(ROOT, "python", "femwa_bridge.py")
FEMS = os.path.join(ROOT, "python", "goblin-mini.fems")

p = subprocess.Popen(
    [sys.executable, BRIDGE, "--fe4m", ROOT],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, encoding="utf-8", errors="replace", bufsize=1,
)
events = []
err_lines = []
done = threading.Event()
def drain_err():
    try:
        for line in p.stderr:
            err_lines.append(line.rstrip("\n"))
    finally:
        pass
te = threading.Thread(target=drain_err, daemon=True); te.start()
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

fems = open(FEMS, encoding="utf-8").read()
send({"id": 1, "cmd": "run", "args": {"fems": fems, "base_dir": os.path.dirname(FEMS)}})
deadline = time.time() + 20
while time.time() < deadline:
    if any(e["event"] in ("flow_done", "flow_error", "bridge_run_ended") for e in events):
        break
    time.sleep(0.1)

types = [e["event"] for e in events]
print("事件序列:", " -> ".join(types))
print("\n=== stderr（含异常堆栈）===")
for l in err_lines:
    print("  |", l)
print("\n=== 关键事件 ===")
for e in events:
    ev = e["event"]
    if ev in ("flow_error", "node_start", "assign_result", "checkpoint"):
        print(f"  [{ev}] {json.dumps(e.get('data', {}), ensure_ascii=False)[:250]}")

send({"id": 2, "cmd": "shutdown", "args": {}})
time.sleep(0.3); p.stdin.close()
try: p.wait(timeout=10)
except subprocess.TimeoutExpired: p.kill()
