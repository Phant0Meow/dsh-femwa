#!/usr/bin/env python3
"""复现 stop 命令的 maximum recursion depth exceeded。"""
import subprocess, sys, json, time, os, threading

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE = os.path.join(ROOT, "python", "femwa_bridge.py")

p = subprocess.Popen(
    [sys.executable, BRIDGE, "--fe4m", ROOT],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, encoding="utf-8", errors="replace", bufsize=1,
)
events = []
responses = []
errs = []
def drain():
    for line in p.stdout:
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "event":
            events.append(obj)
        elif obj.get("type") == "response":
            responses.append(obj)
def drain_err():
    for line in p.stderr:
        errs.append(line.rstrip())
t = threading.Thread(target=drain, daemon=True); t.start()
te = threading.Thread(target=drain_err, daemon=True); te.start()
def send(obj):
    p.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n"); p.stdin.flush()

script = open(os.path.join(ROOT, "python", "test-human.fems"), encoding="utf-8").read()
send({"id": 1, "cmd": "run", "args": {"fems": script, "base_dir": os.path.join(ROOT, "python")}})
deadline = time.time() + 15
while time.time() < deadline:
    if any(e["event"] == "human_wait" for e in events):
        break
    time.sleep(0.1)
print("human_wait 到达:", any(e["event"] == "human_wait" for e in events))

t0 = time.time()
send({"id": 2, "cmd": "stop", "args": {}})
while time.time() - t0 < 10:
    if any(r.get("id") == 2 for r in responses):
        break
    time.sleep(0.1)
stop_resp = next((r for r in responses if r.get("id") == 2), None)
print("stop 响应:", json.dumps(stop_resp, ensure_ascii=False)[:200] if stop_resp else "无（10s 超时）")
print("耗时: %.1fs" % (time.time() - t0))
print("stderr 尾部:")
for l in errs[-15:]:
    print("  |", l[:160])

send({"id": 3, "cmd": "shutdown", "args": {}})
time.sleep(0.3)
p.stdin.close()
try: p.wait(timeout=10)
except subprocess.TimeoutExpired: p.kill()
