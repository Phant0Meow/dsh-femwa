#!/usr/bin/env python3
"""复现 stop 在嵌套 fork 循环运行中的 maximum recursion depth exceeded（零 token）。"""
import subprocess, sys, json, time, os, threading

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE = os.path.join(ROOT, "python", "femwa_bridge.py")

script = """meta:
  session = new
vars:
  count = 0
module M:
  action up @assign:
    out: count += 1
  flow:
    [IN] -> [UP]:up -> fork:
      -> if (count < 100000) -> [IN]
      -> if (count >= 100000) -> [OUT]
mainflow:
  [START] -> [M]:&M -> [END]
"""

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

send({"id": 1, "cmd": "run", "args": {"fems": script, "base_dir": os.path.join(ROOT, "python")}})
time.sleep(3)  # 让循环跑起来
print("运行中事件数:", len([e for e in events if e["event"] == "assign_result"]))

t0 = time.time()
send({"id": 2, "cmd": "stop", "args": {}})
while time.time() - t0 < 15:
    if any(r.get("id") == 2 for r in responses):
        break
    time.sleep(0.1)
stop_resp = next((r for r in responses if r.get("id") == 2), None)
print("stop 响应:", json.dumps(stop_resp, ensure_ascii=False)[:200] if stop_resp else "无（15s 超时）")
print("耗时: %.1fs" % (time.time() - t0))
print("stderr 尾部:")
for l in errs[-20:]:
    print("  |", l[:200])

send({"id": 3, "cmd": "shutdown", "args": {}})
time.sleep(0.3)
p.stdin.close()
try: p.wait(timeout=10)
except subprocess.TimeoutExpired: p.kill()
